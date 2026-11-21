-- =====================================================================
-- Stockflow · Step 13.1 · Pack rule enforced on approval
--
-- approve_request() now REJECTS quantities that break the supplier's pack
-- rule (not a multiple of pack_size, or below pack_size × minimum_packs).
-- The UI blocks this too; the database makes it impossible via the API.
-- Everything else in approve_request() is unchanged.
-- =====================================================================

begin;

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

  -- Supplier pack rule is a hard rule: valid quantities are multiples of
  -- pack_size and at least pack_size × minimum_packs.
  select string_agg(format('%s (%s units; supplier ships %s × %s, minimum %s)',
                           p.name, g.quantity, sp.minimum_packs, sp.pack_size,
                           sp.pack_size * sp.minimum_packs), '; ')
    into v_bad
  from _grp g
  join supplier_products sp on sp.supplier_id = g.supplier_id and sp.product_id = g.product_id
  join products p on p.id = g.product_id
  where g.quantity < sp.pack_size * sp.minimum_packs
     or g.quantity % sp.pack_size <> 0;
  if v_bad is not null then
    raise exception 'Invalid supplier quantity: %.', v_bad using errcode = '22023';
  end if;

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

commit;

-- =====================================================================
-- Test (rolled back): pack 6, request 11 -> rejected; 12 -> approved
-- =====================================================================
create temp table if not exists _pack_tests (n int, test text, result text);
truncate _pack_tests;

do $$
declare
  v_admin uuid; v_obj uuid; v_sup uuid; v_prod uuid; v_o uuid; v_item uuid; v_r text;
begin
  select p.id into v_admin
  from public.profiles p left join public.objects o on o.id = p.object_id
  where upper(p.role::text) = 'ADMIN' and coalesce(o.is_demo, false) = false
  order by (p.object_id is null) desc limit 1;
  if v_admin is null then
    insert into _pack_tests values (0, 'setup', 'SKIP: no non-demo admin'); return;
  end if;
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  select id into v_obj from public.objects where active and not coalesce(is_demo, false) order by name limit 1;
  select supplier_id, product_id into v_sup, v_prod from public.supplier_products where active and preferred limit 1;

  for i in 1..2 loop
    v_r := 'FAIL';
    begin
      update public.supplier_products set pack_size = 6, minimum_packs = 1
      where supplier_id = v_sup and product_id = v_prod;
      insert into public.orders (object_id, comment) values (v_obj, 'pack test') returning id into v_o;
      insert into public.order_items (order_id, product_id, quantity) values (v_o, v_prod, 1) returning id into v_item;
      perform public.approve_request(v_o, jsonb_build_array(
        jsonb_build_object('order_item_id', v_item, 'supplier_id', v_sup, 'quantity', case i when 1 then 11 else 12 end)));
      v_r := case i when 1 then 'FAIL: 11 accepted' else 'PASS' end;
      raise exception 'rollback_ok';
    exception when others then
      if i = 1 and sqlerrm like 'Invalid supplier quantity%' then v_r := 'PASS';
      elsif sqlerrm <> 'rollback_ok' then v_r := 'ERROR: ' || sqlerrm; end if;
    end;
    insert into _pack_tests values (i, case i when 1 then '11 units on pack 6 rejected' else '12 units on pack 6 approved' end, v_r);
  end loop;
end $$;

select n, test, result from _pack_tests order by n;
