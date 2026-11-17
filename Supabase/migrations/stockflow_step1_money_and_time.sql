-- =====================================================================
-- Stockflow · Step 1 · Money + business time on the ledger
--
--  1. products         : cost_price, sell_price
--  2. objects          : code (register location code), sales_source
--  3. company_profile  : currency, timezone (+ currency lock, tz validation)
--  4. stock_movements  : occurred_at, unit_price, unit_cost, currency, import_batch_id
--  5. guard_stock_movement : price/currency snapshot, occurred_at, manual-sale block
--  6. apply_stock_movement : negative stock allowed ONLY behind a server-side flag
--  7. save_company_settings RPC
--
-- Safe to deploy alone: nothing writes an occurred_at different from
-- created_at until the sales import exists (step 2).
-- Run as ONE script in the Supabase SQL editor.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Remember security / search_path of the two trigger functions we
--    replace, so CREATE OR REPLACE does not silently change them.
-- ---------------------------------------------------------------------
create temp table _fn_attrs on commit drop as
select p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig
from pg_proc p
where p.oid in ('public.guard_stock_movement()'::regprocedure,
                'public.apply_stock_movement()'::regprocedure);

-- ---------------------------------------------------------------------
-- 1. Products: base prices (optional, in company currency)
-- ---------------------------------------------------------------------
alter table public.products
  add column if not exists cost_price numeric(12,2),
  add column if not exists sell_price numeric(12,2);

alter table public.products
  drop constraint if exists products_cost_price_chk,
  add  constraint products_cost_price_chk check (cost_price is null or cost_price >= 0),
  drop constraint if exists products_sell_price_chk,
  add  constraint products_sell_price_chk check (sell_price is null or sell_price >= 0);

-- ---------------------------------------------------------------------
-- 2. Objects: code used by the register file + where sales come from
-- ---------------------------------------------------------------------
alter table public.objects
  add column if not exists code text,
  add column if not exists sales_source text not null default 'manual';

alter table public.objects
  drop constraint if exists objects_code_chk,
  add  constraint objects_code_chk check (code is null or code ~ '^[A-Za-z0-9_-]{1,32}$'),
  drop constraint if exists objects_sales_source_chk,
  add  constraint objects_sales_source_chk check (sales_source in ('manual', 'import'));

create unique index if not exists objects_code_uq on public.objects (lower(code)) where code is not null;

-- ---------------------------------------------------------------------
-- 3. Company: currency + timezone
-- ---------------------------------------------------------------------
alter table public.company_profile
  add column if not exists currency text not null default 'RSD',
  add column if not exists timezone text not null default 'Europe/Belgrade';

alter table public.company_profile
  drop constraint if exists company_profile_currency_chk,
  add  constraint company_profile_currency_chk check (currency ~ '^[A-Z]{3}$');

-- Falls back to defaults when the profile row does not exist yet.
create or replace function public.app_currency()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select currency from company_profile where singleton = true), 'RSD');
$$;

create or replace function public.app_timezone()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select timezone from company_profile where singleton = true), 'Europe/Belgrade');
$$;

create or replace function public.guard_company_settings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown timezone "%". Use an IANA name like Europe/Belgrade.', new.timezone
      using errcode = '22023';
  end if;

  -- Amounts are plain numbers in company currency: changing the label
  -- after prices exist would turn 1,200 RSD into 1,200 EUR.
  if tg_op = 'UPDATE' and new.currency is distinct from old.currency
     and exists (select 1 from stock_movements
                  where unit_price is not null or unit_cost is not null) then
    raise exception 'Currency is locked: the ledger already contains prices in %.', old.currency
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_company_settings on public.company_profile;
create trigger trg_guard_company_settings
  before insert or update on public.company_profile
  for each row execute function public.guard_company_settings();

-- ---------------------------------------------------------------------
-- 4. Ledger: business time, price snapshots, import link
-- ---------------------------------------------------------------------
alter table public.stock_movements
  add column if not exists occurred_at     timestamptz,
  add column if not exists unit_price      numeric(12,2),
  add column if not exists unit_cost       numeric(12,2),
  add column if not exists currency        text,
  add column if not exists import_batch_id uuid references public.import_batches(id);

-- Backfill with ledger triggers off: protect_ledger would block it and
-- an UPDATE must never re-apply stock.
alter table public.stock_movements disable trigger user;
update public.stock_movements set occurred_at = created_at where occurred_at is null;
alter table public.stock_movements enable trigger user;

alter table public.stock_movements
  alter column occurred_at set default now(),
  alter column occurred_at set not null;

alter table public.stock_movements
  drop constraint if exists stock_movements_unit_price_chk,
  add  constraint stock_movements_unit_price_chk check (unit_price is null or unit_price >= 0),
  drop constraint if exists stock_movements_unit_cost_chk,
  add  constraint stock_movements_unit_cost_chk  check (unit_cost  is null or unit_cost  >= 0),
  drop constraint if exists stock_movements_currency_chk,
  add  constraint stock_movements_currency_chk   check (currency is null or currency ~ '^[A-Z]{3}$');

create index if not exists stock_movements_obj_prod_occ_idx
  on public.stock_movements (object_id, product_id, occurred_at);
create index if not exists stock_movements_event_occ_idx
  on public.stock_movements (event, occurred_at);
create index if not exists stock_movements_batch_idx
  on public.stock_movements (import_batch_id) where import_batch_id is not null;

-- ---------------------------------------------------------------------
-- 5. Defaults lookup for the guard (definer: works under any RLS)
-- ---------------------------------------------------------------------
create or replace function public.movement_defaults(p_object uuid, p_product uuid)
returns table (object_name text, sales_source text, sell_price numeric, cost_price numeric, currency text)
language sql stable security definer set search_path = public as $$
  select o.name, o.sales_source, p.sell_price, p.cost_price, public.app_currency()
  from objects o, products p
  where o.id = p_object and p.id = p_product;
$$;

revoke all on function public.movement_defaults(uuid, uuid) from public, anon;
grant execute on function public.movement_defaults(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. guard_stock_movement (existing rules kept 1:1, new rules marked NEW)
-- ---------------------------------------------------------------------
create or replace function public.guard_stock_movement()
returns trigger language plpgsql as $$
declare
  d record;
begin
  if new.quantity is null or new.quantity = 0 then
    raise exception 'Movement quantity cannot be zero.';
  end if;

  -- Sign rules
  if new.event in ('SALE', 'WRITE_OFF') and new.quantity > 0 then
    raise exception '% must be a negative quantity.', new.event;
  end if;
  if new.event in ('DELIVERY', 'RETURN') and new.quantity < 0 then
    raise exception '% must be a positive quantity.', new.event;
  end if;

  -- Every manual adjustment must be explained.
  if new.event = 'ADJUSTMENT'
     and nullif(trim(coalesce(new.note, '')), '') is null then
    raise exception 'A reason is required for an adjustment.';
  end if;

  if public.is_direct_api_call() then
    -- NEW: the negative-stock flag can never be on for a client write.
    perform set_config('stockflow.allow_negative', 'off', true);

    perform public.assert_object_access(new.object_id);

    if new.event in ('DELIVERY', 'STOCK_COUNT', 'TRANSFER') then
      raise exception using errcode = '42501',
        message = format('%s can only be recorded through its workflow.', new.event);
    end if;

    if new.event = 'ADJUSTMENT' and not public.is_admin() then
      raise exception using errcode = '42501',
        message = 'Only admins can record adjustments. Use a stock count instead.';
    end if;

    -- Client may not forge timestamps, prices or import links.
    new.created_at      := now();
    new.occurred_at     := now();          -- NEW
    new.unit_price      := null;           -- NEW: server decides the price
    new.unit_cost       := null;           -- NEW
    new.import_batch_id := null;           -- NEW
  end if;

  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;

  -- NEW: business time
  new.occurred_at := coalesce(new.occurred_at, new.created_at, now());
  if new.occurred_at > now() + interval '5 minutes' then
    raise exception 'Movement date cannot be in the future.' using errcode = '22023';
  end if;

  select * into d from public.movement_defaults(new.object_id, new.product_id);

  -- NEW: a store fed by the register import cannot also record sales by hand
  -- (that would count the same sale twice).
  if new.event in ('SALE', 'RETURN')
     and d.sales_source = 'import'
     and new.import_batch_id is null then
    raise exception using errcode = '42501',
      message = format('%s takes sales from the register import. Manual sales and returns are disabled.',
                       d.object_name);
  end if;

  -- NEW: price snapshots, frozen forever on the ledger row
  if new.event in ('SALE', 'RETURN') then
    new.unit_price := coalesce(new.unit_price, d.sell_price);
  else
    new.unit_price := null;
  end if;
  new.unit_cost := coalesce(new.unit_cost, d.cost_price);
  new.currency  := case when new.unit_price is not null or new.unit_cost is not null
                        then d.currency end;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. apply_stock_movement: negative stock only behind the server flag
--    (set by the sales import in step 2, never reachable from the client)
-- ---------------------------------------------------------------------
create or replace function public.apply_stock_movement()
returns trigger language plpgsql as $$
declare
  v_current int;
  v_result  int;
begin
  insert into public.inventory (object_id, product_id, quantity, updated_at)
  values (new.object_id, new.product_id, 0, now())
  on conflict (object_id, product_id) do nothing;

  select quantity into v_current
  from public.inventory
  where object_id = new.object_id and product_id = new.product_id
  for update;

  v_result := v_current + new.quantity;

  if v_result < 0
     and coalesce(current_setting('stockflow.allow_negative', true), 'off') <> 'on' then
    -- message kept identical: the frontend matches on 'Insufficient stock'
    raise exception
      'Insufficient stock: % on hand, % of % would result in %.',
      v_current, new.quantity, new.event, v_result;
  end if;

  update public.inventory
  set quantity = v_result, updated_at = now()
  where object_id = new.object_id and product_id = new.product_id;

  return new;
end;
$$;

-- Restore the original security mode / search_path of both functions.
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

-- A CHECK (quantity >= 0) on inventory would block the import path.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.inventory'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%quantity >= 0%'
  loop
    execute format('alter table public.inventory drop constraint %I', c.conname);
    raise notice 'Dropped inventory constraint %', c.conname;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 8. RPC: company currency + timezone (Settings screen)
-- ---------------------------------------------------------------------
create or replace function public.save_company_settings(p_currency text, p_timezone text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Only admin can change company settings' using errcode = '42501';
  end if;
  if is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;
  if not exists (select 1 from company_profile where singleton = true) then
    raise exception 'Save the company profile first.' using errcode = '22023';
  end if;

  update company_profile
     set currency   = upper(btrim(p_currency)),
         timezone   = btrim(p_timezone),
         updated_by = auth.uid(),
         updated_at = now()
   where singleton = true;
end;
$$;

revoke all on function public.save_company_settings(text, text) from public, anon;
grant execute on function public.save_company_settings(text, text) to authenticated;

commit;

-- =====================================================================
-- Checks (run after the migration)
-- =====================================================================
-- 1) No ledger row without business time:
--    select count(*) from stock_movements where occurred_at is null;            -- 0
-- 2) Trigger functions kept their security mode:
--    select proname, prosecdef, proconfig from pg_proc
--     where proname in ('guard_stock_movement','apply_stock_movement');
-- 3) Price snapshot works (as a seller, from the app): record a manual sale
--    for a product with sell_price set, then:
--    select event, quantity, unit_price, unit_cost, currency, occurred_at
--      from stock_movements order by created_at desc limit 1;
-- 4) Negative stock still blocked for the client:
--    sell more than on hand from the app -> 'Insufficient stock ...'
