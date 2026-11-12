-- =========================================================
-- 1) Naziv lokacije je jedinstven (Corner Store = corner store)
-- =========================================================
create unique index if not exists objects_name_key
  on public.objects (lower(btrim(name)));

-- =========================================================
-- 2) Istorija: broj uklonjenih dodela
-- =========================================================
alter table public.import_batches
  add column if not exists removed_count int not null default 0;

-- =========================================================
-- 3) Import dodela proizvoda lokacijama
-- =========================================================
create or replace function public.import_object_products(
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
  v_warnings jsonb;
  v_rows     jsonb;
  v_add      int;
  v_remove   int;
  v_same     int;
  v_invalid  int;
  v_batch_id uuid;
begin
  -- ---------- Pristup ----------
  if not is_admin() then
    raise exception 'Only admin can import assignments' using errcode = '42501';
  end if;
  if not p_dry_run and is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;

  -- ---------- Ulaz ----------
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

  perform pg_advisory_xact_lock(hashtext('stockflow:import_object_products'));

  -- ---------- Normalizacija + povezivanje ----------
  drop table if exists pg_temp._ia;
  create temp table _ia on commit drop as
  with src as (
    select
      (r.ord + 1)::int                          as row_no,
      nullif(btrim(r.v->>'location'), '')       as location,
      nullif(btrim(r.v->>'sku'), '')            as sku,
      lower(nullif(btrim(r.v->>'assigned'), '')) as assigned_raw,
      -- prazno = yes (fajl sa samo Location + SKU znači "dodeli")
      case lower(coalesce(nullif(btrim(r.v->>'assigned'), ''), 'yes'))
        when 'yes' then true  when 'y' then true  when 'true' then true
        when '1'   then true  when 'da' then true
        when 'no'  then false when 'n' then false when 'false' then false
        when '0'   then false when 'ne' then false
      end                                       as assigned
    from jsonb_array_elements(p_rows) with ordinality as r(v, ord)
  )
  select
    s.*,
    o.id     as object_id,
    o.name   as object_name,
    o.active as object_active,
    p.id     as product_id,
    p.name   as product_name,
    p.active as product_active,
    (op.id is not null)         as currently_assigned,
    coalesce(inv.qty, 0)::int   as on_hand
  from src s
  left join objects  o on lower(btrim(o.name)) = lower(s.location)
  left join products p on p.sku = s.sku
  left join object_products op on op.object_id = o.id and op.product_id = p.id
  left join lateral (
    select sum(i.quantity) as qty
      from inventory i
     where i.object_id = o.id and i.product_id = p.id
  ) inv on true;

  -- ---------- Greške ----------
  with e(row_no, field, message) as (
    select row_no, 'location', 'Location is required'
      from _ia where location is null
    union all
    select row_no, 'sku', 'SKU is required'
      from _ia where sku is null
    union all
    select row_no, 'location', format('Location "%s" does not exist', location)
      from _ia where location is not null and object_id is null
    union all
    select row_no, 'sku', format('SKU %s does not exist', sku)
      from _ia where sku is not null and product_id is null
    union all
    select row_no, 'assigned', format('Assigned must be yes/no (got "%s")', assigned_raw)
      from _ia where assigned is null
    union all
    select row_no, 'sku', format('%s at %s appears more than once in the file', sku, location)
      from (select row_no, sku, location,
                   count(*) over (partition by lower(location), sku) as c
              from _ia where location is not null and sku is not null) d
     where c > 1
    union all
    select row_no, 'assigned',
           format('Can''t unassign: %s has %s units at %s. Write off or move the stock first.',
                  sku, on_hand, object_name)
      from _ia
     where assigned = false and currently_assigned and on_hand <> 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('row', row_no, 'field', field, 'message', message)
                            order by row_no, field), '[]'::jsonb)
    into v_errors
    from e;

  -- ---------- Akcije ----------
  drop table if exists pg_temp._ia_act;
  create temp table _ia_act on commit drop as
  select i.*,
    case
      when exists (select 1 from jsonb_array_elements(v_errors) x
                    where (x->>'row')::int = i.row_no)        then 'error'
      when i.assigned and not i.currently_assigned            then 'add'
      when not i.assigned and i.currently_assigned            then 'remove'
      else 'unchanged'
    end as action
  from _ia i;

  -- ---------- Upozorenja (ne blokiraju import) ----------
  with w(row_no, message) as (
    select row_no, format('Product %s is inactive', sku)
      from _ia_act where action = 'add' and product_active = false
    union all
    select row_no, format('Location %s is inactive', object_name)
      from _ia_act where action = 'add' and object_active = false
  )
  select coalesce(jsonb_agg(jsonb_build_object('row', row_no, 'message', message)
                            order by row_no), '[]'::jsonb)
    into v_warnings
    from w;

  -- ---------- Preview ----------
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'row',       row_no,
      'location',  coalesce(object_name, location),
      'sku',       sku,
      'product',   product_name,
      'assigned',  assigned,
      'on_hand',   on_hand,
      'action',    action
    ) order by row_no), '[]'::jsonb),
    count(*) filter (where action = 'add'),
    count(*) filter (where action = 'remove'),
    count(*) filter (where action = 'unchanged'),
    count(*) filter (where action = 'error')
  into v_rows, v_add, v_remove, v_same, v_invalid
  from _ia_act;

  if p_dry_run or v_errors <> '[]'::jsonb then
    return jsonb_build_object(
      'ok', v_errors = '[]'::jsonb, 'applied', false, 'dry_run', p_dry_run,
      'total', v_total, 'add', v_add, 'remove', v_remove,
      'unchanged', v_same, 'invalid', v_invalid,
      'errors', v_errors, 'warnings', v_warnings, 'rows', v_rows, 'batch_id', null
    );
  end if;

  -- ---------- Upis (sve ili ništa) ----------
  -- Zaključaj dodele koje se uklanjaju, pa ponovo proveri stanje
  -- (neko je mogao da primi robu između preview-a i importa)
  perform 1
    from object_products op
    join _ia_act a on a.object_id = op.object_id and a.product_id = op.product_id
   where a.action = 'remove'
     for update of op;

  if exists (
    select 1
      from _ia_act a
      join inventory i on i.object_id = a.object_id and i.product_id = a.product_id
     where a.action = 'remove' and i.quantity <> 0
  ) then
    raise exception 'Stock changed during import. Run preview again.' using errcode = '40001';
  end if;

  delete from object_products op
   using _ia_act a
   where a.action = 'remove'
     and op.object_id = a.object_id
     and op.product_id = a.product_id;
  get diagnostics v_remove = row_count;

  insert into object_products (object_id, product_id)
  select object_id, product_id from _ia_act where action = 'add'
  on conflict (object_id, product_id) do nothing;
  get diagnostics v_add = row_count;

  insert into import_batches
    (kind, file_name, file_hash, row_count, inserted_count, removed_count, unchanged_count)
  values
    ('object_products', btrim(p_file_name), p_file_hash, v_total, v_add, v_remove, v_same)
  returning id into v_batch_id;

  return jsonb_build_object(
    'ok', true, 'applied', true, 'dry_run', false,
    'total', v_total, 'add', v_add, 'remove', v_remove,
    'unchanged', v_same, 'invalid', 0,
    'errors', '[]'::jsonb, 'warnings', v_warnings, 'rows', v_rows, 'batch_id', v_batch_id
  );
end;
$$;

revoke all on function public.import_object_products(text, text, jsonb, boolean) from public, anon;
grant execute on function public.import_object_products(text, text, jsonb, boolean) to authenticated;