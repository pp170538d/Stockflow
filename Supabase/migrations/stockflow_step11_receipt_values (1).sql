-- =====================================================================
-- Stockflow · Step 11 · Money on purchase orders + scalable receipts
--
--  1. order_items.unit_cost      price per unit frozen when the line is created
--                                (backfilled from products.cost_price)
--  2. resolve_delivery_lines()   resolve MANY discrepancy lines at once;
--                                bulk BACKORDER creates ONE order for all lines
--     resolve_delivery_line()    kept, now a thin wrapper
--  3. goods_receipt()            the whole receipt document as JSON
--                                (drawer + Print / Save PDF use the same data)
--
-- Run as ONE script in the Supabase SQL editor.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Unit cost on order lines
-- ---------------------------------------------------------------------
alter table public.order_items
  add column if not exists unit_cost numeric(12,2);

alter table public.order_items
  drop constraint if exists order_items_unit_cost_chk,
  add  constraint order_items_unit_cost_chk check (unit_cost is null or unit_cost >= 0);

-- Backfill (triggers off: approved orders may be locked by a guard)
alter table public.order_items disable trigger user;
update public.order_items oi
set unit_cost = p.cost_price
from public.products p
where p.id = oi.product_id and oi.unit_cost is null;
alter table public.order_items enable trigger user;

-- New lines: freeze the current cost price unless the caller sends one
create or replace function public.set_order_item_unit_cost()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.unit_cost is null then
    select cost_price into new.unit_cost from public.products where id = new.product_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_order_item_unit_cost on public.order_items;
create trigger trg_set_order_item_unit_cost
  before insert on public.order_items
  for each row execute function public.set_order_item_unit_cost();

-- Currency label for printed documents
alter table public.orders add column if not exists currency text;
alter table public.orders disable trigger user;
update public.orders set currency = app_currency() where currency is null;
alter table public.orders enable trigger user;
alter table public.orders alter column currency set default 'RSD';

create or replace function public.set_order_currency()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.currency := coalesce(new.currency, public.app_currency());
  return new;
end;
$$;

drop trigger if exists trg_set_order_currency on public.orders;
create trigger trg_set_order_currency
  before insert on public.orders
  for each row execute function public.set_order_currency();

-- ---------------------------------------------------------------------
-- 2. Bulk resolution
--   short lines: BACKORDER | CLOSE_SHORT | CLAIM
--   over lines : ACCEPT | RETURN_TO_SUPPLIER | CLAIM
--   All lines must belong to ONE receipt and still be open.
-- ---------------------------------------------------------------------
create or replace function public.resolve_delivery_lines(
  p_line_ids   uuid[],
  p_resolution text,
  p_note       text default null
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_res          text := upper(btrim(coalesce(p_resolution, '')));
  v_note         text := nullif(btrim(coalesce(p_note, '')), '');
  v_ids          uuid[];
  v_found        int;
  v_receipts     int;
  v_delivery_id  uuid;
  v_grn          text;
  v_object_id    uuid;
  v_order_id     uuid;
  v_order_no     text;
  v_supplier_id  uuid;
  v_backorder_id uuid;
  v_backorder_no text;
  v_mov          uuid;
  r              record;
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

  select array_agg(distinct x) into v_ids from unnest(p_line_ids) x where x is not null;
  if v_ids is null or cardinality(v_ids) = 0 then
    raise exception 'Select at least one line.' using errcode = '22023';
  end if;
  if v_res not in ('BACKORDER','CLOSE_SHORT','CLAIM','ACCEPT','RETURN_TO_SUPPLIER') then
    raise exception 'Unknown resolution %.', v_res using errcode = '22023';
  end if;
  if v_res = 'CLAIM' and v_note is null then
    raise exception 'Add a note for the claim (claim number, agreement…).' using errcode = '22023';
  end if;

  perform 1 from public.delivery_items where id = any(v_ids) for update;

  drop table if exists pg_temp._res_lines;
  create temp table _res_lines on commit drop as
  select di.id, di.product_id, di.delivered_qty, di.resolution_status,
         oi.quantity as ordered_qty, oi.unit_cost,
         di.delivered_qty - oi.quantity as variance,
         d.id as delivery_id, d.delivery_number, d.object_id,
         o.id as order_id, o.order_number, o.supplier_id
  from public.delivery_items di
  join public.order_items oi on oi.id = di.order_item_id
  join public.deliveries d   on d.id = di.delivery_id
  join public.orders o       on o.id = d.order_id
  where di.id = any(v_ids);

  select count(*), count(distinct delivery_id) into v_found, v_receipts from _res_lines;
  if v_found <> cardinality(v_ids) then
    raise exception 'Some lines were not found.' using errcode = 'P0002';
  end if;
  if v_receipts <> 1 then
    raise exception 'Resolve lines from one receipt at a time.' using errcode = '22023';
  end if;
  if exists (select 1 from _res_lines where variance = 0) then
    raise exception 'A selected line was delivered exactly as ordered.' using errcode = '22023';
  end if;
  if exists (select 1 from _res_lines where coalesce(resolution_status, 'open') <> 'open') then
    raise exception 'A selected difference is already resolved.' using errcode = '22023';
  end if;
  if v_res in ('BACKORDER','CLOSE_SHORT') and exists (select 1 from _res_lines where variance > 0) then
    raise exception 'Backorder and close short only apply to short lines.' using errcode = '22023';
  end if;
  if v_res in ('ACCEPT','RETURN_TO_SUPPLIER') and exists (select 1 from _res_lines where variance < 0) then
    raise exception 'Accept and return only apply to over-delivered lines.' using errcode = '22023';
  end if;

  select delivery_id, delivery_number, object_id, order_id, order_number, supplier_id
    into v_delivery_id, v_grn, v_object_id, v_order_id, v_order_no, v_supplier_id
  from _res_lines limit 1;

  -- One backorder for every short line together
  if v_res = 'BACKORDER' then
    insert into public.orders (object_id, status, comment, created_by, supplier_id, parent_order_id)
    values (v_object_id, 'PENDING',
            format('Backorder for %s · %s', v_order_no, v_grn),
            auth.uid(), v_supplier_id, v_order_id)
    returning id into v_backorder_id;

    insert into public.order_items (order_id, product_id, quantity, unit_cost)
    select v_backorder_id, product_id, sum(-variance)::int, max(unit_cost)
    from _res_lines
    group by product_id;

    update public.orders set status = 'APPROVED' where id = v_backorder_id;
    select order_number into v_backorder_no from public.orders where id = v_backorder_id;
  end if;

  for r in select * from _res_lines loop
    v_mov := null;

    if v_res = 'RETURN_TO_SUPPLIER' then
      insert into public.stock_movements
        (object_id, product_id, event, quantity, reference, note, created_by)
      values (r.object_id, r.product_id, 'SUPPLIER_RETURN', -r.variance,
              'grn:' || r.delivery_id,
              coalesce(v_note, 'Returned to supplier · ' || r.delivery_number),
              auth.uid())
      returning id into v_mov;
    end if;

    update public.delivery_items
    set resolution_status  = 'resolved',
        resolution         = v_res,
        resolution_note    = v_note,
        resolved_by        = auth.uid(),
        resolved_at        = now(),
        backorder_id       = v_backorder_id,
        return_movement_id = v_mov
    where id = r.id;
  end loop;

  return jsonb_build_object(
    'resolved', v_found,
    'resolution', v_res,
    'backorder_id', v_backorder_id,
    'backorder_number', v_backorder_no
  );
end;
$$;

revoke all on function public.resolve_delivery_lines(uuid[], text, text) from public, anon;
grant execute on function public.resolve_delivery_lines(uuid[], text, text) to authenticated;

create or replace function public.resolve_delivery_line(
  p_line_id uuid, p_resolution text, p_note text default null)
returns jsonb language sql security definer set search_path = public as $$
  select public.resolve_delivery_lines(array[p_line_id], p_resolution, p_note);
$$;

-- ---------------------------------------------------------------------
-- 3. Goods receipt document (RLS applies: security invoker)
-- ---------------------------------------------------------------------
create or replace function public.goods_receipt(p_delivery_id uuid)
returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'currency', app_currency(),
    'delivery', jsonb_build_object(
      'id', d.id,
      'delivery_number', d.delivery_number,
      'delivered_at', d.delivered_at,
      'received_by', d.received_by,
      'carrier', d.carrier,
      'note', d.note
    ),
    'order', jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'status', o.status,
      'comment', o.comment,
      'approved_at', o.approved_at,
      'company', o.company_snapshot,
      'supplier', o.supplier_snapshot,
      'deliver_to', o.delivery_snapshot
    ),
    'object_name', ob.name,
    'lines', coalesce((
      select jsonb_agg(l order by l.open desc, l.product_name)
      from (
        select di.id as line_id,
               oi.id as order_item_id,
               oi.product_id,
               p.sku,
               p.name as product_name,
               oi.quantity as ordered_qty,
               coalesce(di.delivered_qty, 0) as received_qty,
               coalesce(di.delivered_qty, 0) - oi.quantity as variance,
               coalesce(oi.unit_cost, p.cost_price) as unit_cost,
               round(oi.quantity * coalesce(oi.unit_cost, p.cost_price), 2) as ordered_value,
               round(coalesce(di.delivered_qty, 0) * coalesce(oi.unit_cost, p.cost_price), 2) as received_value,
               round((coalesce(di.delivered_qty, 0) - oi.quantity) * coalesce(oi.unit_cost, p.cost_price), 2) as variance_value,
               di.reason_code,
               di.reason,
               di.resolution_status,
               di.resolution,
               di.resolution_note,
               di.resolved_at,
               bo.order_number as backorder_number,
               (di.resolution_status = 'open') as open
        from order_items oi
        join products p on p.id = oi.product_id
        left join delivery_items di on di.order_item_id = oi.id and di.delivery_id = d.id
        left join orders bo on bo.id = di.backorder_id
        where oi.order_id = d.order_id
      ) l
    ), '[]'::jsonb)
  )
  from deliveries d
  join orders o   on o.id = d.order_id
  join objects ob on ob.id = d.object_id
  where d.id = p_delivery_id;
$$;

revoke all on function public.goods_receipt(uuid) from public, anon;
grant execute on function public.goods_receipt(uuid) to authenticated;

commit;

-- =====================================================================
-- Check: order values now exist
-- =====================================================================
select o.order_number, count(*) as lines,
       sum(oi.quantity) as units,
       sum(oi.quantity * oi.unit_cost) as order_value,
       count(*) filter (where oi.unit_cost is null) as lines_without_cost
from orders o join order_items oi on oi.order_id = o.id
group by o.order_number
order by o.order_number desc
limit 10;
