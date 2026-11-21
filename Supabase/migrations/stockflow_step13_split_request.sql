-- =====================================================================
-- Stockflow · Step 13 · Phase B · Approve a request split by supplier
--
-- A seller request = PENDING order without supplier (existing flow).
-- On review the admin assigns a supplier (and quantity / unit cost) per
-- line, optionally splitting one line across suppliers (60 / 40).
--
-- approve_request() then, in ONE transaction:
--   * keeps the original order for the main supplier
--   * creates one new order per other supplier (same location, same
--     requester, split_from_order_id -> original)
--   * moves / splits the lines, freezes unit cost
--   * adds missing supplier/product pairs to the supplier catalog
--   * approves every resulting order (numbers + document snapshots
--     through the existing guard_order trigger)
--
-- Existing "New order" and single-supplier approval keep working.
-- Run as ONE script in the Supabase SQL editor.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Link from a split order back to the request it came from
-- ---------------------------------------------------------------------
alter table public.orders
  add column if not exists split_from_order_id uuid references public.orders(id);

create index if not exists orders_split_from_idx
  on public.orders (split_from_order_id) where split_from_order_id is not null;

-- ---------------------------------------------------------------------
-- 2. guard_order: keep the requester as author on split orders
--    (only when the server sets stockflow.keep_created_by; a client
--     can not set this flag)
-- ---------------------------------------------------------------------
create temp table _fn_attrs on commit drop as
select p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig
from pg_proc p
where p.oid = 'public.guard_order()'::regprocedure;

create or replace function public.guard_order()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_supplier public.suppliers%rowtype;
  v_company public.company_profile%rowtype;
  v_object public.objects%rowtype;
  v_profile public.profiles%rowtype;
begin
  if tg_op = 'INSERT' then
    perform public.assert_object_access(new.object_id);
    new.status := 'PENDING';
    if auth.uid() is not null
       and coalesce(current_setting('stockflow.keep_created_by', true), 'off') <> 'on' then
      new.created_by := auth.uid();
    end if;
    if new.order_number is null then
      new.order_number := public.next_order_number(coalesce(new.created_at, now()));
    end if;
    return new;
  end if;

  -- UPDATE
  perform public.assert_object_access(old.object_id);

  if new.object_id is distinct from old.object_id
  or new.created_by is distinct from old.created_by
  or new.created_at is distinct from old.created_at
  or new.order_number is distinct from old.order_number then
    raise exception using errcode = '42501',
      message = 'Order store, author, creation time and order number cannot be changed.';
  end if;

  if old.status <> 'PENDING' and new.supplier_id is distinct from old.supplier_id then
    raise exception 'Supplier can only be changed while the order is PENDING.';
  end if;

  if old.company_snapshot is not null and new.company_snapshot is distinct from old.company_snapshot
  or old.supplier_snapshot is not null and new.supplier_snapshot is distinct from old.supplier_snapshot
  or old.delivery_snapshot is not null and new.delivery_snapshot is distinct from old.delivery_snapshot
  or old.prepared_by_snapshot is not null and new.prepared_by_snapshot is distinct from old.prepared_by_snapshot
  or old.approved_at is not null and new.approved_at is distinct from old.approved_at
  or old.approved_by is not null and new.approved_by is distinct from old.approved_by then
    raise exception 'Approved order document data cannot be changed.';
  end if;

  if new.status is distinct from old.status then
    if old.status = 'DELIVERED' then
      raise exception 'A delivered order cannot change status.';
    end if;

    if new.status = 'DELIVERED' then
      if public.is_direct_api_call() then
        raise exception using errcode = '42501',
          message = 'Use Record delivery to mark an order as delivered.';
      end if;
      if old.status <> 'APPROVED' then
        raise exception 'Only an APPROVED order can be delivered.';
      end if;

    elsif not (
         (old.status = 'PENDING'  and new.status in ('APPROVED', 'REJECTED'))
      or (old.status = 'APPROVED' and new.status = 'PENDING')
      or (old.status = 'REJECTED' and new.status = 'PENDING')
    ) then
      raise exception 'Invalid status change: % -> %.', old.status, new.status;
    end if;

    if public.is_direct_api_call()
       and not (public.is_admin() or public.is_demo()) then
      raise exception using errcode = '42501',
        message = 'Only an admin can change order status.';
    end if;

    if old.status = 'PENDING' and new.status = 'APPROVED' and old.approved_at is null then
      if new.supplier_id is null then
        raise exception 'Select a supplier before approving the order.';
      end if;

      select * into v_supplier from public.suppliers where id = new.supplier_id;
      if v_supplier.id is null then
        raise exception 'Supplier not found.';
      end if;
      if not v_supplier.active then
        raise exception 'Inactive supplier cannot be used for a new purchase order.';
      end if;

      select * into v_company from public.company_profile where singleton = true;
      if v_company.id is null then
        raise exception 'Complete Settings > Company profile before approving purchase orders.';
      end if;

      select * into v_object from public.objects where id = new.object_id;
      select * into v_profile from public.profiles where id = new.created_by;

      new.approved_at := now();
      new.approved_by := auth.uid();
      new.company_snapshot := jsonb_build_object(
        'name', v_company.name, 'address', v_company.address, 'city', v_company.city,
        'postal_code', v_company.postal_code, 'country', v_company.country,
        'tax_id', v_company.tax_id, 'registration_number', v_company.registration_number,
        'email', v_company.email, 'phone', v_company.phone
      );
      new.supplier_snapshot := jsonb_build_object(
        'id', v_supplier.id, 'name', v_supplier.name, 'address', v_supplier.address,
        'city', v_supplier.city, 'postal_code', v_supplier.postal_code,
        'country', v_supplier.country, 'tax_id', v_supplier.tax_id,
        'registration_number', v_supplier.registration_number,
        'order_email', v_supplier.order_email, 'phone', v_supplier.phone,
        'contact_name', v_supplier.contact_name
      );
      new.delivery_snapshot := jsonb_build_object(
        'id', v_object.id, 'name', v_object.name, 'address', v_object.address, 'city', v_object.city
      );
      new.prepared_by_snapshot := jsonb_build_object(
        'id', v_profile.id, 'full_name', v_profile.full_name, 'email', v_profile.email
      );
    end if;
  end if;

  return new;
end;
$function$;

do $$
declare r record; c text;
begin
  for r in select * from _fn_attrs loop
    execute format('alter function %s %s', r.sig,
                   case when r.prosecdef then 'security definer' else 'security invoker' end);
    if r.proconfig is not null then
      foreach c in array r.proconfig loop
        execute format('alter function %s set %s = %s', r.sig,
                       split_part(c, '=', 1), substr(c, strpos(c, '=') + 1));
      end loop;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. approve_request
--    p_lines: [{ order_item_id, supplier_id, quantity, unit_cost? }, …]
--    One request line may appear several times (split across suppliers).
--    A request line that is left out is dropped from the purchase.
-- ---------------------------------------------------------------------
create or replace function public.approve_request(p_order_id uuid, p_lines jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_order  record;
  v_main   uuid;
  v_new    uuid;
  v_ids    uuid[] := '{}';
  v_bad    text;
  r        record;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not is_admin() then
    raise exception 'Only admins can approve requests' using errcode = '42501';
  end if;
  if is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Assign at least one line to a supplier.' using errcode = '22023';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  if v_order.status <> 'PENDING' then
    raise exception 'Only a PENDING request can be approved (current: %).', v_order.status
      using errcode = '22023';
  end if;

  drop table if exists pg_temp._alloc;
  create temp table _alloc on commit drop as
  select nullif(x->>'order_item_id', '')::uuid as order_item_id,
         nullif(x->>'supplier_id', '')::uuid   as supplier_id,
         nullif(x->>'quantity', '')::int       as quantity,
         nullif(x->>'unit_cost', '')::numeric  as unit_cost
  from jsonb_array_elements(p_lines) x;

  if exists (select 1 from _alloc where order_item_id is null or supplier_id is null) then
    raise exception 'Every line needs a supplier.' using errcode = '22023';
  end if;
  if exists (select 1 from _alloc where quantity is null or quantity <= 0) then
    raise exception 'Quantities must be positive whole numbers.' using errcode = '22023';
  end if;
  if exists (select 1 from _alloc where unit_cost < 0) then
    raise exception 'Unit cost cannot be negative.' using errcode = '22023';
  end if;
  if exists (select 1 from _alloc a
             where not exists (select 1 from order_items oi
                               where oi.id = a.order_item_id and oi.order_id = p_order_id)) then
    raise exception 'A line does not belong to this request.' using errcode = '22023';
  end if;

  select string_agg(distinct coalesce(s.name, a.supplier_id::text), ', ') into v_bad
  from _alloc a left join suppliers s on s.id = a.supplier_id
  where s.id is null or not s.active;
  if v_bad is not null then
    raise exception 'Supplier is inactive or missing: %.', v_bad using errcode = '22023';
  end if;

  -- One row per request line + supplier
  drop table if exists pg_temp._grp;
  create temp table _grp on commit drop as
  select a.order_item_id, oi.product_id, oi.requested_qty, a.supplier_id,
         sum(a.quantity)::int as quantity,
         max(a.unit_cost)     as unit_cost,
         count(*) over (partition by a.order_item_id) as parts
  from _alloc a
  join order_items oi on oi.id = a.order_item_id
  group by a.order_item_id, oi.product_id, oi.requested_qty, a.supplier_id;

  update _grp g set parts = x.n
  from (select order_item_id, count(*) n from _grp group by 1) x
  where x.order_item_id = g.order_item_id;

  -- Catalog learns from decisions
  insert into supplier_products (supplier_id, product_id, active, created_by, updated_by)
  select distinct g.supplier_id, g.product_id, true, auth.uid(), auth.uid()
  from _grp g
  on conflict (supplier_id, product_id) do update
    set active = true, updated_by = auth.uid()
    where supplier_products.active = false;

  -- Main supplier keeps the original order number
  select case
           when v_order.supplier_id is not null
                and exists (select 1 from _grp where supplier_id = v_order.supplier_id)
             then v_order.supplier_id
           else (select supplier_id from _grp
                 group by supplier_id order by sum(quantity) desc, supplier_id limit 1)
         end
    into v_main;

  -- New orders for the other suppliers (author stays the requester)
  perform set_config('stockflow.keep_created_by', 'on', true);

  for r in select distinct supplier_id from _grp where supplier_id <> v_main order by 1 loop
    insert into orders (object_id, comment, created_by, supplier_id, split_from_order_id)
    values (v_order.object_id, v_order.comment, v_order.created_by, r.supplier_id, p_order_id)
    returning id into v_new;

    insert into order_items (order_id, product_id, quantity, unit_cost, requested_qty)
    select v_new, g.product_id, g.quantity, g.unit_cost,
           case when g.parts = 1 then g.requested_qty end
    from _grp g
    where g.supplier_id = r.supplier_id;

    v_ids := v_ids || v_new;
  end loop;

  perform set_config('stockflow.keep_created_by', 'off', true);

  -- Original order: keep only the main supplier's lines
  update order_items oi
  set quantity  = g.quantity,
      unit_cost = coalesce(g.unit_cost, oi.unit_cost)
  from _grp g
  where g.order_item_id = oi.id and g.supplier_id = v_main;

  delete from order_items oi
  where oi.order_id = p_order_id
    and not exists (select 1 from _grp g
                    where g.order_item_id = oi.id and g.supplier_id = v_main);

  update orders set supplier_id = v_main where id = p_order_id;

  -- Approve all (numbers + snapshots via guard_order)
  update orders set status = 'APPROVED'
  where id = any (array[p_order_id] || v_ids);

  select jsonb_build_object(
    'request_id', p_order_id,
    'split', cardinality(v_ids) > 0,
    'orders', jsonb_agg(jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'supplier_id', o.supplier_id,
      'supplier_name', s.name,
      'lines', (select count(*) from order_items oi where oi.order_id = o.id),
      'units', (select coalesce(sum(quantity), 0) from order_items oi where oi.order_id = o.id),
      'value', (select round(coalesce(sum(quantity * unit_cost), 0), 2) from order_items oi where oi.order_id = o.id)
    ) order by (o.id <> p_order_id), s.name)
  ) into v_result
  from orders o
  join suppliers s on s.id = o.supplier_id
  where o.id = any (array[p_order_id] || v_ids);

  return v_result;
end;
$$;

revoke all on function public.approve_request(uuid, jsonb) from public, anon;
grant execute on function public.approve_request(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Suggestion for the review screen: preferred supplier, catalog
--    terms and rounded quantity per request line
-- ---------------------------------------------------------------------
create or replace function public.request_supplier_suggestions(p_order_id uuid)
returns table (
  order_item_id     uuid,
  product_id        uuid,
  sku               text,
  product_name      text,
  requested_qty     int,
  quantity          int,
  supplier_id       uuid,
  supplier_name     text,
  pack_size         int,
  minimum_packs     int,
  suggested_qty     int,
  last_unit_cost    numeric,
  current_cost      numeric,
  suppliers_count   int
)
language sql stable security definer set search_path = public
as $$
  select oi.id, oi.product_id, p.sku, p.name,
         coalesce(oi.requested_qty, oi.quantity), oi.quantity,
         sp.supplier_id, s.name,
         sp.pack_size, sp.minimum_packs,
         case when sp.supplier_id is not null
              then supplier_order_qty(oi.quantity, sp.pack_size, sp.minimum_packs)
              else oi.quantity end,
         lp.unit_cost,
         p.cost_price,
         (select count(*)::int from supplier_products x
          join suppliers xs on xs.id = x.supplier_id
          where x.product_id = oi.product_id and x.active and xs.active)
  from order_items oi
  join products p on p.id = oi.product_id
  left join supplier_products sp
    on sp.product_id = oi.product_id and sp.preferred and sp.active
  left join suppliers s on s.id = sp.supplier_id and s.active
  left join lateral (
    select i.unit_cost
    from orders o join order_items i on i.order_id = o.id
    where o.supplier_id = sp.supplier_id and i.product_id = oi.product_id
      and o.status in ('APPROVED', 'DELIVERED') and i.unit_cost is not null
    order by o.created_at desc
    limit 1
  ) lp on true
  where oi.order_id = p_order_id
    and is_admin()
  order by p.name;
$$;

revoke all on function public.request_supplier_suggestions(uuid) from public, anon;
grant execute on function public.request_supplier_suggestions(uuid) to authenticated;

commit;

-- =====================================================================
-- Tests (run with the script). Each scenario builds its own request and
-- is rolled back, so nothing stays in the database.
-- =====================================================================
create temp table if not exists _split_tests (n int, test text, result text);
truncate _split_tests;

create or replace function pg_temp.split_fixture()
returns table (order_id uuid, item1 uuid, item2 uuid, item3 uuid, sup_a uuid, sup_b uuid, p3 uuid, author uuid)
language plpgsql as $$
declare
  v_obj uuid; v_a uuid; v_b uuid; v_o uuid; v_p uuid[];
begin
  select id into v_obj from public.objects where active order by name limit 1;
  select id into v_a from public.suppliers where active order by created_at limit 1;
  insert into public.suppliers (name, active, created_at, updated_at)
  values ('__split_test_supplier__', true, now(), now()) returning id into v_b;
  select array_agg(id order by sku) into v_p
  from (select id, sku from public.products where active order by sku limit 3) x;

  insert into public.orders (object_id, comment) values (v_obj, 'split test')
  returning id into v_o;
  insert into public.order_items (order_id, product_id, quantity) values (v_o, v_p[1], 100);
  insert into public.order_items (order_id, product_id, quantity) values (v_o, v_p[2], 5);
  insert into public.order_items (order_id, product_id, quantity) values (v_o, v_p[3], 8);

  return query
  select v_o,
         (select id from public.order_items where order_id = v_o and product_id = v_p[1]),
         (select id from public.order_items where order_id = v_o and product_id = v_p[2]),
         (select id from public.order_items where order_id = v_o and product_id = v_p[3]),
         v_a, v_b, v_p[3],
         (select created_by from public.orders where id = v_o);
end;
$$;

do $$
declare
  v_admin uuid; v_seller uuid;
  f record; v_res jsonb; v_r text; v_r8 text := 'FAIL'; v_n int; v_q int;
begin
  begin
    execute 'select id from public.profiles where upper(role::text) = ''ADMIN'' limit 1' into v_admin;
    execute 'select id from public.profiles where upper(role::text) <> ''ADMIN'' limit 1' into v_seller;
  exception when others then
    insert into _split_tests values (0, 'setup', 'SKIP: could not read profiles.role (' || sqlerrm || ')');
    return;
  end;
  if v_admin is null then
    insert into _split_tests values (0, 'setup', 'SKIP: no admin profile found');
    return;
  end if;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- 1. One supplier -> one order, no split
  v_r := 'FAIL';
  begin
    select * into f from pg_temp.split_fixture();
    v_res := public.approve_request(f.order_id, jsonb_build_array(
      jsonb_build_object('order_item_id', f.item1, 'supplier_id', f.sup_a, 'quantity', 100),
      jsonb_build_object('order_item_id', f.item2, 'supplier_id', f.sup_a, 'quantity', 5),
      jsonb_build_object('order_item_id', f.item3, 'supplier_id', f.sup_a, 'quantity', 8)));
    select count(*) into v_n from public.orders where split_from_order_id = f.order_id;
    if v_n = 0 and (v_res->>'split')::boolean = false
       and (select status from public.orders where id = f.order_id) = 'APPROVED'
       and (select count(*) from public.order_items where order_id = f.order_id) = 3 then
      v_r := 'PASS';
    end if;
    raise exception 'rollback_ok';
  exception when others then
    if sqlerrm <> 'rollback_ok' then v_r := 'ERROR: ' || sqlerrm; end if;
  end;
  insert into _split_tests values (1, 'One supplier -> 1 approved order', v_r);

  -- 2. Two suppliers -> 2 approved orders, requester kept as author
  v_r := 'FAIL';
  begin
    select * into f from pg_temp.split_fixture();
    v_res := public.approve_request(f.order_id, jsonb_build_array(
      jsonb_build_object('order_item_id', f.item1, 'supplier_id', f.sup_a, 'quantity', 100),
      jsonb_build_object('order_item_id', f.item2, 'supplier_id', f.sup_a, 'quantity', 5),
      jsonb_build_object('order_item_id', f.item3, 'supplier_id', f.sup_b, 'quantity', 8)));
    select count(*) into v_n from public.orders o
    where o.split_from_order_id = f.order_id and o.supplier_id = f.sup_b
      and o.status = 'APPROVED' and o.created_by = f.author
      and (select count(*) from public.order_items where order_id = o.id) = 1;
    if v_n = 1
       and (select supplier_id from public.orders where id = f.order_id) = f.sup_a
       and (select count(*) from public.order_items where order_id = f.order_id) = 2
       and jsonb_array_length(v_res->'orders') = 2 then
      v_r := 'PASS';
    end if;
    -- 8. catalog learned the new pair (variables survive the rollback)
    if exists (select 1 from public.supplier_products
               where supplier_id = f.sup_b and product_id = f.p3 and active) then
      v_r8 := 'PASS';
    end if;
    raise exception 'rollback_ok';
  exception when others then
    if sqlerrm <> 'rollback_ok' then v_r := 'ERROR: ' || sqlerrm; end if;
  end;
  insert into _split_tests values (2, 'Two suppliers -> 2 approved orders', v_r);
  insert into _split_tests values (8, 'Catalog learns supplier/product pair', v_r8);

  -- 3. One line split 60 / 40
  v_r := 'FAIL';
  begin
    select * into f from pg_temp.split_fixture();
    v_res := public.approve_request(f.order_id, jsonb_build_array(
      jsonb_build_object('order_item_id', f.item1, 'supplier_id', f.sup_a, 'quantity', 60),
      jsonb_build_object('order_item_id', f.item1, 'supplier_id', f.sup_b, 'quantity', 40),
      jsonb_build_object('order_item_id', f.item2, 'supplier_id', f.sup_a, 'quantity', 5),
      jsonb_build_object('order_item_id', f.item3, 'supplier_id', f.sup_a, 'quantity', 8)));
    select oi.quantity into v_q
    from public.orders o join public.order_items oi on oi.order_id = o.id
    where o.split_from_order_id = f.order_id and o.supplier_id = f.sup_b;
    if v_q = 40 and (select quantity from public.order_items where id = f.item1) = 60 then
      v_r := 'PASS';
    end if;
    raise exception 'rollback_ok';
  exception when others then
    if sqlerrm <> 'rollback_ok' then v_r := 'ERROR: ' || sqlerrm; end if;
  end;
  insert into _split_tests values (3, 'One line split 60 / 40', v_r);

  -- 4. Inactive supplier rejected
  v_r := 'FAIL: accepted';
  begin
    select * into f from pg_temp.split_fixture();
    update public.suppliers set active = false where id = f.sup_b;
    perform public.approve_request(f.order_id, jsonb_build_array(
      jsonb_build_object('order_item_id', f.item1, 'supplier_id', f.sup_b, 'quantity', 100)));
    raise exception 'rollback_ok';
  exception when others then
    if sqlerrm like '%inactive or missing%' then v_r := 'PASS';
    elsif sqlerrm <> 'rollback_ok' then v_r := 'ERROR: ' || sqlerrm; end if;
  end;
  insert into _split_tests values (4, 'Inactive supplier rejected', v_r);

  -- 5. Line from another request rejected
  v_r := 'FAIL: accepted';
  begin
    select * into f from pg_temp.split_fixture();
    perform public.approve_request(f.order_id, jsonb_build_array(
      jsonb_build_object('order_item_id', gen_random_uuid(), 'supplier_id', f.sup_a, 'quantity', 1)));
    raise exception 'rollback_ok';
  exception when others then
    if sqlerrm like '%does not belong%' then v_r := 'PASS';
    elsif sqlerrm <> 'rollback_ok' then v_r := 'ERROR: ' || sqlerrm; end if;
  end;
  insert into _split_tests values (5, 'Foreign line rejected', v_r);

  -- 6. Approving twice rejected
  v_r := 'FAIL: accepted';
  begin
    select * into f from pg_temp.split_fixture();
    perform public.approve_request(f.order_id, jsonb_build_array(
      jsonb_build_object('order_item_id', f.item1, 'supplier_id', f.sup_a, 'quantity', 100)));
    perform public.approve_request(f.order_id, jsonb_build_array(
      jsonb_build_object('order_item_id', f.item1, 'supplier_id', f.sup_a, 'quantity', 100)));
    raise exception 'rollback_ok';
  exception when others then
    if sqlerrm like '%Only a PENDING request%' then v_r := 'PASS';
    elsif sqlerrm <> 'rollback_ok' then v_r := 'ERROR: ' || sqlerrm; end if;
  end;
  insert into _split_tests values (6, 'Second approval rejected', v_r);

  -- 7. Non-admin rejected
  if v_seller is null then
    insert into _split_tests values (7, 'Non-admin rejected', 'SKIP: no non-admin profile');
  else
    v_r := 'FAIL: accepted';
    begin
      select * into f from pg_temp.split_fixture();
      perform set_config('request.jwt.claim.sub', v_seller::text, true);
      perform set_config('request.jwt.claims', json_build_object('sub', v_seller, 'role', 'authenticated')::text, true);
      perform public.approve_request(f.order_id, jsonb_build_array(
        jsonb_build_object('order_item_id', f.item1, 'supplier_id', f.sup_a, 'quantity', 100)));
      raise exception 'rollback_ok';
    exception when others then
      if sqlerrm like '%Only admins%' then v_r := 'PASS';
      elsif sqlerrm <> 'rollback_ok' then v_r := 'ERROR: ' || sqlerrm; end if;
    end;
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    insert into _split_tests values (7, 'Non-admin rejected', v_r);
  end if;
end $$;

select n, test, result from _split_tests order by n;
