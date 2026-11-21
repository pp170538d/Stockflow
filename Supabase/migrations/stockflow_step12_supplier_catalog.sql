-- =====================================================================
-- Stockflow · Step 12 · Phase A · Supplier product catalog
--
--  1. supplier_products        which supplier can deliver which product
--                              (supplier SKU, preferred, lead time, MOQ, pack size)
--  2. Seed from order history  every supplier/product pair ever ordered;
--                              preferred = supplier of the latest order
--  3. RLS                      admins read; writes only through RPCs below
--  4. RPCs (admin, demo read-only)
--       supplier_catalog()                 paged catalog of one supplier
--       supplier_catalog_candidates()      products that can still be added
--       assign_supplier_products()         bulk add (ids or "all matching")
--       update_supplier_product()          edit one mapping
--       set_supplier_products_active()     bulk activate / deactivate
--       set_preferred_supplier_products()  bulk preferred on / off
--
-- Existing orders and New order are NOT changed.
-- Run as ONE script in the Supabase SQL editor.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
create table if not exists public.supplier_products (
  id                uuid primary key default gen_random_uuid(),
  supplier_id       uuid not null references public.suppliers(id) on delete restrict,
  product_id        uuid not null references public.products(id)  on delete restrict,
  supplier_sku      text,
  preferred         boolean not null default false,
  active            boolean not null default true,
  lead_time_days    int,
  minimum_order_qty int not null default 1,
  pack_size         int not null default 1,
  created_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_by        uuid references public.profiles(id),
  updated_at        timestamptz not null default now(),

  constraint supplier_products_pair_uq      unique (supplier_id, product_id),
  constraint supplier_products_preferred_active_chk check (not preferred or active),
  constraint supplier_products_lead_time_chk check (lead_time_days is null or lead_time_days between 0 and 365),
  constraint supplier_products_moq_chk       check (minimum_order_qty >= 1),
  constraint supplier_products_pack_chk      check (pack_size >= 1),
  constraint supplier_products_sku_chk       check (supplier_sku is null or length(btrim(supplier_sku)) between 1 and 64)
);

-- At most ONE preferred supplier per product
create unique index if not exists supplier_products_one_preferred_uq
  on public.supplier_products (product_id) where preferred;

create index if not exists supplier_products_supplier_idx
  on public.supplier_products (supplier_id, active);
create index if not exists supplier_products_product_idx
  on public.supplier_products (product_id);

create or replace function public.touch_supplier_products()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_supplier_products on public.supplier_products;
create trigger trg_touch_supplier_products
  before update on public.supplier_products
  for each row execute function public.touch_supplier_products();

-- ---------------------------------------------------------------------
-- 2. RLS: admins read, nobody writes directly (RPCs only)
-- ---------------------------------------------------------------------
alter table public.supplier_products enable row level security;

drop policy if exists supplier_products_admin_read on public.supplier_products;
create policy supplier_products_admin_read on public.supplier_products
  for select to authenticated using (public.is_admin());

revoke insert, update, delete on public.supplier_products from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Seed from purchase history
-- ---------------------------------------------------------------------
insert into public.supplier_products (supplier_id, product_id, active, preferred, created_at)
select o.supplier_id, oi.product_id, true, false, min(o.created_at)
from public.orders o
join public.order_items oi on oi.order_id = o.id
where o.supplier_id is not null
group by o.supplier_id, oi.product_id
on conflict (supplier_id, product_id) do nothing;

-- Preferred = the supplier of the most recent non-rejected order of that product
with latest as (
  select distinct on (oi.product_id) oi.product_id, o.supplier_id
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.supplier_id is not null and o.status <> 'REJECTED'
  order by oi.product_id, o.created_at desc
)
update public.supplier_products sp
set preferred = true
from latest l
where sp.product_id = l.product_id
  and sp.supplier_id = l.supplier_id
  and not exists (
    select 1 from public.supplier_products x
    where x.product_id = sp.product_id and x.preferred
  );

-- ---------------------------------------------------------------------
-- 4a. Paged catalog of one supplier
--     p_status: 'active' | 'inactive' | 'all'
-- ---------------------------------------------------------------------
create or replace function public.supplier_catalog(
  p_supplier_id uuid,
  p_search      text default null,
  p_status      text default 'active',
  p_limit       int  default 50,
  p_offset      int  default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_q      text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit  int  := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int  := greatest(coalesce(p_offset, 0), 0);
  v_total  int;
  v_rows   jsonb;
  v_counts jsonb;
begin
  if not is_admin() then
    raise exception 'Only admins can view supplier catalogs' using errcode = '42501';
  end if;
  if coalesce(p_status, '') not in ('active', 'inactive', 'all') then
    raise exception 'Status must be active, inactive or all' using errcode = '22023';
  end if;

  select jsonb_build_object(
           'active',    count(*) filter (where sp.active),
           'inactive',  count(*) filter (where not sp.active),
           'preferred', count(*) filter (where sp.preferred))
    into v_counts
  from supplier_products sp
  where sp.supplier_id = p_supplier_id;

  select count(*) into v_total
  from supplier_products sp
  join products p on p.id = sp.product_id
  where sp.supplier_id = p_supplier_id
    and (p_status = 'all' or sp.active = (p_status = 'active'))
    and (v_q is null
         or p.sku ilike '%' || v_q || '%'
         or p.name ilike '%' || v_q || '%'
         or coalesce(p.barcode, '') ilike '%' || v_q || '%'
         or coalesce(sp.supplier_sku, '') ilike '%' || v_q || '%');

  select coalesce(jsonb_agg(r order by r.sku), '[]'::jsonb) into v_rows
  from (
    select sp.id, sp.product_id, p.sku, p.name as product_name, p.category, p.barcode,
           p.active as product_active, p.cost_price,
           sp.supplier_sku, sp.preferred, sp.active,
           sp.lead_time_days, sp.minimum_order_qty, sp.pack_size,
           sp.updated_at,
           lp.unit_cost      as last_unit_cost,
           lp.order_number   as last_order_number,
           lp.created_at     as last_ordered_at,
           coalesce(oc.n, 0) as orders_count,
           ps.name           as other_preferred_supplier
    from supplier_products sp
    join products p on p.id = sp.product_id
    left join lateral (
      select oi.unit_cost, o.order_number, o.created_at
      from orders o join order_items oi on oi.order_id = o.id
      where o.supplier_id = sp.supplier_id and oi.product_id = sp.product_id
        and o.status <> 'REJECTED'
      order by o.created_at desc
      limit 1
    ) lp on true
    left join lateral (
      select count(distinct o.id)::int as n
      from orders o join order_items oi on oi.order_id = o.id
      where o.supplier_id = sp.supplier_id and oi.product_id = sp.product_id
        and o.status <> 'REJECTED'
    ) oc on true
    left join supplier_products other
      on other.product_id = sp.product_id and other.preferred and other.supplier_id <> sp.supplier_id
    left join suppliers ps on ps.id = other.supplier_id
    where sp.supplier_id = p_supplier_id
      and (p_status = 'all' or sp.active = (p_status = 'active'))
      and (v_q is null
           or p.sku ilike '%' || v_q || '%'
           or p.name ilike '%' || v_q || '%'
           or coalesce(p.barcode, '') ilike '%' || v_q || '%'
           or coalesce(sp.supplier_sku, '') ilike '%' || v_q || '%')
    order by p.sku
    limit v_limit offset v_offset
  ) r;

  return jsonb_build_object('total', v_total, 'counts', v_counts, 'rows', v_rows,
                            'limit', v_limit, 'offset', v_offset);
end;
$$;

-- ---------------------------------------------------------------------
-- 4b. Products that can still be added to this supplier
--     (active products without an ACTIVE mapping; inactive mappings
--      show up here and are reactivated on assign)
-- ---------------------------------------------------------------------
create or replace function public.supplier_catalog_candidates(
  p_supplier_id uuid,
  p_search      text default null,
  p_category    text default null,
  p_limit       int  default 50,
  p_offset      int  default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_q      text := nullif(btrim(coalesce(p_search, '')), '');
  v_cat    text := nullif(btrim(coalesce(p_category, '')), '');
  v_limit  int  := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int  := greatest(coalesce(p_offset, 0), 0);
  v_total  int;
  v_rows   jsonb;
  v_cats   jsonb;
begin
  if not is_admin() then
    raise exception 'Only admins can manage supplier catalogs' using errcode = '42501';
  end if;

  select count(*) into v_total
  from products p
  where p.active
    and not exists (select 1 from supplier_products sp
                    where sp.supplier_id = p_supplier_id and sp.product_id = p.id and sp.active)
    and (v_cat is null or p.category = v_cat)
    and (v_q is null or p.sku ilike '%' || v_q || '%' or p.name ilike '%' || v_q || '%'
         or coalesce(p.barcode, '') ilike '%' || v_q || '%');

  select coalesce(jsonb_agg(r order by r.sku), '[]'::jsonb) into v_rows
  from (
    select p.id as product_id, p.sku, p.name as product_name, p.category, p.barcode,
           ps.name as preferred_supplier,
           exists (select 1 from supplier_products sp
                   where sp.supplier_id = p_supplier_id and sp.product_id = p.id) as previously_mapped
    from products p
    left join supplier_products pref on pref.product_id = p.id and pref.preferred
    left join suppliers ps on ps.id = pref.supplier_id
    where p.active
      and not exists (select 1 from supplier_products sp
                      where sp.supplier_id = p_supplier_id and sp.product_id = p.id and sp.active)
      and (v_cat is null or p.category = v_cat)
      and (v_q is null or p.sku ilike '%' || v_q || '%' or p.name ilike '%' || v_q || '%'
           or coalesce(p.barcode, '') ilike '%' || v_q || '%')
    order by p.sku
    limit v_limit offset v_offset
  ) r;

  select coalesce(jsonb_agg(c order by c), '[]'::jsonb) into v_cats
  from (select distinct category as c from products where active and category is not null) x;

  return jsonb_build_object('total', v_total, 'rows', v_rows, 'categories', v_cats,
                            'limit', v_limit, 'offset', v_offset);
end;
$$;

-- ---------------------------------------------------------------------
-- 4c. Bulk assign
--     Either a list of product ids, or p_all_matching = true with the same
--     filters as supplier_catalog_candidates (server-side "select all").
--     p_preferred_if_none: becomes preferred where a product has none yet.
-- ---------------------------------------------------------------------
create or replace function public.assign_supplier_products(
  p_supplier_id        uuid,
  p_product_ids        uuid[]  default null,
  p_all_matching       boolean default false,
  p_search             text    default null,
  p_category           text    default null,
  p_preferred_if_none  boolean default true
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_q     text := nullif(btrim(coalesce(p_search, '')), '');
  v_cat   text := nullif(btrim(coalesce(p_category, '')), '');
  v_added int := 0;
  v_react int := 0;
  v_pref  int := 0;
  v_total int;
begin
  if not is_admin() then
    raise exception 'Only admins can manage supplier catalogs' using errcode = '42501';
  end if;
  if is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;
  if not exists (select 1 from suppliers where id = p_supplier_id and active) then
    raise exception 'Supplier not found or inactive.' using errcode = '22023';
  end if;
  if not coalesce(p_all_matching, false) and coalesce(cardinality(p_product_ids), 0) = 0 then
    raise exception 'Select at least one product.' using errcode = '22023';
  end if;

  drop table if exists pg_temp._assign;
  create temp table _assign on commit drop as
  select p.id as product_id
  from products p
  where p.active
    and (
      (not coalesce(p_all_matching, false) and p.id = any(p_product_ids))
      or (coalesce(p_all_matching, false)
          and not exists (select 1 from supplier_products sp
                          where sp.supplier_id = p_supplier_id and sp.product_id = p.id and sp.active)
          and (v_cat is null or p.category = v_cat)
          and (v_q is null or p.sku ilike '%' || v_q || '%' or p.name ilike '%' || v_q || '%'
               or coalesce(p.barcode, '') ilike '%' || v_q || '%'))
    );

  select count(*) into v_total from _assign;
  if v_total = 0 then
    raise exception 'No active products matched.' using errcode = '22023';
  end if;
  if v_total > 20000 then
    raise exception 'Too many products in one step (%). Narrow the filter.', v_total using errcode = '22023';
  end if;

  with up as (
    insert into supplier_products (supplier_id, product_id, active, created_by, updated_by)
    select p_supplier_id, a.product_id, true, auth.uid(), auth.uid()
    from _assign a
    on conflict (supplier_id, product_id) do update
      set active = true, updated_by = auth.uid()
      where supplier_products.active = false
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_added, v_react
  from up;

  if coalesce(p_preferred_if_none, true) then
    update supplier_products sp
    set preferred = true, updated_by = auth.uid()
    from _assign a
    where sp.supplier_id = p_supplier_id
      and sp.product_id = a.product_id
      and sp.active
      and not exists (select 1 from supplier_products x
                      where x.product_id = sp.product_id and x.preferred);
    get diagnostics v_pref = row_count;
  end if;

  return jsonb_build_object(
    'matched', v_total,
    'added', v_added,
    'reactivated', v_react,
    'already_assigned', v_total - v_added - v_react,
    'preferred_set', v_pref
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 4d. Edit one mapping
--     p_patch keys (only the ones present are changed):
--       supplier_sku, lead_time_days (null = unknown), minimum_order_qty, pack_size
-- ---------------------------------------------------------------------
create or replace function public.update_supplier_product(p_id uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_row supplier_products;
begin
  if not is_admin() then
    raise exception 'Only admins can manage supplier catalogs' using errcode = '42501';
  end if;
  if is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Nothing to update.' using errcode = '22023';
  end if;

  update supplier_products sp
  set supplier_sku = case when p_patch ? 'supplier_sku'
                          then nullif(btrim(p_patch->>'supplier_sku'), '') else sp.supplier_sku end,
      lead_time_days = case when p_patch ? 'lead_time_days'
                            then nullif(p_patch->>'lead_time_days', '')::int else sp.lead_time_days end,
      minimum_order_qty = case when p_patch ? 'minimum_order_qty'
                               then coalesce(nullif(p_patch->>'minimum_order_qty', '')::int, 1)
                               else sp.minimum_order_qty end,
      pack_size = case when p_patch ? 'pack_size'
                       then coalesce(nullif(p_patch->>'pack_size', '')::int, 1)
                       else sp.pack_size end,
      updated_by = auth.uid()
  where sp.id = p_id
  returning * into v_row;

  if not found then
    raise exception 'Catalog line not found.' using errcode = 'P0002';
  end if;

  return to_jsonb(v_row);
exception
  when check_violation then
    raise exception 'Invalid value: lead time 0–365 days, minimum order and pack size at least 1.'
      using errcode = '22023';
  when invalid_text_representation then
    raise exception 'Lead time, minimum order and pack size must be whole numbers.'
      using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------
-- 4e. Bulk activate / deactivate (deactivating also clears preferred)
-- ---------------------------------------------------------------------
create or replace function public.set_supplier_products_active(p_ids uuid[], p_active boolean)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_n int;
begin
  if not is_admin() then
    raise exception 'Only admins can manage supplier catalogs' using errcode = '42501';
  end if;
  if is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_ids), 0) = 0 then
    raise exception 'Select at least one product.' using errcode = '22023';
  end if;

  update supplier_products
  set active = p_active,
      preferred = case when p_active then preferred else false end,
      updated_by = auth.uid()
  where id = any(p_ids) and active is distinct from p_active;
  get diagnostics v_n = row_count;

  return jsonb_build_object('changed', v_n);
end;
$$;

-- ---------------------------------------------------------------------
-- 4f. Bulk preferred on / off
--     Turning ON moves "preferred" away from any other supplier of the
--     same product.
-- ---------------------------------------------------------------------
create or replace function public.set_preferred_supplier_products(p_ids uuid[], p_preferred boolean)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_n     int;
  v_moved int := 0;
begin
  if not is_admin() then
    raise exception 'Only admins can manage supplier catalogs' using errcode = '42501';
  end if;
  if is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_ids), 0) = 0 then
    raise exception 'Select at least one product.' using errcode = '22023';
  end if;

  if not p_preferred then
    update supplier_products set preferred = false, updated_by = auth.uid()
    where id = any(p_ids) and preferred;
    get diagnostics v_n = row_count;
    return jsonb_build_object('changed', v_n, 'moved_from_other_suppliers', 0);
  end if;

  drop table if exists pg_temp._pref;
  create temp table _pref on commit drop as
  select sp.id, sp.product_id, sp.active, s.active as supplier_active
  from supplier_products sp join suppliers s on s.id = sp.supplier_id
  where sp.id = any(p_ids);

  if exists (select 1 from _pref where not active or not supplier_active) then
    raise exception 'Only active products of an active supplier can be preferred.' using errcode = '22023';
  end if;
  if exists (select product_id from _pref group by product_id having count(*) > 1) then
    raise exception 'A product can have only one preferred supplier.' using errcode = '22023';
  end if;

  update supplier_products sp
  set preferred = false, updated_by = auth.uid()
  from _pref p
  where sp.product_id = p.product_id and sp.id <> p.id and sp.preferred;
  get diagnostics v_moved = row_count;

  update supplier_products sp
  set preferred = true, updated_by = auth.uid()
  from _pref p
  where sp.id = p.id and not sp.preferred;
  get diagnostics v_n = row_count;

  return jsonb_build_object('changed', v_n, 'moved_from_other_suppliers', v_moved);
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke all on function public.supplier_catalog(uuid, text, text, int, int) from public, anon;
revoke all on function public.supplier_catalog_candidates(uuid, text, text, int, int) from public, anon;
revoke all on function public.assign_supplier_products(uuid, uuid[], boolean, text, text, boolean) from public, anon;
revoke all on function public.update_supplier_product(uuid, jsonb) from public, anon;
revoke all on function public.set_supplier_products_active(uuid[], boolean) from public, anon;
revoke all on function public.set_preferred_supplier_products(uuid[], boolean) from public, anon;

grant execute on function public.supplier_catalog(uuid, text, text, int, int) to authenticated;
grant execute on function public.supplier_catalog_candidates(uuid, text, text, int, int) to authenticated;
grant execute on function public.assign_supplier_products(uuid, uuid[], boolean, text, text, boolean) to authenticated;
grant execute on function public.update_supplier_product(uuid, jsonb) to authenticated;
grant execute on function public.set_supplier_products_active(uuid[], boolean) to authenticated;
grant execute on function public.set_preferred_supplier_products(uuid[], boolean) to authenticated;

commit;

-- =====================================================================
-- Tests (constraints only; RPCs need a signed-in admin, test them in the app)
-- Every test runs in a sub-transaction and is rolled back.
-- =====================================================================
create temp table if not exists _catalog_tests (n int, test text, result text);
truncate _catalog_tests;

do $$
declare
  v_p   uuid;
  v_sp  uuid;
  v_s   uuid;
  v_sup uuid;
  v_r   text;
begin
  select id, product_id, supplier_id into v_sp, v_p, v_sup
  from supplier_products where preferred limit 1;

  if v_sp is null then
    insert into _catalog_tests values (0, 'setup', 'SKIP: no seeded preferred mapping');
    return;
  end if;

  -- 1. second preferred supplier for the same product is rejected
  v_r := 'FAIL: accepted';
  begin
    insert into suppliers (name, active, created_at, updated_at)
    values ('__catalog_test_supplier__', true, now(), now())
    returning id into v_s;
    insert into supplier_products (supplier_id, product_id, preferred, active)
    values (v_s, v_p, true, true);
    raise exception 'rollback_ok';
  exception
    when unique_violation then v_r := 'PASS';
    when others then
      v_r := case when sqlerrm = 'rollback_ok' then 'FAIL: accepted'
                  else 'SETUP ERROR: ' || sqlerrm end;
  end;
  insert into _catalog_tests values (1, 'One preferred supplier per product', v_r);

  -- 2. same supplier + product twice is rejected
  v_r := 'FAIL: accepted';
  begin
    insert into supplier_products (supplier_id, product_id) values (v_sup, v_p);
    raise exception 'rollback_ok';
  exception
    when unique_violation then v_r := 'PASS';
    when others then v_r := case when sqlerrm = 'rollback_ok' then 'FAIL: accepted' else 'ERROR: ' || sqlerrm end;
  end;
  insert into _catalog_tests values (2, 'No duplicate supplier/product pair', v_r);

  -- 3. an inactive mapping can not be preferred
  v_r := 'FAIL: accepted';
  begin
    update supplier_products set active = false where id = v_sp;
    raise exception 'rollback_ok';
  exception
    when check_violation then v_r := 'PASS';
    when others then v_r := case when sqlerrm = 'rollback_ok' then 'FAIL: accepted' else 'ERROR: ' || sqlerrm end;
  end;
  insert into _catalog_tests values (3, 'Preferred must be active', v_r);

  -- 4. pack size must be at least 1
  v_r := 'FAIL: accepted';
  begin
    update supplier_products set pack_size = 0 where id = v_sp;
    raise exception 'rollback_ok';
  exception
    when check_violation then v_r := 'PASS';
    when others then v_r := case when sqlerrm = 'rollback_ok' then 'FAIL: accepted' else 'ERROR: ' || sqlerrm end;
  end;
  insert into _catalog_tests values (4, 'Pack size >= 1', v_r);
end $$;

-- Result 1: tests
-- Result 2 (run separately if the editor shows only the last result): seeded catalog
select n, test, result from _catalog_tests order by n;

select s.name as supplier, p.sku, p.name as product,
       sp.preferred, sp.active, sp.minimum_order_qty, sp.pack_size, sp.lead_time_days
from supplier_products sp
join suppliers s on s.id = sp.supplier_id
join products  p on p.id = sp.product_id
order by s.name, p.sku;
