-- =====================================================================
-- Stockflow · Step 14 · Request lifecycle in replenishment
--
-- A PENDING order is now a store REQUEST (no supplier, no price yet).
-- It no longer counts as stock "on the way". Only APPROVED purchase
-- orders are incoming stock.
--
-- replenishment_queue.status:
--   needs_order  nothing requested, nothing ordered        -> Request / Create order
--   top_up       ordered, but not enough to cover 14 days  -> Order more
--   requested    a request waits for procurement review    -> Review request
--   in_transit   approved purchase orders cover the need   -> View order
--
-- Same columns as before (no client changes needed to read it):
--   pending_qty   = quantity in open requests
--   approved_qty  = quantity in approved purchase orders
--   incoming_qty  = approved_qty only
--   open_order_*  = the request for 'requested', the latest PO otherwise
-- =====================================================================

create or replace function public.replenishment_queue(p_object_id uuid default null)
returns table (
  object_id uuid, object_name text, product_id uuid, sku text, product_name text,
  on_hand integer, sold30 integer, daily_rate numeric, days_left numeric, urgency text,
  pending_qty integer, approved_qty integer, incoming_qty integer,
  open_order_id uuid, open_order_number text, open_order_status text,
  status text, suggested_qty integer
)
language sql stable
set search_path to 'public'
as $function$
  with
  win as (
    select ((now() at time zone app_timezone())::date - 29)::timestamp
           at time zone app_timezone() as since
  ),
  base as (
    select op.object_id, o.name as object_name, op.product_id,
           p.sku, p.name as product_name,
           coalesce(i.quantity, 0)::int as on_hand
    from object_products op
    join objects o  on o.id = op.object_id and o.active
    join products p on p.id = op.product_id and p.active
    left join inventory i on i.object_id = op.object_id and i.product_id = op.product_id
    where p_object_id is null or op.object_id = p_object_id
  ),
  sales as (
    select m.object_id, m.product_id, sum(abs(m.quantity))::int as sold30
    from stock_movements m cross join win
    where m.event = 'SALE' and m.occurred_at >= win.since
      and (p_object_id is null or m.object_id = p_object_id)
    group by 1, 2
  ),
  open_items as (
    select o.object_id, oi.product_id,
           coalesce(sum(oi.quantity) filter (where o.status = 'PENDING'), 0)::int  as pending_qty,
           coalesce(sum(oi.quantity) filter (where o.status = 'APPROVED'), 0)::int as approved_qty,
           (array_agg(o.id           order by o.created_at desc) filter (where o.status = 'PENDING'))[1]  as req_id,
           (array_agg(o.order_number order by o.created_at desc) filter (where o.status = 'PENDING'))[1]  as req_number,
           (array_agg(o.id           order by o.created_at desc) filter (where o.status = 'APPROVED'))[1] as po_id,
           (array_agg(o.order_number order by o.created_at desc) filter (where o.status = 'APPROVED'))[1] as po_number
    from orders o
    join order_items oi on oi.order_id = o.id
    where o.status in ('PENDING', 'APPROVED')
      and (p_object_id is null or o.object_id = p_object_id)
    group by 1, 2
  ),
  calc as (
    select b.*,
           coalesce(s.sold30, 0)        as sold30,
           coalesce(s.sold30, 0) / 30.0 as daily_rate,
           coalesce(x.pending_qty, 0)   as pending_qty,
           coalesce(x.approved_qty, 0)  as approved_qty,
           x.req_id, x.req_number, x.po_id, x.po_number
    from base b
    left join sales s      using (object_id, product_id)
    left join open_items x using (object_id, product_id)
  ),
  rated as (
    select c.*,
           case when c.daily_rate > 0
                then round(greatest(c.on_hand, 0) / c.daily_rate, 1) end as days_left,
           case
             when c.on_hand <= 0                 then 'out'
             when c.daily_rate = 0               then 'idle'
             when c.on_hand / c.daily_rate <= 7  then 'critical'
             when c.on_hand / c.daily_rate <= 14 then 'warning'
             else 'healthy'
           end as urgency,
           -- only APPROVED purchase orders count as coverage
           case
             when c.approved_qty = 0 then false
             when c.daily_rate = 0  then greatest(c.on_hand, 0) + c.approved_qty > 0
             else (greatest(c.on_hand, 0) + c.approved_qty) / c.daily_rate > 14
           end as covered
    from calc c
  ),
  decided as (
    select r.*,
           case
             when r.covered           then 'in_transit'
             when r.pending_qty > 0   then 'requested'
             when r.approved_qty > 0  then 'top_up'
             else 'needs_order'
           end as st
    from rated r
  )
  select d.object_id, d.object_name, d.product_id, d.sku, d.product_name,
         d.on_hand, d.sold30, round(d.daily_rate, 2), d.days_left, d.urgency,
         d.pending_qty, d.approved_qty, d.approved_qty as incoming_qty,
         case when d.st = 'requested' then d.req_id     else coalesce(d.po_id, d.req_id) end,
         case when d.st = 'requested' then d.req_number else coalesce(d.po_number, d.req_number) end,
         case when d.st = 'requested' then 'PENDING'
              when d.po_id is not null then 'APPROVED' end,
         d.st,
         case when d.daily_rate > 0
              then greatest(1, ceil(d.daily_rate * 21 - greatest(d.on_hand, 0) - d.approved_qty))::int
         end
  from decided d
  where d.urgency in ('out', 'critical', 'warning')
  order by
    case d.st when 'needs_order' then 0 when 'top_up' then 1 when 'requested' then 2 else 3 end,
    case d.urgency when 'out' then 0 when 'critical' then 1 else 2 end,
    d.days_left nulls first, d.object_name, d.product_name;
$function$;

revoke all on function public.replenishment_queue(uuid) from public, anon;
grant execute on function public.replenishment_queue(uuid) to authenticated;

-- Check
select object_name, sku, on_hand, urgency, pending_qty, approved_qty, incoming_qty,
       open_order_number, open_order_status, status, suggested_qty
from public.replenishment_queue()
order by object_name, sku;
