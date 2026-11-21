-- =====================================================================
-- Stockflow · Step 12 · Admin order review (prices + quantities)
--
--  1. order_items.requested_qty  what the seller asked for (kept forever)
--  2. Prices on order lines are admin-only: a seller can never set
--     unit_cost; new lines get the product cost price as a proposal
--  3. last_purchase_prices()     last approved price per product for a supplier
--  4. review_order()             admin saves supplier + lines (qty, price,
--                                add, remove) and optionally approves,
--                                all in one transaction
--
-- Existing rules stay: lines can only change while the order is PENDING
-- (guard_order_item), approval snapshots stay immutable (guard_order).
-- Run as ONE script in the Supabase SQL editor.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. What the seller requested
-- ---------------------------------------------------------------------
alter table public.order_items add column if not exists requested_qty integer;

alter table public.order_items disable trigger user;
update public.order_items set requested_qty = quantity where requested_qty is null;
alter table public.order_items enable trigger user;

-- ---------------------------------------------------------------------
-- 2. Price + requested qty defaults, price is admin-only
-- ---------------------------------------------------------------------
create or replace function public.set_order_item_unit_cost()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    -- Seller request: remember what was asked for
    new.requested_qty := coalesce(new.requested_qty, new.quantity);

    -- Only an admin may propose a price; everyone else gets the cost price
    if not public.is_admin() then
      new.unit_cost := null;
    end if;
    if new.unit_cost is null then
      select cost_price into new.unit_cost from public.products where id = new.product_id;
    end if;

  else -- UPDATE
    new.requested_qty := old.requested_qty;  -- never rewritten
    if new.unit_cost is distinct from old.unit_cost and not public.is_admin() then
      raise exception using errcode = '42501',
        message = 'Only an admin can change order prices.';
    end if;
  end if;

  if new.unit_cost is not null and new.unit_cost < 0 then
    raise exception 'Unit price cannot be negative.' using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_set_order_item_unit_cost on public.order_items;
create trigger trg_set_order_item_unit_cost
  before insert or update on public.order_items
  for each row execute function public.set_order_item_unit_cost();

-- ---------------------------------------------------------------------
-- 3. Last approved price per product for one supplier
-- ---------------------------------------------------------------------
create or replace function public.last_purchase_prices(
  p_supplier_id uuid,
  p_product_ids uuid[]
)
returns table (product_id uuid, unit_cost numeric, order_number text, approved_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select distinct on (oi.product_id)
         oi.product_id, oi.unit_cost, o.order_number, o.approved_at
  from order_items oi
  join orders o on o.id = oi.order_id
  where o.supplier_id = p_supplier_id
    and o.status in ('APPROVED', 'DELIVERED')
    and oi.unit_cost is not null
    and oi.product_id = any(p_product_ids)
  order by oi.product_id, o.approved_at desc nulls last, o.created_at desc;
$$;

revoke all on function public.last_purchase_prices(uuid, uuid[]) from public, anon;
grant execute on function public.last_purchase_prices(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Review (and optionally approve) a PENDING order
--
--   p_lines: [{ "order_item_id": uuid|null, "product_id": uuid,
--               "quantity": int, "unit_cost": numeric }]
--   Lines missing from p_lines are removed. order_item_id = null adds a line.
-- ---------------------------------------------------------------------
create or replace function public.review_order(
  p_order_id    uuid,
  p_supplier_id uuid,
  p_comment     text,
  p_lines       jsonb,
  p_approve     boolean default false
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_status order_status;
  v_count  int;
  v_value  numeric;
  l        jsonb;
  v_id     uuid;
  v_qty    int;
  v_price  numeric;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not is_admin() then
    raise exception 'Only an admin can review orders' using errcode = '42501';
  end if;
  if is_demo() then
    raise exception 'Demo account is read-only' using errcode = '42501';
  end if;

  select status into v_status from public.orders where id = p_order_id for update;
  if v_status is null then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_status <> 'PENDING' then
    raise exception 'Only a PENDING order can be reviewed (current: %).', v_status
      using errcode = '22023';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'An order needs at least one line.' using errcode = '22023';
  end if;

  -- validate input
  for l in select * from jsonb_array_elements(p_lines) loop
    v_qty   := (l->>'quantity')::int;
    v_price := nullif(l->>'unit_cost', '')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every line needs a quantity above zero.' using errcode = '22023';
    end if;
    if v_price is null or v_price < 0 then
      raise exception 'Every line needs a unit price (0 or more).' using errcode = '22023';
    end if;
  end loop;

  if (select count(distinct x->>'product_id') from jsonb_array_elements(p_lines) x)
     <> jsonb_array_length(p_lines) then
    raise exception 'A product appears twice — merge the lines.' using errcode = '22023';
  end if;

  update public.orders
  set supplier_id = p_supplier_id,
      comment     = nullif(btrim(coalesce(p_comment, '')), '')
  where id = p_order_id;

  -- remove lines the admin deleted
  delete from public.order_items oi
  where oi.order_id = p_order_id
    and oi.id not in (
      select (x->>'order_item_id')::uuid
      from jsonb_array_elements(p_lines) x
      where nullif(x->>'order_item_id', '') is not null
    );

  -- update / add
  for l in select * from jsonb_array_elements(p_lines) loop
    v_id    := nullif(l->>'order_item_id', '')::uuid;
    v_qty   := (l->>'quantity')::int;
    v_price := round((l->>'unit_cost')::numeric, 2);

    if v_id is null then
      insert into public.order_items (order_id, product_id, quantity, unit_cost, requested_qty)
      values (p_order_id, (l->>'product_id')::uuid, v_qty, v_price, 0);
    else
      update public.order_items
      set quantity = v_qty, unit_cost = v_price
      where id = v_id and order_id = p_order_id;
      if not found then
        raise exception 'Line % does not belong to this order.', v_id using errcode = '22023';
      end if;
    end if;
  end loop;

  if p_approve then
    update public.orders set status = 'APPROVED' where id = p_order_id;
  end if;

  select count(*), coalesce(sum(quantity * unit_cost), 0)
    into v_count, v_value
  from public.order_items where order_id = p_order_id;

  return jsonb_build_object(
    'order_id', p_order_id,
    'approved', p_approve,
    'lines', v_count,
    'value', round(v_value, 2)
  );
end;
$$;

revoke all on function public.review_order(uuid, uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.review_order(uuid, uuid, text, jsonb, boolean) to authenticated;

commit;

-- Check
select o.order_number, o.status, oi.requested_qty, oi.quantity, oi.unit_cost
from order_items oi join orders o on o.id = oi.order_id
order by o.created_at desc
limit 10;
