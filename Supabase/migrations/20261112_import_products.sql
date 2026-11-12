-- =========================================================
-- 1) Istorija uvoza
-- =========================================================
create table if not exists public.import_batches (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null
                  check (kind in ('products', 'object_products', 'opening_balance', 'sales')),
  object_id       uuid references public.objects(id) on delete set null,
  file_name       text not null,
  file_hash       text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  row_count       int  not null check (row_count >= 0),
  inserted_count  int  not null default 0,
  updated_count   int  not null default 0,
  unchanged_count int  not null default 0,
  status          text not null default 'applied' check (status in ('applied', 'reverted')),
  created_by      uuid not null default auth.uid(),
  created_at      timestamptz not null default now(),
  reverted_by     uuid,
  reverted_at     timestamptz
);

create index if not exists idx_import_batches_created
  on public.import_batches (created_at desc);

create unique index if not exists uq_import_batches_sales_file
  on public.import_batches (object_id, file_hash)
  where kind = 'sales' and status = 'applied';

alter table public.import_batches enable row level security;

drop policy if exists "import_batches: admin reads" on public.import_batches;
create policy "import_batches: admin reads" on public.import_batches
  for select using (is_admin());

revoke insert, update, delete on public.import_batches from anon, authenticated;

-- =========================================================
-- 2) Import proizvoda (preview + upis)
-- =========================================================
create or replace function public.import_products(
  p_file_name text,
  p_file_hash text,
  p_rows      jsonb,
  p_dry_run   boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total    int;
  v_errors   jsonb;
  v_rows     jsonb;
  v_new      int;
  v_updated  int;
  v_same     int;
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
    (r.ord + 1)::int                                   as row_no,
    nullif(btrim(r.v->>'sku'), '')                     as sku,
    nullif(btrim(r.v->>'name'), '')                    as name,
    nullif(btrim(r.v->>'category'), '')                as category,
    nullif(regexp_replace(coalesce(r.v->>'barcode', ''), '\s', '', 'g'), '') as barcode,
    lower(nullif(btrim(r.v->>'active'), ''))           as active_raw,
    case lower(nullif(btrim(r.v->>'active'), ''))
      when 'true' then true  when '1' then true  when 'yes' then true
      when 'y'    then true  when 'da' then true
      when 'false' then false when '0' then false when 'no' then false
      when 'n'     then false when 'ne' then false
    end                                                as active
  from jsonb_array_elements(p_rows) with ordinality as r(v, ord);

  with e(row_no, field, message) as (
    select row_no, 'sku', 'SKU is required'
      from _imp where sku is null
    union all
    select row_no, 'name', 'Name is required'
      from _imp where name is null
    union all
    select row_no, 'barcode', 'Barcode must be 8–14 digits'
      from _imp where barcode is not null and barcode !~ '^[0-9]{8,14}$'
    union all
    select row_no, 'active', format('Active must be true/false (got "%s")', active_raw)
      from _imp where active_raw is not null and active is null
    union all
    select row_no, 'sku', format('SKU %s appears more than once in the file', sku)
      from (select row_no, sku, count(*) over (partition by sku) as c
              from _imp where sku is not null) d
     where c > 1
    union all
    select row_no, 'barcode', format('Barcode %s appears more than once in the file', barcode)
      from (select row_no, barcode, count(*) over (partition by barcode) as c
              from _imp where barcode is not null) d
     where c > 1
    union all
    select i.row_no, 'barcode', format('Barcode %s is already used by SKU %s', i.barcode, p.sku)
      from _imp i
      join products p on p.barcode = i.barcode
     where i.sku is distinct from p.sku
  )
  select coalesce(
           jsonb_agg(jsonb_build_object('row', row_no, 'field', field, 'message', message)
                     order by row_no, field),
           '[]'::jsonb)
    into v_errors
    from e;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'row',      i.row_no,
      'sku',      i.sku,
      'action',   a.action,
      'name',     i.name,
      'category', i.category,
      'barcode',  i.barcode,
      'active',   coalesce(i.active, p.active, true),
      'before',   case when a.action = 'update' then jsonb_build_object(
                    'name', p.name, 'category', p.category,
                    'barcode', p.barcode, 'active', p.active) end
    ) order by i.row_no), '[]'::jsonb),
    count(*) filter (where a.action = 'new'),
    count(*) filter (where a.action = 'update'),
    count(*) filter (where a.action = 'unchanged')
  into v_rows, v_new, v_updated, v_same
  from _imp i
  left join products p on p.sku = i.sku
  cross join lateral (
    select case
      when p.id is null then 'new'
      when (p.name, p.category, p.barcode, p.active)
           is distinct from
           (i.name, i.category, i.barcode, coalesce(i.active, p.active)) then 'update'
      else 'unchanged'
    end as action
  ) a;

  if p_dry_run or v_errors <> '[]'::jsonb then
    return jsonb_build_object(
      'ok', v_errors = '[]'::jsonb, 'applied', false, 'dry_run', p_dry_run,
      'total', v_total, 'new', v_new, 'updated', v_updated, 'unchanged', v_same,
      'errors', v_errors, 'rows', v_rows, 'batch_id', null
    );
  end if;

  begin
    update products p
       set name     = i.name,
           category = i.category,
           barcode  = i.barcode,
           active   = coalesce(i.active, p.active)
      from _imp i
     where p.sku = i.sku
       and (p.name, p.category, p.barcode, p.active)
           is distinct from
           (i.name, i.category, i.barcode, coalesce(i.active, p.active));

    insert into products (sku, name, category, barcode, active)
    select i.sku, i.name, i.category, i.barcode, coalesce(i.active, true)
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
    'total', v_total, 'new', v_new, 'updated', v_updated, 'unchanged', v_same,
    'errors', '[]'::jsonb, 'rows', v_rows, 'batch_id', v_batch_id
  );
end;
$$;

revoke all on function public.import_products(text, text, jsonb, boolean) from public, anon;
grant execute on function public.import_products(text, text, jsonb, boolean) to authenticated;
