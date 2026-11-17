-- Stockflow Step 4: add cost_price and sell_price to Product import preview/apply.
-- Missing column => keep existing value. Present but blank => clear the price.

create or replace function public.import_products(
  p_file_name text,
  p_file_hash text,
  p_rows jsonb,
  p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_total    int;
  v_errors   jsonb;
  v_rows     jsonb;
  v_new      int;
  v_updated  int;
  v_same     int;
  v_invalid  int;
  v_batch_id uuid;
begin
  if not is_admin() then
    raise exception 'Only admin can import products' using errcode = '42501';
  end if;
  if not p_dry_run and is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total = 0 then
    raise exception 'File has no data rows' using errcode = '22023';
  end if;
  if v_total > 5000 then
    raise exception 'Max 5000 rows per import (got %)', v_total using errcode = '22023';
  end if;
  if coalesce(btrim(p_file_name), '') = '' then
    raise exception 'File name is required' using errcode = '22023';
  end if;
  if p_file_hash is null or p_file_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid file hash (expected SHA-256 hex)' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('stockflow:import_products'));

  drop table if exists pg_temp._imp;
  create temp table _imp on commit drop as
  select
    (r.ord + 1)::int as row_no,
    nullif(btrim(r.v->>'sku'), '') as sku,
    nullif(btrim(r.v->>'name'), '') as name,
    (r.v ? 'category') as has_category,
    nullif(btrim(r.v->>'category'), '') as category,
    (r.v ? 'barcode') as has_barcode,
    nullif(regexp_replace(coalesce(r.v->>'barcode', ''), '\s', '', 'g'), '') as barcode,

    (r.v ? 'cost_price') as has_cost_price,
    nullif(replace(btrim(coalesce(r.v->>'cost_price', '')), ',', '.'), '') as cost_price_raw,
    case
      when nullif(replace(btrim(coalesce(r.v->>'cost_price', '')), ',', '.'), '')
             ~ '^\d{1,10}(\.\d{1,2})?$'
      then round(replace(btrim(r.v->>'cost_price'), ',', '.')::numeric, 2)
    end as cost_price,

    (r.v ? 'sell_price') as has_sell_price,
    nullif(replace(btrim(coalesce(r.v->>'sell_price', '')), ',', '.'), '') as sell_price_raw,
    case
      when nullif(replace(btrim(coalesce(r.v->>'sell_price', '')), ',', '.'), '')
             ~ '^\d{1,10}(\.\d{1,2})?$'
      then round(replace(btrim(r.v->>'sell_price'), ',', '.')::numeric, 2)
    end as sell_price,

    lower(nullif(btrim(r.v->>'active'), '')) as active_raw,
    case lower(nullif(btrim(r.v->>'active'), ''))
      when 'true' then true when '1' then true when 'yes' then true
      when 'y' then true when 'da' then true
      when 'false' then false when '0' then false when 'no' then false
      when 'n' then false when 'ne' then false
    end as active
  from jsonb_array_elements(p_rows) with ordinality as r(v, ord);

  with e(row_no, field, message) as (
    select row_no, 'sku', 'SKU is required' from _imp where sku is null
    union all
    select row_no, 'name', 'Name is required' from _imp where name is null
    union all
    select row_no, 'barcode', 'Barcode must be 8–14 digits'
      from _imp where barcode is not null and barcode !~ '^[0-9]{8,14}$'
    union all
    select row_no, 'cost_price', format('Cost price must be a non-negative number with max 2 decimals (got "%s")', cost_price_raw)
      from _imp where has_cost_price and cost_price_raw is not null and cost_price is null
    union all
    select row_no, 'sell_price', format('Sell price must be a non-negative number with max 2 decimals (got "%s")', sell_price_raw)
      from _imp where has_sell_price and sell_price_raw is not null and sell_price is null
    union all
    select row_no, 'active', format('Active must be true/false (got "%s")', active_raw)
      from _imp where active_raw is not null and active is null
    union all
    select row_no, 'sku', format('SKU %s appears more than once in the file', sku)
      from (select row_no, sku, count(*) over (partition by sku) as c from _imp where sku is not null) d
      where c > 1
    union all
    select row_no, 'barcode', format('Barcode %s appears more than once in the file', barcode)
      from (select row_no, barcode, count(*) over (partition by barcode) as c from _imp where barcode is not null) d
      where c > 1
    union all
    select i.row_no, 'barcode', format('Barcode %s is already used by SKU %s', i.barcode, p.sku)
      from _imp i join products p on p.barcode = i.barcode
      where i.sku is distinct from p.sku
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('row', row_no, 'field', field, 'message', message)
              order by row_no, field), '[]'::jsonb)
  into v_errors
  from e;

  with err_rows as (
    select distinct (x->>'row')::int as row_no
    from jsonb_array_elements(v_errors) x
  ),
  calc as (
    select
      i.row_no, i.sku, i.name, p.id as product_id,
      p.name as p_name, p.category as p_category, p.barcode as p_barcode,
      p.cost_price as p_cost_price, p.sell_price as p_sell_price, p.active as p_active,
      case when i.has_category then i.category else p.category end as eff_category,
      case when i.has_barcode then i.barcode else p.barcode end as eff_barcode,
      case when i.has_cost_price then i.cost_price else p.cost_price end as eff_cost_price,
      case when i.has_sell_price then i.sell_price else p.sell_price end as eff_sell_price,
      coalesce(i.active, p.active, true) as eff_active,
      (er.row_no is not null) as has_error
    from _imp i
    left join products p on p.sku = i.sku
    left join err_rows er on er.row_no = i.row_no
  ),
  act as (
    select c.*,
      case
        when c.has_error then 'error'
        when c.product_id is null then 'new'
        when (c.p_name, c.p_category, c.p_barcode, c.p_cost_price, c.p_sell_price, c.p_active)
             is distinct from
             (c.name, c.eff_category, c.eff_barcode, c.eff_cost_price, c.eff_sell_price, c.eff_active)
          then 'update'
        else 'unchanged'
      end as action
    from calc c
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'row', row_no,
      'sku', sku,
      'action', action,
      'name', name,
      'category', eff_category,
      'barcode', eff_barcode,
      'cost_price', eff_cost_price,
      'sell_price', eff_sell_price,
      'active', eff_active,
      'before', case when action = 'update' then jsonb_build_object(
        'name', p_name,
        'category', p_category,
        'barcode', p_barcode,
        'cost_price', p_cost_price,
        'sell_price', p_sell_price,
        'active', p_active
      ) end
    ) order by row_no), '[]'::jsonb),
    count(*) filter (where action = 'new'),
    count(*) filter (where action = 'update'),
    count(*) filter (where action = 'unchanged'),
    count(*) filter (where action = 'error')
  into v_rows, v_new, v_updated, v_same, v_invalid
  from act;

  if p_dry_run or v_errors <> '[]'::jsonb then
    return jsonb_build_object(
      'ok', v_errors = '[]'::jsonb, 'applied', false, 'dry_run', p_dry_run,
      'total', v_total, 'new', v_new, 'updated', v_updated,
      'unchanged', v_same, 'invalid', v_invalid,
      'errors', v_errors, 'rows', v_rows, 'batch_id', null
    );
  end if;

  begin
    update products p
    set name = i.name,
        category = case when i.has_category then i.category else p.category end,
        barcode = case when i.has_barcode then i.barcode else p.barcode end,
        cost_price = case when i.has_cost_price then i.cost_price else p.cost_price end,
        sell_price = case when i.has_sell_price then i.sell_price else p.sell_price end,
        active = coalesce(i.active, p.active)
    from _imp i
    where p.sku = i.sku
      and (p.name, p.category, p.barcode, p.cost_price, p.sell_price, p.active)
          is distinct from
          (i.name,
           case when i.has_category then i.category else p.category end,
           case when i.has_barcode then i.barcode else p.barcode end,
           case when i.has_cost_price then i.cost_price else p.cost_price end,
           case when i.has_sell_price then i.sell_price else p.sell_price end,
           coalesce(i.active, p.active));

    insert into products (sku, name, category, barcode, cost_price, sell_price, active)
    select i.sku, i.name, i.category, i.barcode, i.cost_price, i.sell_price, coalesce(i.active, true)
    from _imp i
    where not exists (select 1 from products p where p.sku = i.sku);
  exception when unique_violation then
    raise exception 'Products changed during import (duplicate SKU or barcode). Run preview again.'
      using errcode = '23505';
  end;

  insert into import_batches
    (kind, file_name, file_hash, row_count, inserted_count, updated_count, unchanged_count)
  values
    ('products', btrim(p_file_name), p_file_hash, v_total, v_new, v_updated, v_same)
  returning id into v_batch_id;

  return jsonb_build_object(
    'ok', true, 'applied', true, 'dry_run', false,
    'total', v_total, 'new', v_new, 'updated', v_updated,
    'unchanged', v_same, 'invalid', 0,
    'errors', '[]'::jsonb, 'rows', v_rows, 'batch_id', v_batch_id
  );
end;
$function$;

revoke all on function public.import_products(text, text, jsonb, boolean) from public, anon;
grant execute on function public.import_products(text, text, jsonb, boolean) to authenticated;
