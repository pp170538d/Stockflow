-- =====================================================================
-- Stockflow · Step 7 · Replenishment lifecycle
--
-- One row per store x product that runs out this week (out / critical,
-- same rule as runway.ts: 30-day sales pace, critical <= 7 days),
-- enriched with what is already being done about it:
--
--   needs_order  nothing is ordered yet                  -> Create order
--   top_up       something is ordered, but not enough     -> Create order
--   pending      enough is ordered, waiting for approval  -> Review order
--   in_transit   enough is approved, waiting for delivery -> Receive
--
-- SECURITY INVOKER: RLS applies, a seller only sees own store.
-- Read-only, changes no data. Run in the Supabase SQL editor.
-- =====================================================================

create or replace function public.replenishment_queue(p_object_id uuid default null)
returns table (
  object_id         uuid,
  object_name       text,
  product_id        uuid,
  sku               text,
  product_name      text,
  on_hand           int,
  sold30            int,
  daily_rate        numeric,
  days_left         numeric,
  urgency           text,
  pending_qty       int,
  approved_qty      int,
  incoming_qty      int,
  open_order_id     uuid,
  open_order_number text,
  open_order_status text,
  status            text,
  suggested_qty     int
)
language sql stable security invoker set search_path = public as $$
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
    join objects  o on o.id = op.object_id and o.active
    join products p on p.id = op.product_id and p.active
    left join inventory i on i.object_id = op.object_id and i.product_id = op.product_id
    where p_object_id is null or op.object_id = p_object_id
  ),
  sales as (
    select m.object_id, m.product_id, sum(abs(m.quantity))::int as sold30
    from stock_movements m, win
    where m.event = 'SALE'
      and m.occurred_at >= win.since
      and (p_object_id is null or m.object_id = p_object_id)
    group by 1, 2
  ),
  open_items as (
    select o.object_id, oi.product_id,
           coalesce(sum(oi.quantity) filter (where o.status = 'PENDING'), 0)::int  as pending_qty,
           coalesce(sum(oi.quantity) filter (where o.status = 'APPROVED'), 0)::int as approved_qty,
           (array_agg(o.id           order by o.created_at desc))[1] as open_order_id,
           (array_agg(o.order_number order by o.created_at desc))[1] as open_order_number,
           (array_agg(o.status::text order by o.created_at desc))[1] as open_order_status
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
           coalesce(x.pending_qty, 0) + coalesce(x.approved_qty, 0) as incoming_qty,
           x.open_order_id, x.open_order_number, x.open_order_status
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
           -- covered = shelf + everything already ordered lasts past the 7-day danger zone
           case
             when c.incoming_qty = 0 then false
             when c.daily_rate = 0  then greatest(c.on_hand, 0) + c.incoming_qty > 0
             else (greatest(c.on_hand, 0) + c.incoming_qty) / c.daily_rate > 7
           end as covered
    from calc c
  )
  select r.object_id, r.object_name, r.product_id, r.sku, r.product_name,
         r.on_hand, r.sold30, round(r.daily_rate, 2), r.days_left, r.urgency,
         r.pending_qty, r.approved_qty, r.incoming_qty,
         r.open_order_id, r.open_order_number, r.open_order_status,
         case
           when r.incoming_qty = 0 then 'needs_order'
           when not r.covered      then 'top_up'
           when r.pending_qty > 0  then 'pending'
           else 'in_transit'
         end,
         -- same target as runway.ts: 21 days of sales, minus shelf and incoming
         case when r.daily_rate > 0
              then greatest(1, ceil(r.daily_rate * 21 - greatest(r.on_hand, 0) - r.incoming_qty))::int
         end
  from rated r
  where r.urgency in ('out', 'critical')
  order by
    case
      when r.incoming_qty = 0 then 0
      when not r.covered      then 1
      when r.pending_qty > 0  then 2
      else 3
    end,
    case r.urgency when 'out' then 0 else 1 end,
    r.days_left nulls first,
    r.object_name, r.product_name;
$$;

revoke all on function public.replenishment_queue(uuid) from public, anon;
grant execute on function public.replenishment_queue(uuid) to authenticated;

-- Check (SQL editor bypasses RLS, so you see every store)
select object_name, sku, on_hand, urgency, pending_qty, approved_qty,
       open_order_number, status, suggested_qty
from public.replenishment_queue();
