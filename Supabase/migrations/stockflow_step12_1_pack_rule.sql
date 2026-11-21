-- =====================================================================
-- Stockflow · Step 12.1 · Order quantity rule = pack size × minimum packs
--
--   pack_size       units in one pack/carton the supplier sells   (>= 1)
--   minimum_packs   smallest number of packs per order            (>= 1)
--   minimum units   = pack_size × minimum_packs  (computed, not stored)
--
-- Valid order quantities: multiples of pack_size, at least the minimum.
--   pack 12, min 2  ->  24, 36, 48 …
--
-- Replaces the ambiguous minimum_order_qty column.
-- Run as ONE script in the Supabase SQL editor.
-- =====================================================================

begin;

alter table public.supplier_products
  add column if not exists minimum_packs int not null default 1;

-- Backfill: old unit minimum -> packs (rounded up). Dynamic so a re-run is safe.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'supplier_products'
               and column_name = 'minimum_order_qty') then
    execute 'update public.supplier_products
             set minimum_packs = greatest(1, ceil(minimum_order_qty::numeric / pack_size)::int)';
  end if;
end $$;

alter table public.supplier_products
  drop constraint if exists supplier_products_min_packs_chk,
  add  constraint supplier_products_min_packs_chk check (minimum_packs between 1 and 100000);

-- Functions that read/write the old column, now on the new rule
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
           sp.lead_time_days, sp.pack_size, sp.minimum_packs,
           sp.pack_size * sp.minimum_packs as minimum_units,
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
      minimum_packs = case when p_patch ? 'minimum_packs'
                           then coalesce(nullif(p_patch->>'minimum_packs', '')::int, 1)
                           else sp.minimum_packs end,
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
    raise exception 'Invalid value: lead time 0–365 days, pack size and minimum packs at least 1.'
      using errcode = '22023';
  when invalid_text_representation then
    raise exception 'Lead time, pack size and minimum packs must be whole numbers.'
      using errcode = '22023';
end;
$$;

alter table public.supplier_products drop constraint if exists supplier_products_moq_chk;
alter table public.supplier_products drop column if exists minimum_order_qty;

-- One place for the quantity rule (used by Purchase Requests next)
create or replace function public.supplier_order_qty(
  p_needed int, p_pack_size int, p_minimum_packs int)
returns int language sql immutable as $$
  select greatest(
    greatest(p_pack_size, 1) * greatest(p_minimum_packs, 1),
    ceil(greatest(p_needed, 0)::numeric / greatest(p_pack_size, 1))::int * greatest(p_pack_size, 1)
  );
$$;

revoke all on function public.supplier_order_qty(int, int, int) from public, anon;
grant execute on function public.supplier_order_qty(int, int, int) to authenticated;

commit;

-- =====================================================================
-- Checks
-- =====================================================================
-- Expected: 24 | 36 | 12 | 1 | 5
select public.supplier_order_qty(17, 12, 2) as need17_pack12_min2,
       public.supplier_order_qty(31, 12, 2) as need31_pack12_min2,
       public.supplier_order_qty(1, 12, 1)  as need1_pack12_min1_is_12_not_24,
       public.supplier_order_qty(1, 1, 1)   as need1_no_rules,
       public.supplier_order_qty(5, 1, 1)   as need5_no_rules;
