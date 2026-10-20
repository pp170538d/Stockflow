-- =====================================================================
-- Stockflow migration: concurrency + database-level protections
-- (consolidated: includes the apply_stock_movement hotfix)
-- Run once in Supabase SQL Editor (or: supabase migration new ... ).
-- Idempotent: safe to re-run.
--
-- Key idea used everywhere below:
--   current_user IN ('authenticated','anon')  -> request came straight from
--                                                the browser (PostgREST)
--   current_user = owner (postgres)           -> we are inside a
--                                                SECURITY DEFINER RPC / trigger
--   auth.uid()                                -> still the real logged-in user
--                                                in BOTH cases (read from JWT)
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------

-- True when the statement was issued directly by the client, not by our RPCs.
create or replace function public.is_direct_api_call()
returns boolean
language sql stable
as $$
  select current_user in ('authenticated', 'anon');
$$;

-- Raises if the logged-in user may not touch this store.
-- No JWT user (SQL editor, service_role, migrations) -> allowed.
create or replace function public.assert_object_access(p_object_id uuid)
returns void
language plpgsql stable
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  if p_object_id is null then
    raise exception 'Store is required.';
  end if;

  if public.is_demo() then
    if p_object_id is distinct from public.demo_object_id() then
      raise exception using errcode = '42501',
        message = 'The demo account can only work in the Demo Store.';
    end if;
    return;
  end if;

  if public.is_admin() then
    return;
  end if;

  if p_object_id is distinct from public.auth_object_id() then
    raise exception using errcode = '42501',
      message = 'You can only work with your own store.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 1. CONCURRENCY FIX: row-locked inventory update
--    Lock the inventory row (FOR UPDATE), compute, check, then UPDATE.
--    A parallel movement on the same product waits on the lock and then
--    reads the already-committed balance, so two sales can't both pass.
--    (An upsert "quantity = quantity + delta" is NOT used: ON CONFLICT
--    checks the CHECK constraint on the proposed negative row first.)
-- ---------------------------------------------------------------------
create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current int;
  v_result  int;
begin
  -- Make sure the row exists so it can be locked (rolled back if we raise)
  insert into public.inventory (object_id, product_id, quantity, updated_at)
  values (new.object_id, new.product_id, 0, now())
  on conflict (object_id, product_id) do nothing;

  -- Row lock: concurrent movements on the same product serialize here
  select quantity into v_current
  from public.inventory
  where object_id = new.object_id and product_id = new.product_id
  for update;

  v_result := v_current + new.quantity;

  if v_result < 0 then
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

drop trigger if exists on_stock_movement_created on public.stock_movements;
create trigger on_stock_movement_created
  after insert on public.stock_movements
  for each row execute function public.apply_stock_movement();

-- Belt and braces: the derived balance can never be negative.
-- NOT VALID = only checked for new writes, old rows are not re-validated.
alter table public.inventory drop constraint if exists inventory_quantity_nonneg;
alter table public.inventory
  add constraint inventory_quantity_nonneg check (quantity >= 0) not valid;


-- ---------------------------------------------------------------------
-- 2. LEDGER: validate every new movement
-- ---------------------------------------------------------------------
create or replace function public.guard_stock_movement()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.quantity is null or new.quantity = 0 then
    raise exception 'Movement quantity cannot be zero.';
  end if;

  -- Sign rules (SALE is stored negative, DELIVERY positive, ...)
  if new.event in ('SALE', 'WRITE_OFF') and new.quantity > 0 then
    raise exception '% must be a negative quantity.', new.event;
  end if;
  if new.event in ('DELIVERY', 'RETURN') and new.quantity < 0 then
    raise exception '% must be a positive quantity.', new.event;
  end if;

  -- Store scope (also covers RPCs running as definer)
  perform public.assert_object_access(new.object_id);

  if public.is_direct_api_call() then
    -- These events only exist as the result of a workflow
    if new.event in ('DELIVERY', 'STOCK_COUNT', 'TRANSFER') then
      raise exception using errcode = '42501',
        message = format('%s can only be recorded through its workflow.', new.event);
    end if;
    -- The client may not forge the timestamp
    new.created_at := now();
  end if;

  -- Never trust created_by from the client
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;

  return new;
end;
$$;

drop trigger if exists guard_stock_movement on public.stock_movements;
create trigger guard_stock_movement
  before insert on public.stock_movements
  for each row execute function public.guard_stock_movement();


-- Ledger is append-only for API callers (admins included).
-- Mistakes are fixed with a compensating ADJUSTMENT.
create or replace function public.protect_ledger()
returns trigger
language plpgsql
as $$
begin
  if public.is_direct_api_call() then
    raise exception using errcode = '42501',
      message = 'The ledger is append-only. Record a correcting ADJUSTMENT instead.';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists protect_ledger on public.stock_movements;
create trigger protect_ledger
  before update or delete on public.stock_movements
  for each row execute function public.protect_ledger();


-- ---------------------------------------------------------------------
-- 3. INVENTORY: only the ledger trigger may write it
-- ---------------------------------------------------------------------
create or replace function public.protect_inventory()
returns trigger
language plpgsql
as $$
begin
  if public.is_direct_api_call() then
    raise exception using errcode = '42501',
      message = 'Inventory is derived from the ledger and cannot be edited directly.';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists protect_inventory on public.inventory;
create trigger protect_inventory
  before insert or update or delete on public.inventory
  for each row execute function public.protect_inventory();


-- ---------------------------------------------------------------------
-- 4. ORDERS: scope on insert + status state machine
--
--    PENDING  -> APPROVED | REJECTED     (admin)
--    APPROVED -> PENDING                 (admin, Undo)
--    REJECTED -> PENDING                 (admin, Undo)
--    APPROVED -> DELIVERED               (ONLY via record_delivery)
--    DELIVERED -> *                      never
-- ---------------------------------------------------------------------
create or replace function public.guard_order()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform public.assert_object_access(new.object_id);
    new.status := 'PENDING';
    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
    return new;
  end if;

  -- UPDATE
  perform public.assert_object_access(old.object_id);

  if new.object_id  is distinct from old.object_id
  or new.created_by is distinct from old.created_by
  or new.created_at is distinct from old.created_at then
    raise exception using errcode = '42501',
      message = 'Order store, author and creation time cannot be changed.';
  end if;

  if new.status is distinct from old.status then
    if old.status = 'DELIVERED' then
      raise exception 'A delivered order cannot change status.';
    end if;

    if new.status = 'DELIVERED' then
      if public.is_direct_api_call() then
        raise exception using errcode = '42501',
          message = 'Use Record delivery to mark an order as delivered.';
      end if;
      if old.status <> 'APPROVED' then
        raise exception 'Only an APPROVED order can be delivered.';
      end if;
    elsif not (
         (old.status = 'PENDING'  and new.status in ('APPROVED', 'REJECTED'))
      or (old.status = 'APPROVED' and new.status = 'PENDING')
      or (old.status = 'REJECTED' and new.status = 'PENDING')
    ) then
      raise exception 'Invalid status change: % -> %.', old.status, new.status;
    end if;

    if public.is_direct_api_call()
       and not (public.is_admin() or public.is_demo()) then
      raise exception using errcode = '42501',
        message = 'Only an admin can change order status.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_order on public.orders;
create trigger guard_order
  before insert or update on public.orders
  for each row execute function public.guard_order();


-- Order lines can change only while the order is PENDING.
-- FOR SHARE on the parent conflicts with record_delivery's FOR UPDATE,
-- so a line edit and a delivery can't interleave.
create or replace function public.guard_order_item()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
  v_status   order_status;
  v_object   uuid;
begin
  select status, object_id into v_status, v_object
  from public.orders where id = v_order_id
  for share;

  perform public.assert_object_access(v_object);

  if v_status is distinct from 'PENDING' then
    raise exception 'Order lines can only be changed while the order is PENDING.';
  end if;

  if tg_op <> 'DELETE' and (new.quantity is null or new.quantity <= 0) then
    raise exception 'Quantity must be a positive number.';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists guard_order_item on public.order_items;
create trigger guard_order_item
  before insert or update or delete on public.order_items
  for each row execute function public.guard_order_item();


-- ---------------------------------------------------------------------
-- 5. DELIVERIES / STOCK COUNTS: RPC-only tables
--    Without this a client could insert a "delivery" row that never
--    produced ledger movements.
-- ---------------------------------------------------------------------
create or replace function public.guard_rpc_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if public.is_direct_api_call() then
    raise exception using errcode = '42501',
      message = format('%s can only be written through its RPC.', tg_table_name);
  end if;

  if tg_op = 'INSERT' and tg_table_name in ('deliveries', 'stock_counts') then
    perform public.assert_object_access(new.object_id);
    if auth.uid() is not null then
      new.recorded_by := auth.uid();
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['deliveries', 'delivery_items', 'stock_counts', 'stock_count_items']
  loop
    execute format('drop trigger if exists guard_rpc_only on public.%I', t);
    execute format(
      'create trigger guard_rpc_only before insert or update or delete on public.%I
         for each row execute function public.guard_rpc_only()', t);
  end loop;
end $$;

-- One delivery per order, enforced by the DB (not only by the IF EXISTS check)
create unique index if not exists deliveries_order_id_key on public.deliveries (order_id);


-- ---------------------------------------------------------------------
-- 6. FUNCTION SECURITY
--    Write RPCs  -> SECURITY DEFINER (needed so the RPC-only tables work;
--                   scope is enforced by the triggers above).
--    Read RPCs   -> SECURITY INVOKER (RLS decides what a seller sees).
--    anon        -> no EXECUTE on anything.
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_order_with_items', 'record_delivery', 'record_stock_count',
                        'dashboard_summary', 'sales_feed_summary', 'stock_level_history')
  loop
    if r.proname in ('create_order_with_items', 'record_delivery', 'record_stock_count') then
      execute format('alter function %s security definer set search_path = public, pg_temp', r.sig);
    else
      execute format('alter function %s security invoker', r.sig);
    end if;
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;

-- Views run as their owner by default and bypass RLS -> make them respect it.
do $$
begin
  if to_regclass('public.sales_feed') is not null then
    execute 'alter view public.sales_feed set (security_invoker = true)';
  end if;
  if to_regclass('public.order_fulfillment') is not null then
    execute 'alter view public.order_fulfillment set (security_invoker = true)';
  end if;
end $$;

commit;
