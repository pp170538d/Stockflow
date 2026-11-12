-- =========================================================
-- Opening balance import
-- Uses the existing record_stock_count(), so the import follows
-- the same rules as a manual stock count:
--   * stock is never written directly to inventory
--   * every difference becomes a STOCK_COUNT movement
--   * the import shows up in Count history
-- =========================================================

-- Which stock counts were created by an import
alter table public.import_batches
  add column if not exists count_ids uuid[] not null default '{}';

create or replace function public.import_opening_balance(
  p_file_name text,
  p_file_hash text,
  p_rows      jsonb,
  p_dry_run   boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total     int;
  v_errors    jsonb;
  v_warnings  jsonb;
  v_rows      jsonb;
  v_increase  int;
  v_decrease  int;
  v_same      int;
  v_invalid   int;
  v_units_in  int;
  v_units_out int;
  v_batch_id  uuid;
  v_obj       record;
  v_count_id  uuid;
  v_count_ids uuid[] := '{}';
begin
  -- ---------- Access ----------
  if not is_admin() then
    raise exception 'Only admin can import opening balances' using errcode = '42501';
  end if;
  if not p_dry_run and is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;

  -- ---------- Input ----------
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total = 0 then
    raise exception 'File has no data rows' using errcode = '22023';
  end if;
  if v_total > 20000 then
    raise exception 'Max 20000 rows per import (got %)', v_total using errcode = '22023';
  end if;
  if coalesce(btrim(p_file_name), '') = '' then
    raise exception 'File name is required' using errcode = '22023';
  end if;
  if p_file_hash is null or p_file_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid file hash (expected SHA-256 hex)' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('stockflow:import_opening_balance'));

  -- ---------- Normalize + resolve ----------
  drop table if exists pg_temp._ob;
  create temp table _ob on commit drop as
  with src as (
    select
      (r.ord + 1)::int                     as row_no,
      nullif(btrim(r.v->>'location'), '')  as location,
      nullif(btrim(r.v->>'sku'), '')       as sku,
      nullif(btrim(r.v->>'quantity'), '')  as qty_raw
    from jsonb_array_elements(p_rows) with ordinality as r(v, ord)
  )
  select
    s.*,
    case when s.qty_raw ~ '^[0-9]{1,9}$' then s.qty_raw::int end as qty,
    o.id     as object_id,
    o.name   as object_name,
    o.active as object_active,
    p.id     as product_id,
    p.name   as product_name,
    p.active as product_active,
    (op.id is not null)       as assigned,
    coalesce(inv.qty, 0)::int as on_hand
  from src s
  left join objects  o on lower(btrim(o.name)) = lower(s.location)
  left join products p on p.sku = s.sku
  left join object_products op on op.object_id = o.id and op.product_id = p.id
  left join lateral (
    select sum(i.quantity) as qty
      from inventory i
     where i.object_id = o.id and i.product_id = p.id
  ) inv on true;

  -- ---------- Errors ----------
  with e(row_no, field, message) as (
    select row_no, 'location', 'Location is required'
      from _ob where location is null
    union all
    select row_no, 'sku', 'SKU is required'
      from _ob where sku is null
    union all
    select row_no, 'quantity', 'Quantity is required'
      from _ob where qty_raw is null
    union all
    select row_no, 'location', format('Location "%s" does not exist', location)
      from _ob where location is not null and object_id is null
    union all
    select row_no, 'sku', format('SKU %s does not exist', sku)
      from _ob where sku is not null and product_id is null
    union all
    select row_no, 'quantity', format('Quantity must be a whole number, 0 or more (got "%s")', qty_raw)
      from _ob where qty_raw is not null and qty is null
    union all
    select row_no, 'sku',
           format('%s is not assigned to %s. Assign it in the Assignments tab first.', sku, object_name)
      from _ob where object_id is not null and product_id is not null and not assigned
    union all
    select row_no, 'sku', format('%s at %s appears more than once in the file', sku, object_name)
      from (select row_no, sku, object_name,
                   count(*) over (partition by object_id, product_id) as c
              from _ob where object_id is not null and product_id is not null) d
     where c > 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('row', row_no, 'field', field, 'message', message)
                            order by row_no, field), '[]'::jsonb)
    into v_errors
    from e;

  -- ---------- Actions ----------
  drop table if exists pg_temp._ob_act;
  create temp table _ob_act on commit drop as
  select o.*,
    case
      when exists (select 1 from jsonb_array_elements(v_errors) x
                    where (x->>'row')::int = o.row_no) then 'error'
      when o.qty > o.on_hand then 'increase'
      when o.qty < o.on_hand then 'decrease'
      else 'unchanged'
    end as action
  from _ob o;

  -- ---------- Warnings (do not block) ----------
  with w(row_no, message) as (
    select row_no, format('Stock goes down from %s to %s', on_hand, qty)
      from _ob_act where action = 'decrease'
    union all
    select row_no, format('Location %s is inactive', object_name)
      from _ob_act where action in ('increase', 'decrease') and object_active = false
    union all
    select row_no, format('Product %s is inactive', sku)
      from _ob_act where action in ('increase', 'decrease') and product_active = false
  )
  select coalesce(jsonb_agg(jsonb_build_object('row', row_no, 'message', message)
                            order by row_no), '[]'::jsonb)
    into v_warnings
    from w;

  -- ---------- Preview ----------
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'row',      row_no,
      'location', coalesce(object_name, location),
      'sku',      sku,
      'product',  product_name,
      'on_hand',  on_hand,
      'quantity', qty,
      'diff',     case when qty is not null then qty - on_hand end,
      'action',   action
    ) order by row_no), '[]'::jsonb),
    count(*) filter (where action = 'increase'),
    count(*) filter (where action = 'decrease'),
    count(*) filter (where action = 'unchanged'),
    count(*) filter (where action = 'error'),
    coalesce(sum(qty - on_hand) filter (where action = 'increase'), 0),
    coalesce(sum(on_hand - qty) filter (where action = 'decrease'), 0)
  into v_rows, v_increase, v_decrease, v_same, v_invalid, v_units_in, v_units_out
  from _ob_act;

  if p_dry_run or v_errors <> '[]'::jsonb then
    return jsonb_build_object(
      'ok', v_errors = '[]'::jsonb, 'applied', false, 'dry_run', p_dry_run,
      'total', v_total, 'increase', v_increase, 'decrease', v_decrease,
      'unchanged', v_same, 'invalid', v_invalid,
      'units_in', v_units_in, 'units_out', v_units_out,
      'errors', v_errors, 'warnings', v_warnings, 'rows', v_rows,
      'batch_id', null, 'counts', 0
    );
  end if;

  if v_increase + v_decrease = 0 then
    raise exception 'Nothing to import: stock already matches the file' using errcode = '22023';
  end if;

  -- ---------- Apply (all or nothing) ----------
  insert into import_batches
    (kind, file_name, file_hash, row_count, inserted_count, updated_count, unchanged_count)
  values
    ('opening_balance', btrim(p_file_name), p_file_hash, v_total, 0, v_increase + v_decrease, v_same)
  returning id into v_batch_id;

  -- One stock count per location that has at least one change.
  -- All rows of that location go in, so the count is a real, complete record.
  -- record_stock_count re-reads stock with FOR UPDATE, so the final numbers
  -- always match the file, even if stock moved after the preview.
  for v_obj in
    select object_id,
           jsonb_agg(jsonb_build_object(
             'product_id',  product_id,
             'counted_qty', qty,
             'reason',      'Opening balance'
           ) order by product_id) as items   -- fixed order = no deadlocks
      from _ob_act
     group by object_id
    having bool_or(action in ('increase', 'decrease'))
     order by object_id
  loop
    v_count_id := public.record_stock_count(
      v_obj.object_id,
      'Import: ' || btrim(p_file_name),
      'Opening balance · ' || btrim(p_file_name),
      v_obj.items
    );
    v_count_ids := v_count_ids || v_count_id;
  end loop;

  update import_batches set count_ids = v_count_ids where id = v_batch_id;

  return jsonb_build_object(
    'ok', true, 'applied', true, 'dry_run', false,
    'total', v_total, 'increase', v_increase, 'decrease', v_decrease,
    'unchanged', v_same, 'invalid', 0,
    'units_in', v_units_in, 'units_out', v_units_out,
    'errors', '[]'::jsonb, 'warnings', v_warnings, 'rows', v_rows,
    'batch_id', v_batch_id, 'counts', coalesce(array_length(v_count_ids, 1), 0)
  );
end;
$$;

revoke all on function public.import_opening_balance(text, text, jsonb, boolean) from public, anon;
grant execute on function public.import_opening_balance(text, text, jsonb, boolean) to authenticated;
