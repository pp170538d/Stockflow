-- =====================================================================
-- Stockflow · Step 2 · Sales import from the cash register
--
--  1. import_batches      : new kind 'sales'
--  2. helpers             : try_sales_date (YYYY-MM-DD or DD.MM.YYYY)
--  3. set_object_sales_settings RPC : store code + sales source (admin)
--  4. import_sales RPC    : preview (dry run) + all-or-nothing apply
--
-- Rules enforced (agreed earlier):
--  R1  sale date on/before the last stock count of that store  -> error
--  R2  store + day already imported                            -> error
--  R3  store must be on sales_source = 'import'                -> error
--  R5  stock may go negative ONLY here (server flag)           -> warning
--  R8  negative quantity in the file = RETURN
--  R9  unit_price = price actually charged per unit (after discount)
--  +   same file twice (SHA-256)                               -> error
--  +   seller: own store only · demo: preview only
--
-- Run as ONE script in the Supabase SQL editor.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. import_batches.kind accepts 'sales' (works for CHECK or ENUM)
-- ---------------------------------------------------------------------
do $$
declare
  c        record;
  v_type   text;
  v_kinds  text;
begin
  select a.atttypid::regtype::text into v_type
  from pg_attribute a
  where a.attrelid = 'public.import_batches'::regclass and a.attname = 'kind';

  if v_type in ('text', 'character varying') then
    for c in
      select conname from pg_constraint
      where conrelid = 'public.import_batches'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) ilike '%kind%'
    loop
      execute format('alter table public.import_batches drop constraint %I', c.conname);
    end loop;

    select string_agg(quote_literal(k), ', ' order by k) into v_kinds
    from (
      select distinct kind::text as k from public.import_batches
      union
      select unnest(array['products', 'object_products', 'opening_balance', 'sales'])
    ) x;

    execute format(
      'alter table public.import_batches add constraint import_batches_kind_chk check (kind in (%s))',
      v_kinds);
  else
    execute format('alter type %s add value if not exists %L', v_type, 'sales');
  end if;
end $$;

-- Fast "was this store/day already imported?" lookup
create index if not exists stock_movements_import_day_idx
  on public.stock_movements (object_id, occurred_at)
  where import_batch_id is not null;

-- ---------------------------------------------------------------------
-- 2. Date parser: '2026-11-18' or '18.11.2026' / '18.11.2026.'
-- ---------------------------------------------------------------------
create or replace function public.try_sales_date(p text)
returns date language plpgsql immutable as $$
declare
  m text[];
begin
  p := btrim(coalesce(p, ''));
  if p ~ '^\d{4}-\d{2}-\d{2}$' then
    return p::date;
  end if;
  m := regexp_match(p, '^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$');
  if m is not null then
    return make_date(m[3]::int, m[2]::int, m[1]::int);
  end if;
  return null;
exception when others then
  return null;                               -- e.g. 2026-02-30
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Store settings: register code + where sales come from
-- ---------------------------------------------------------------------
create or replace function public.set_object_sales_settings(
  p_object_id uuid, p_code text, p_sales_source text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Only admin can change store settings' using errcode = '42501';
  end if;
  if is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;
  if p_sales_source not in ('manual', 'import') then
    raise exception 'Sales source must be manual or import' using errcode = '22023';
  end if;

  update objects
     set code = nullif(btrim(p_code), ''),
         sales_source = p_sales_source
   where id = p_object_id;

  if not found then
    raise exception 'Store not found' using errcode = 'P0002';
  end if;

  if p_sales_source = 'import'
     and (select code from objects where id = p_object_id) is null then
    raise exception 'A store on register import needs a code (the one used in the register file).'
      using errcode = '22023';
  end if;
exception when unique_violation then
  raise exception 'Another store already uses code "%".', btrim(p_code) using errcode = '23505';
end;
$$;

revoke all on function public.set_object_sales_settings(uuid, text, text) from public, anon;
grant execute on function public.set_object_sales_settings(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. import_sales
--    p_rows: [{ date, location_code, sku_or_barcode, quantity, unit_price }]
--    (aliases accepted: location / store, sku / barcode)
-- ---------------------------------------------------------------------
create or replace function public.import_sales(
  p_rows      jsonb,
  p_file_name text,
  p_file_hash text,
  p_dry_run   boolean default true)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz        text := app_timezone();
  v_today     date := (now() at time zone v_tz)::date;
  v_admin     boolean := is_admin();
  v_demo      boolean := is_demo();
  v_own       uuid;
  v_total     int;
  v_errors    jsonb;
  v_warnings  jsonb;
  v_rows      jsonb;
  v_sales     int;
  v_returns   int;
  v_invalid   int;
  v_units_out int;
  v_units_in  int;
  v_revenue   numeric;
  v_unpriced  int;
  v_groups    int;
  v_batch_id  uuid;
begin
  -- ---------- Access ----------
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not p_dry_run and v_demo then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;
  v_own := case when v_demo then demo_object_id() else auth_object_id() end;

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

  perform pg_advisory_xact_lock(hashtext('stockflow:import_sales'));

  if exists (select 1 from import_batches where kind = 'sales' and file_hash = p_file_hash) then
    raise exception 'This file was already imported.' using errcode = '23505';
  end if;

  -- ---------- Normalize + resolve ----------
  drop table if exists pg_temp._si;
  create temp table _si on commit drop as
  with src as (
    select r.ord::int as row_no, r.val as j
    from jsonb_array_elements(p_rows) with ordinality r(val, ord)
  ),
  n as (
    select row_no,
      nullif(btrim(coalesce(j->>'date', j->>'sale_date')), '')                              as date_txt,
      nullif(btrim(coalesce(j->>'location_code', j->>'location', j->>'store')), '')         as location,
      nullif(btrim(coalesce(j->>'sku_or_barcode', j->>'sku', j->>'barcode')), '')           as code,
      nullif(btrim(j->>'quantity'), '')                                                     as qty_txt,
      nullif(replace(btrim(coalesce(j->>'unit_price', j->>'price')), ',', '.'), '')         as price_txt
    from src
  )
  select n.*,
         try_sales_date(n.date_txt)                                                 as sale_date,
         case when n.qty_txt ~ '^-?\d{1,7}$' then n.qty_txt::int end                as qty,
         case when n.price_txt ~ '^\d{1,10}(\.\d+)?$'
              then round(n.price_txt::numeric, 2) end                               as price,
         o.id as object_id, o.name as object_name, o.active as object_active, o.sales_source,
         p.id as product_id, p.name as product_name, p.sku, p.active as product_active,
         p.sell_price,
         exists (select 1 from object_products op
                  where op.object_id = o.id and op.product_id = p.id)               as assigned
  from n
  left join objects o on lower(o.code) = lower(n.location)
  left join lateral (
    select * from products p
    where p.sku = n.code or p.barcode = n.code
    order by (p.sku = n.code) desc
    limit 1
  ) p on true;

  -- ---------- Errors (block the whole file) ----------
  with e(row_no, field, message) as (
    select row_no, 'location', 'Location code is missing' from _si where location is null
    union all
    select row_no, 'location', format('Unknown location code "%s"', location)
      from _si where location is not null and object_id is null
    union all
    select row_no, 'product', 'SKU / barcode is missing' from _si where code is null
    union all
    select row_no, 'product', format('Unknown SKU / barcode "%s"', code)
      from _si where code is not null and product_id is null
    union all
    select row_no, 'date', format('Invalid date "%s" (use YYYY-MM-DD or DD.MM.YYYY)', coalesce(date_txt, ''))
      from _si where sale_date is null
    union all
    select row_no, 'date', 'Date is in the future'
      from _si where sale_date > v_today
    union all
    select row_no, 'date', 'Date is older than one year'
      from _si where sale_date < v_today - 366
    union all
    select row_no, 'quantity', format('Invalid quantity "%s"', coalesce(qty_txt, ''))
      from _si where qty is null
    union all
    select row_no, 'quantity', 'Quantity cannot be zero' from _si where qty = 0
    union all
    select row_no, 'unit_price', format('Invalid price "%s"', price_txt)
      from _si where price_txt is not null and price is null
    -- access
    union all
    select row_no, 'location', 'You can only import sales for your own store'
      from _si
     where object_id is not null
       and (v_demo or not v_admin)
       and object_id is distinct from v_own
    -- R3
    union all
    select row_no, 'location',
           format('%s records sales manually. Switch it to register import first.', object_name)
      from _si where object_id is not null and sales_source <> 'import'
    -- R2
    union all
    select s.row_no, 'date',
           format('Sales for %s on %s are already imported', s.object_name, to_char(s.sale_date, 'DD.MM.YYYY'))
      from _si s
     where s.object_id is not null and s.sale_date is not null
       and exists (
         select 1 from stock_movements m
           join import_batches b on b.id = m.import_batch_id and b.kind = 'sales'
          where m.object_id = s.object_id
            and m.occurred_at >= (s.sale_date::timestamp at time zone v_tz)
            and m.occurred_at <  ((s.sale_date + 1)::timestamp at time zone v_tz))
    -- R1
    union all
    select s.row_no, 'date',
           format('A stock count in %s was done on or after %s. Import sales before counting.',
                  s.object_name, to_char(s.sale_date, 'DD.MM.YYYY'))
      from _si s
     where s.object_id is not null and s.sale_date is not null
       and exists (
         select 1 from stock_counts sc
          where sc.object_id = s.object_id
            and sc.created_at >= (s.sale_date::timestamp at time zone v_tz))
  )
  select coalesce(jsonb_agg(jsonb_build_object('row', row_no, 'field', field, 'message', message)
                            order by row_no, field), '[]'::jsonb)
    into v_errors
    from e;

  -- ---------- Actions ----------
  drop table if exists pg_temp._si_act;
  create temp table _si_act on commit drop as
  select s.*,
         case
           when exists (select 1 from jsonb_array_elements(v_errors) x
                         where (x->>'row')::int = s.row_no) then 'error'
           when s.qty > 0 then 'sale'
           else 'return'
         end as action,
         coalesce(s.price, s.sell_price) as final_price
  from _si s;

  -- ---------- Warnings (do not block) ----------
  with stock_after as (
    select a.object_id, a.product_id, max(a.object_name) as object_name, max(a.sku) as sku,
           coalesce(max(i.quantity), 0) as on_hand,
           coalesce(max(i.quantity), 0) - sum(a.qty) as after
    from _si_act a
    left join inventory i on i.object_id = a.object_id and i.product_id = a.product_id
    where a.action in ('sale', 'return')
    group by a.object_id, a.product_id
  ),
  w(row_no, message) as (
    select row_no, format('%s is not assigned to %s', sku, object_name)
      from _si_act where action in ('sale', 'return') and not assigned
    union all
    select row_no, format('Product %s is inactive', sku)
      from _si_act where action in ('sale', 'return') and product_active = false
    union all
    select row_no, format('Location %s is inactive', object_name)
      from _si_act where action in ('sale', 'return') and object_active = false
    union all
    select row_no, format('No price in file, product price %s used', sell_price)
      from _si_act where action in ('sale', 'return') and price is null and sell_price is not null
    union all
    select row_no, 'No price in file and no product price: revenue unknown'
      from _si_act where action in ('sale', 'return') and price is null and sell_price is null
    union all
    select (select min(a.row_no) from _si_act a
             where a.object_id = s.object_id and a.product_id = s.product_id),
           format('%s in %s goes negative (%s -> %s). Do a stock count.',
                  s.sku, s.object_name, s.on_hand, s.after)
      from stock_after s where s.after < 0
  )
  select coalesce(jsonb_agg(jsonb_build_object('row', row_no, 'message', message)
                            order by row_no), '[]'::jsonb)
    into v_warnings
    from w;

  -- ---------- Preview ----------
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'row',        row_no,
      'date',       coalesce(to_char(sale_date, 'YYYY-MM-DD'), date_txt),
      'location',   coalesce(object_name, location),
      'sku',        coalesce(sku, code),
      'product',    product_name,
      'quantity',   qty,
      'unit_price', final_price,
      'amount',     case when final_price is not null and qty is not null then qty * final_price end,
      'action',     action
    ) order by row_no), '[]'::jsonb),
    count(*) filter (where action = 'sale'),
    count(*) filter (where action = 'return'),
    count(*) filter (where action = 'error'),
    coalesce(sum(qty)  filter (where action = 'sale'), 0),
    coalesce(sum(-qty) filter (where action = 'return'), 0),
    coalesce(sum(qty * final_price) filter (where action in ('sale', 'return')), 0),
    count(*) filter (where action in ('sale', 'return') and final_price is null)
  into v_rows, v_sales, v_returns, v_invalid, v_units_out, v_units_in, v_revenue, v_unpriced
  from _si_act;

  if p_dry_run or v_errors <> '[]'::jsonb then
    return jsonb_build_object(
      'ok', v_errors = '[]'::jsonb, 'applied', false, 'dry_run', p_dry_run,
      'total', v_total, 'sales', v_sales, 'returns', v_returns, 'invalid', v_invalid,
      'units_sold', v_units_out, 'units_returned', v_units_in,
      'revenue', v_revenue, 'unpriced', v_unpriced, 'currency', app_currency(),
      'errors', v_errors, 'warnings', v_warnings, 'rows', v_rows,
      'batch_id', null, 'movements', 0
    );
  end if;

  -- ---------- Apply (all or nothing) ----------
  -- One ledger row per store + day + product + direction + price.
  select count(*) into v_groups
  from (
    select 1 from _si_act where action in ('sale', 'return')
    group by object_id, product_id, sale_date, action, price
  ) g;

  insert into import_batches
    (kind, file_name, file_hash, row_count, inserted_count, updated_count, unchanged_count)
  values
    ('sales', btrim(p_file_name), p_file_hash, v_total, v_groups, 0, 0)
  returning id into v_batch_id;

  -- R5: the register already sold it -> allow negative, only for this transaction
  perform set_config('stockflow.allow_negative', 'on', true);

  insert into stock_movements
    (object_id, product_id, event, quantity, reference, note, created_by,
     occurred_at, unit_price, import_batch_id)
  select g.object_id, g.product_id,
         case when g.action = 'sale' then 'SALE' else 'RETURN' end::movement_event,
         -g.qty,                                        -- sale: negative, return: positive
         'sales_import:' || v_batch_id,
         'Register import · ' || btrim(p_file_name),
         auth.uid(),
         least(((g.sale_date + 1)::timestamp at time zone v_tz) - interval '1 second', now()),
         g.price,                                       -- null -> guard uses product price
         v_batch_id
  from (
    select object_id, product_id, sale_date, action, price, sum(qty) as qty
    from _si_act
    where action in ('sale', 'return')
    group by object_id, product_id, sale_date, action, price
  ) g
  order by g.object_id, g.product_id, g.sale_date;     -- deterministic lock order

  perform set_config('stockflow.allow_negative', 'off', true);

  return jsonb_build_object(
    'ok', true, 'applied', true, 'dry_run', false,
    'total', v_total, 'sales', v_sales, 'returns', v_returns, 'invalid', 0,
    'units_sold', v_units_out, 'units_returned', v_units_in,
    'revenue', v_revenue, 'unpriced', v_unpriced, 'currency', app_currency(),
    'errors', '[]'::jsonb, 'warnings', v_warnings, 'rows', v_rows,
    'batch_id', v_batch_id, 'movements', v_groups
  );
end;
$$;

revoke all on function public.import_sales(jsonb, text, text, boolean) from public, anon;
grant execute on function public.import_sales(jsonb, text, text, boolean) to authenticated;

commit;

-- =====================================================================
-- Test (SQL editor runs as postgres, so auth.uid() is null -> use the app
-- for the real test; these only check the setup)
-- =====================================================================
-- 1) Give a store a code and switch it to import:
--    update objects set code = 'BG-KNEZ', sales_source = 'import' where name = '<your store>';
-- 2) Date parser:
--    select try_sales_date('2026-11-18'), try_sales_date('18.11.2026.'), try_sales_date('30.02.2026');
--    -- 2026-11-18 | 2026-11-18 | null
-- 3) After an import from the app:
--    select event, quantity, unit_price, unit_cost, occurred_at, import_batch_id
--      from stock_movements where reference like 'sales_import:%' order by created_at desc limit 10;
