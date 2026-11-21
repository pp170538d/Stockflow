-- =====================================================================
-- Stockflow · Step 10 · Goods receipt (GRN) + delivery discrepancy resolution
--
--  1. deliveries.delivery_number   GRN-2026-000001 (backfilled, then automatic)
--  2. orders.parent_order_id       links a backorder to its original order
--  3. delivery_items resolution    open -> resolved (decision, who, when, note)
--  4. guard_stock_movement         knows SUPPLIER_RETURN (negative, workflow only)
--  5. resolve_delivery_line()      Backorder / Close short / Claim / Accept / Return
--  6. delivery_exceptions()        list for "Needs resolution" + GRN screen
--
-- PREREQUISITE (separate query, already done in the previous step):
--   alter type public.movement_event add value if not exists 'SUPPLIER_RETURN';
--
-- Run as ONE script in the Supabase SQL editor.
-- =====================================================================

do $$
begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'movement_event' and e.enumlabel = 'SUPPLIER_RETURN'
  ) then
    raise exception 'Run this first, as a separate query: alter type public.movement_event add value if not exists ''SUPPLIER_RETURN'';';
  end if;
end $$;

begin;

-- ---------------------------------------------------------------------
-- 1. Goods receipt number
-- ---------------------------------------------------------------------
alter table public.deliveries add column if not exists delivery_number text;

create sequence if not exists public.delivery_number_seq;

with n as (
  select id,
         row_number() over (order by coalesce(delivered_at, created_at), id) as rn,
         to_char(coalesce(delivered_at, created_at) at time zone app_timezone(), 'YYYY') as y
  from public.deliveries
  where delivery_number is null
)
update public.deliveries d
set delivery_number = 'GRN-' || n.y || '-' || lpad(n.rn::text, 6, '0')
from n
where n.id = d.id;

select setval(
  'public.delivery_number_seq',
  greatest((select count(*) from public.deliveries), 1),
  (select count(*) from public.deliveries) > 0
);

create unique index if not exists deliveries_delivery_number_uq
  on public.deliveries (delivery_number);

create or replace function public.set_delivery_number()
returns trigger language plpgsql as $$
begin
  if new.delivery_number is null then
    new.delivery_number := 'GRN-'
      || to_char(now() at time zone app_timezone(), 'YYYY') || '-'
      || lpad(nextval('public.delivery_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_delivery_number on public.deliveries;
create trigger trg_set_delivery_number
  before insert on public.deliveries
  for each row execute function public.set_delivery_number();

-- ---------------------------------------------------------------------
-- 2. Backorder link
-- ---------------------------------------------------------------------
alter table public.orders
  add column if not exists parent_order_id uuid references public.orders(id);

create index if not exists orders_parent_order_idx
  on public.orders (parent_order_id) where parent_order_id is not null;

-- ---------------------------------------------------------------------
-- 3. Resolution state on each received line
-- ---------------------------------------------------------------------
alter table public.delivery_items
  add column if not exists resolution_status  text,
  add column if not exists resolution         text,
  add column if not exists resolution_note    text,
  add column if not exists resolved_by        uuid,
  add column if not exists resolved_at        timestamptz,
  add column if not exists backorder_id       uuid references public.orders(id),
  add column if not exists return_movement_id uuid;

alter table public.delivery_items
  drop constraint if exists delivery_items_resolution_status_chk,
  add  constraint delivery_items_resolution_status_chk
       check (resolution_status is null or resolution_status in ('open', 'resolved')),
  drop constraint if exists delivery_items_resolution_chk,
  add  constraint delivery_items_resolution_chk
       check (resolution is null or resolution in
              ('BACKORDER', 'CLOSE_SHORT', 'CLAIM', 'ACCEPT', 'RETURN_TO_SUPPLIER'));

-- Every existing line with a difference starts as open
update public.delivery_items di
set resolution_status = 'open'
from public.order_items oi
where oi.id = di.order_item_id
  and di.delivered_qty <> oi.quantity
  and di.resolution_status is null;

create index if not exists delivery_items_open_idx
  on public.delivery_items (delivery_id) where resolution_status = 'open';

-- New deliveries: a line with a difference opens automatically
create or replace function public.open_delivery_discrepancy()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ordered int;
begin
  select quantity into v_ordered from public.order_items where id = new.order_item_id;
  if new.resolution_status is null and v_ordered is not null and new.delivered_qty <> v_ordered then
    new.resolution_status := 'open';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_open_delivery_discrepancy on public.delivery_items;
create trigger trg_open_delivery_discrepancy
  before insert on public.delivery_items
  for each row execute function public.open_delivery_discrepancy();

-- ---------------------------------------------------------------------
-- 4. guard_stock_movement: add SUPPLIER_RETURN
--    (same rules as step 1, keeps the function's security settings)
-- ---------------------------------------------------------------------
create temp table _fn_attrs on commit drop as
select p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig
from pg_proc p
where p.oid = 'public.guard_stock_movement()'::regprocedure;

create or replace function public.guard_stock_movement()
returns trigger language plpgsql as $$
declare
  d record;
begin
  if new.quantity is null or new.quantity = 0 then
    raise exception 'Movement quantity cannot be zero.';
  end if;

  if new.event in ('SALE', 'WRITE_OFF', 'SUPPLIER_RETURN') and new.quantity > 0 then
    raise exception '% must be a negative quantity.', new.event;
  end if;
  if new.event in ('DELIVERY', 'RETURN') and new.quantity < 0 then
    raise exception '% must be a positive quantity.', new.event;
  end if;

  if new.event = 'ADJUSTMENT'
     and nullif(trim(coalesce(new.note, '')), '') is null then
    raise exception 'A reason is required for an adjustment.';
  end if;

  if public.is_direct_api_call() then
    perform set_config('stockflow.allow_negative', 'off', true);
    perform public.assert_object_access(new.object_id);

    if new.event in ('DELIVERY', 'STOCK_COUNT', 'TRANSFER', 'SUPPLIER_RETURN') then
      raise exception using errcode = '42501',
        message = format('%s can only be recorded through its workflow.', new.event);
    end if;

    if new.event = 'ADJUSTMENT' and not public.is_admin() then
      raise exception using errcode = '42501',
        message = 'Only admins can record adjustments. Use a stock count instead.';
    end if;

    new.created_at      := now();
    new.occurred_at     := now();
    new.unit_price      := null;
    new.unit_cost       := null;
    new.import_batch_id := null;
  end if;

  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;

  new.occurred_at := coalesce(new.occurred_at, new.created_at, now());
  if new.occurred_at > now() + interval '5 minutes' then
    raise exception 'Movement date cannot be in the future.' using errcode = '22023';
  end if;

  select * into d from public.movement_defaults(new.object_id, new.product_id);

  if new.event in ('SALE', 'RETURN')
     and d.sales_source = 'import'
     and new.import_batch_id is null then
    raise exception using errcode = '42501',
      message = format('%s takes sales from the register import. Manual sales and returns are disabled.',
                       d.object_name);
  end if;

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
-- 5. Resolve one discrepancy line
--
--   short (received < ordered): BACKORDER | CLOSE_SHORT | CLAIM
--   over  (received > ordered): ACCEPT | RETURN_TO_SUPPLIER | CLAIM
-- ---------------------------------------------------------------------
create or replace function public.resolve_delivery_line(
  p_line_id    uuid,
  p_resolution text,
  p_note       text default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_res          text := upper(btrim(coalesce(p_resolution, '')));
  v_note         text := nullif(btrim(coalesce(p_note, '')), '');
  v_line         record;
  v_diff         int;
  v_backorder_id uuid;
  v_backorder_no text;
  v_movement_id  uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not is_admin() then
    raise exception 'Only admins can resolve delivery differences' using errcode = '42501';
  end if;
  if is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;

  select di.id, di.product_id, di.delivered_qty, di.resolution_status,
         oi.quantity as ordered_qty,
         d.id as delivery_id, d.delivery_number, d.object_id,
         o.id as order_id, o.order_number, o.supplier_id
    into v_line
  from public.delivery_items di
  join public.order_items oi on oi.id = di.order_item_id
  join public.deliveries d   on d.id = di.delivery_id
  join public.orders o       on o.id = d.order_id
  where di.id = p_line_id
  for update of di;

  if not found then
    raise exception 'Delivery line not found' using errcode = 'P0002';
  end if;

  v_diff := v_line.delivered_qty - v_line.ordered_qty;

  if v_diff = 0 then
    raise exception 'This line was delivered exactly as ordered.' using errcode = '22023';
  end if;
  if coalesce(v_line.resolution_status, 'open') <> 'open' then
    raise exception 'This difference is already resolved.' using errcode = '22023';
  end if;

  if v_diff < 0 and v_res not in ('BACKORDER', 'CLOSE_SHORT', 'CLAIM') then
    raise exception 'A short delivery can be: backorder, close short or claim.' using errcode = '22023';
  end if;
  if v_diff > 0 and v_res not in ('ACCEPT', 'RETURN_TO_SUPPLIER', 'CLAIM') then
    raise exception 'An over delivery can be: accept, return to supplier or claim.' using errcode = '22023';
  end if;
  if v_res = 'CLAIM' and v_note is null then
    raise exception 'Add a note for the claim (claim number, agreement…).' using errcode = '22023';
  end if;

  -- Backorder: new order for the missing units, same supplier, approved
  if v_res = 'BACKORDER' then
    insert into public.orders (object_id, status, comment, created_by, supplier_id, parent_order_id)
    values (v_line.object_id, 'PENDING',
            format('Backorder for %s · %s', v_line.order_number, v_line.delivery_number),
            auth.uid(), v_line.supplier_id, v_line.order_id)
    returning id into v_backorder_id;

    insert into public.order_items (order_id, product_id, quantity)
    values (v_backorder_id, v_line.product_id, -v_diff);

    -- Goes through the normal approval path (snapshots, approved_by…)
    update public.orders set status = 'APPROVED' where id = v_backorder_id;

    select order_number into v_backorder_no from public.orders where id = v_backorder_id;
  end if;

  -- Return to supplier: take the extra units off the shelf
  if v_res = 'RETURN_TO_SUPPLIER' then
    insert into public.stock_movements
      (object_id, product_id, event, quantity, reference, note, created_by)
    values (v_line.object_id, v_line.product_id, 'SUPPLIER_RETURN', -v_diff,
            'grn:' || v_line.delivery_id,
            coalesce(v_note, 'Returned to supplier · ' || v_line.delivery_number),
            auth.uid())
    returning id into v_movement_id;
  end if;

  update public.delivery_items
  set resolution_status  = 'resolved',
      resolution         = v_res,
      resolution_note    = v_note,
      resolved_by        = auth.uid(),
      resolved_at        = now(),
      backorder_id       = v_backorder_id,
      return_movement_id = v_movement_id
  where id = p_line_id;

  return jsonb_build_object(
    'line_id', p_line_id,
    'resolution', v_res,
    'backorder_id', v_backorder_id,
    'backorder_number', v_backorder_no,
    'return_movement_id', v_movement_id
  );
end;
$$;

revoke all on function public.resolve_delivery_line(uuid, text, text) from public, anon;
grant execute on function public.resolve_delivery_line(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Discrepancy list (Orders "Needs resolution", GRN screen, Dashboard)
--    p_status: 'open' | 'resolved' | null (= all)
-- ---------------------------------------------------------------------
create or replace function public.delivery_exceptions(
  p_status      text default 'open',
  p_object_id   uuid default null,
  p_delivery_id uuid default null
)
returns table (
  line_id           uuid,
  delivery_id       uuid,
  delivery_number   text,
  delivered_at      timestamptz,
  received_by       text,
  order_id          uuid,
  order_number      text,
  supplier_name     text,
  object_id         uuid,
  object_name       text,
  product_id        uuid,
  sku               text,
  product_name      text,
  ordered_qty       int,
  delivered_qty     int,
  variance          int,
  reason_code       text,
  reason            text,
  variance_value    numeric,
  resolution_status text,
  resolution        text,
  resolution_note   text,
  resolved_at       timestamptz,
  backorder_id      uuid,
  backorder_number  text
)
language sql stable security invoker set search_path = public as $$
  select di.id, d.id, d.delivery_number, d.delivered_at, d.received_by,
         o.id, o.order_number, o.supplier_snapshot->>'name',
         d.object_id, ob.name,
         di.product_id, p.sku, p.name,
         oi.quantity, di.delivered_qty, di.delivered_qty - oi.quantity,
         di.reason_code, di.reason,
         case when p.cost_price is not null
              then round(abs(di.delivered_qty - oi.quantity) * p.cost_price, 2) end,
         di.resolution_status, di.resolution, di.resolution_note, di.resolved_at,
         di.backorder_id, bo.order_number
  from delivery_items di
  join order_items oi on oi.id = di.order_item_id
  join deliveries d   on d.id = di.delivery_id
  join orders o       on o.id = d.order_id
  join objects ob     on ob.id = d.object_id
  join products p     on p.id = di.product_id
  left join orders bo on bo.id = di.backorder_id
  where di.delivered_qty <> oi.quantity
    and (p_status is null or di.resolution_status = p_status)
    and (p_object_id is null or d.object_id = p_object_id)
    and (p_delivery_id is null or d.id = p_delivery_id)
  order by d.delivered_at desc, p.name;
$$;

revoke all on function public.delivery_exceptions(text, uuid, uuid) from public, anon;
grant execute on function public.delivery_exceptions(text, uuid, uuid) to authenticated;

commit;

-- =====================================================================
-- Checks
-- =====================================================================
-- 1) Every delivery has a number:
--    select delivery_number, delivered_at from deliveries order by delivered_at;
-- 2) Open differences (should match the "Exceptions" filter in Orders):
select delivery_number, order_number, sku, ordered_qty, delivered_qty, variance,
       reason_code, variance_value, resolution_status
from public.delivery_exceptions('open');
