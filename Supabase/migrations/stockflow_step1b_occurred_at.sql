-- =====================================================================
-- Stockflow · Step 1b · Read side moves to business time (occurred_at)
--
--  1. sales_feed           view : + occurred_at, prices, revenue/cost/margin
--  2. sales_feed_summary        : filters by occurred_at
--  3. stock_level_history       : timeline by occurred_at
--  4. export_movements          : filters/sorts by occurred_at, + price columns
--  5. dashboard_summary         : occurred_at + company timezone days
--                                 + fix: "top 8 / top 5" lists were cut BEFORE sorting
--
-- Same JSON keys and same column names as before -> frontend keeps working.
-- Run as ONE script in the Supabase SQL editor.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. sales_feed (old columns unchanged, new ones appended; view options kept)
-- ---------------------------------------------------------------------
create temp table _view_opts on commit drop as
select reloptions from pg_class where oid = 'public.sales_feed'::regclass;

create or replace view public.sales_feed as
select sm.id,
       sm.object_id,
       o.name  as object_name,
       sm.product_id,
       p.name  as product_name,
       p.sku,
       abs(sm.quantity) as units,
       sm.note,
       sm.created_by,
       sm.created_at,
       -- new
       sm.occurred_at,
       sm.unit_price,
       sm.unit_cost,
       sm.currency,
       abs(sm.quantity) * sm.unit_price                  as revenue,
       abs(sm.quantity) * sm.unit_cost                   as cost,
       abs(sm.quantity) * (sm.unit_price - sm.unit_cost) as margin,
       sm.import_batch_id
from stock_movements sm
join products p on p.id = sm.product_id
join objects  o on o.id = sm.object_id
where sm.event = 'SALE'::movement_event;

do $$
declare o text;
begin
  for o in select unnest(reloptions) from _view_opts where reloptions is not null loop
    execute format('alter view public.sales_feed set (%s)', o);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. sales_feed_summary (same signature)
-- ---------------------------------------------------------------------
create or replace function public.sales_feed_summary(
  p_object_id uuid default null,
  p_from timestamptz default null,
  p_search text default null)
returns table(total_units bigint, sale_events bigint, products_sold bigint)
language sql stable set search_path to 'public' as $function$
  select
    coalesce(sum(sf.units), 0)::bigint,
    count(*)::bigint,
    count(distinct sf.product_id)::bigint
  from public.sales_feed sf
  where (p_object_id is null or sf.object_id = p_object_id)
    and (p_from is null or sf.occurred_at >= p_from)
    and (
      nullif(trim(coalesce(p_search, '')), '') is null
      or sf.product_name ilike '%' || p_search || '%'
      or sf.sku          ilike '%' || p_search || '%'
      or sf.object_name  ilike '%' || p_search || '%'
      or coalesce(sf.note, '') ilike '%' || p_search || '%'
    );
$function$;

-- ---------------------------------------------------------------------
-- 3. stock_level_history (same signature)
-- ---------------------------------------------------------------------
create or replace function public.stock_level_history(
  p_object_id uuid, p_product_id uuid,
  p_from timestamptz default null, p_to timestamptz default null)
returns table(movement_id uuid, occurred_at timestamptz, event text, change_quantity integer,
              balance bigint, note text, reference text, is_opening boolean)
language sql stable set search_path to 'public' as $function$
  with visible_all as (
    select sm.id,
           sm.occurred_at as at,
           sm.created_at  as rec,
           sm.event::text as event,
           sm.quantity::integer as change_quantity,
           sm.note,
           sm.reference
    from public.stock_movements sm
    where sm.object_id = p_object_id
      and sm.product_id = p_product_id
      and (p_to is null or sm.occurred_at <= p_to)
  ),
  bounds as (
    select coalesce(p_from, (select min(v.at) from visible_all v), now()) as range_start
  ),
  opening as (
    select coalesce(sum(v.change_quantity), 0)::bigint as opening_balance
    from visible_all v cross join bounds b
    where v.at < b.range_start
  ),
  in_range as (
    select v.* from visible_all v cross join bounds b
    where v.at >= b.range_start
  ),
  movement_points as (
    select r.id, r.at, r.event, r.change_quantity,
           (o.opening_balance + sum(r.change_quantity) over (
              order by r.at, r.rec, r.id
              rows between unbounded preceding and current row))::bigint as balance,
           r.note, r.reference, false as is_opening, 1 as point_order, r.rec
    from in_range r cross join opening o
  ),
  opening_point as (
    select null::uuid, b.range_start, 'OPENING'::text, 0::integer, o.opening_balance,
           null::text, null::text, true, 0, null::timestamptz
    from bounds b cross join opening o
  )
  select x.id, x.at, x.event, x.change_quantity, x.balance, x.note, x.reference, x.is_opening
  from (select * from opening_point union all select * from movement_points)
       as x(id, at, event, change_quantity, balance, note, reference, is_opening, point_order, rec)
  order by x.at, x.point_order, x.rec nulls first, x.id nulls first;
$function$;

-- ---------------------------------------------------------------------
-- 4. export_movements (return type grows -> drop + recreate + grants)
-- ---------------------------------------------------------------------
drop function if exists public.export_movements(timestamptz, timestamptz, uuid, text[]);

create function public.export_movements(
  p_from timestamptz, p_to timestamptz,
  p_object_id uuid default null, p_events text[] default null)
returns table(created_at timestamptz, location text, sku text, product text, event text,
              quantity integer, reference text, note text, user_name text,
              -- new (appended)
              occurred_at timestamptz, unit_price numeric, unit_cost numeric, currency text)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp' as $function$
declare
  v_object uuid := p_object_id;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Invalid period' using errcode = '22023';
  end if;
  if p_to - p_from > interval '366 days' then
    raise exception 'Max period is one year' using errcode = '22023';
  end if;

  if not is_admin() then
    v_object := auth_object_id();
    if v_object is null then
      raise exception 'No location assigned to this user' using errcode = '42501';
    end if;
  end if;

  return query
  select m.created_at, o.name, p.sku, p.name, m.event::text, m.quantity,
         m.reference, m.note, coalesce(nullif(pr.full_name, ''), pr.email),
         m.occurred_at, m.unit_price, m.unit_cost, m.currency
  from stock_movements m
  join objects  o on o.id = m.object_id
  join products p on p.id = m.product_id
  left join profiles pr on pr.id = m.created_by
  where m.occurred_at >= p_from
    and m.occurred_at <  p_to
    and (v_object is null or m.object_id = v_object)
    and (p_events is null or m.event::text = any (p_events))
  order by m.occurred_at, m.created_at, m.id;
end;
$function$;

revoke all on function public.export_movements(timestamptz, timestamptz, uuid, text[]) from public, anon;
grant execute on function public.export_movements(timestamptz, timestamptz, uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------
-- 5. dashboard_summary (same signature, same JSON shape)
-- ---------------------------------------------------------------------
create or replace function public.dashboard_summary(p_object_id uuid default null, p_days integer default 30)
returns jsonb language plpgsql stable set search_path to 'public' as $function$
declare
  v_tz       text        := public.app_timezone();
  v_today    date        := (now() at time zone v_tz)::date;
  v_first    date        := v_today - (p_days - 1);
  v_since    timestamptz := (v_first::timestamp at time zone v_tz);   -- local midnight
  v_week     timestamptz := now() - interval '7 days';
  v_prevweek timestamptz := now() - interval '14 days';
  v_result   jsonb;
begin
  with
  inv as (
    select i.object_id, i.product_id, i.quantity
    from inventory i
    where p_object_id is null or i.object_id = p_object_id
  ),
  sales as (
    select m.object_id, m.product_id, sum(abs(m.quantity))::numeric as sold
    from stock_movements m
    where m.event = 'SALE'
      and m.occurred_at >= v_since
      and (p_object_id is null or m.object_id = p_object_id)
    group by 1, 2
  ),
  runway as (
    select inv.object_id, inv.product_id, inv.quantity as on_hand,
           coalesce(s.sold, 0) / p_days as daily_rate,
           case when coalesce(s.sold, 0) > 0
                then round(inv.quantity / (s.sold / p_days), 1) end as days_left
    from inv left join sales s using (object_id, product_id)
  ),
  runway_ranked as (
    select r.*,
           case when r.on_hand <= 0      then 'out'
                when r.days_left is null then 'idle'
                when r.days_left <= 7    then 'critical'
                when r.days_left <= 14   then 'warning'
                else 'healthy' end as urgency
    from runway r
  ),
  mv as (
    select m.* from stock_movements m
    where m.occurred_at >= v_since
      and (p_object_id is null or m.object_id = p_object_id)
  ),
  days as (
    select generate_series(v_first, v_today, interval '1 day')::date as d
  ),
  daily as (
    select (occurred_at at time zone v_tz)::date as d,
           sum(quantity) filter (where quantity > 0)      as units_in,
           sum(abs(quantity)) filter (where quantity < 0) as units_out,
           sum(quantity)                                  as net,
           count(*) filter (where event = 'DELIVERY')     as n_delivery,
           count(*) filter (where event = 'SALE')         as n_sale,
           count(*) filter (where event = 'STOCK_COUNT')  as n_count,
           count(*) filter (where event not in ('DELIVERY','SALE','STOCK_COUNT')) as n_other
    from mv group by 1
  ),
  totals as (select coalesce(sum(quantity), 0) as on_hand from inv),
  flow as (
    select days.d,
           coalesce(daily.units_in, 0)   as units_in,
           coalesce(daily.units_out, 0)  as units_out,
           coalesce(daily.net, 0)        as net,
           coalesce(daily.n_delivery, 0) as n_delivery,
           coalesce(daily.n_sale, 0)     as n_sale,
           coalesce(daily.n_count, 0)    as n_count,
           coalesce(daily.n_other, 0)    as n_other
    from days left join daily using (d)
  ),
  flow_bal as (
    select f.*,
           (select on_hand from totals)
             - coalesce(sum(f.net) over (order by f.d desc
                 rows between unbounded preceding and 1 preceding), 0) as closing
    from flow f
  ),
  variances as (
    select f.order_id, f.product_id, f.ordered_qty, f.delivered_qty,
           f.variance, f.reason, f.delivered_at, o.object_id
    from order_fulfillment f
    join orders o on o.id = f.order_id
    where f.variance is not null and f.variance <> 0
      and f.delivered_at >= v_week
      and (p_object_id is null or o.object_id = p_object_id)
  ),
  ord as (
    select o.id, o.status, o.created_at, o.object_id
    from orders o
    where p_object_id is null or o.object_id = p_object_id
  )
  select jsonb_build_object(
    'generated_at', now(),
    'days', p_days,
    'timezone', v_tz,

    'totals', jsonb_build_object(
      'on_hand',     (select on_hand from totals),
      'products',    (select count(distinct product_id) from inv),
      'stores',      (select count(distinct object_id) from inv),
      'pending',     (select count(*) from ord where status = 'PENDING'),
      'approved',    (select count(*) from ord where status = 'APPROVED'),
      'orders_week', (select count(*) from ord where created_at >= v_week),
      'orders_prev', (select count(*) from ord where created_at >= v_prevweek and created_at < v_week),
      'sold_week',   (select coalesce(sum(abs(quantity)), 0) from stock_movements
                       where event = 'SALE' and occurred_at >= v_week
                         and (p_object_id is null or object_id = p_object_id)),
      'sold_prev',   (select coalesce(sum(abs(quantity)), 0) from stock_movements
                       where event = 'SALE' and occurred_at >= v_prevweek and occurred_at < v_week
                         and (p_object_id is null or object_id = p_object_id))
    ),

    'running_out', coalesce((
      select jsonb_agg(x order by x.rank, x.days_left nulls last)
      from (
        select r.object_id, r.product_id, r.on_hand,
               round(r.daily_rate, 2) as daily_rate, r.days_left, r.urgency,
               p.name, p.sku, ob.name as store,
               case r.urgency when 'out' then 0 when 'critical' then 1 else 2 end as rank
        from runway_ranked r
        join products p on p.id = r.product_id
        join objects ob on ob.id = r.object_id
        where r.urgency in ('out', 'critical', 'warning')
        order by rank, r.days_left nulls last, p.name      -- FIX: sort before limit
        limit 8
      ) x
    ), '[]'::jsonb),

    'variances', jsonb_build_object(
      'net_week', (select coalesce(sum(variance), 0) from variances),
      'lines', coalesce((
        select jsonb_agg(v order by v.delivered_at desc)
        from (
          select va.order_id, va.ordered_qty, va.delivered_qty, va.variance,
                 va.reason, va.delivered_at, p.name, ob.name as store
          from variances va
          join products p on p.id = va.product_id
          join objects ob on ob.id = va.object_id
          order by va.delivered_at desc                     -- FIX: newest 5, not random 5
          limit 5
        ) v
      ), '[]'::jsonb),
      'count_net_week', (select coalesce(sum(quantity), 0) from stock_movements
                          where event = 'STOCK_COUNT' and occurred_at >= v_week
                            and (p_object_id is null or object_id = p_object_id))
    ),

    'flow', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', to_char(d, 'YYYY-MM-DD'),
        'in', units_in, 'out', units_out, 'closing', closing,
        'events', jsonb_build_object(
          'delivery', n_delivery, 'sale', n_sale, 'count', n_count, 'other', n_other)
      ) order by d)
      from flow_bal
    ), '[]'::jsonb),

    'pending_orders', coalesce((
      select jsonb_agg(po order by po.created_at)
      from (
        select o.id, o.created_at, ob.name as store,
               (select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = o.id) as units,
               (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'qty', oi.quantity)
                                          order by oi.quantity desc), '[]'::jsonb)
                  from order_items oi join products p on p.id = oi.product_id
                 where oi.order_id = o.id) as lines
        from ord o
        join objects ob on ob.id = o.object_id
        where o.status = 'PENDING'
        order by o.created_at
        limit 5
      ) po
    ), '[]'::jsonb),

    'stores', coalesce((
      select jsonb_agg(s order by s.rank, s.name)
      from (
        select ob.id, ob.name,
               sum(r.on_hand) as on_hand,
               count(*) filter (where r.urgency in ('out', 'critical')) as critical,
               count(*) filter (where r.urgency = 'warning')            as warning,
               min(case r.urgency when 'out' then 0 when 'critical' then 1
                                  when 'warning' then 2 else 3 end)     as rank
        from runway_ranked r
        join objects ob on ob.id = r.object_id
        group by ob.id, ob.name
      ) s
    ), '[]'::jsonb),

    -- "what was recorded last": stays on created_at, occurred_at added
    'ledger', coalesce((
      select jsonb_agg(l order by l.created_at desc)
      from (
        select m.id, m.event, m.quantity, m.reference, m.created_at, m.occurred_at,
               p.name, ob.name as store
        from stock_movements m
        join products p on p.id = m.product_id
        join objects ob on ob.id = m.object_id
        where p_object_id is null or m.object_id = p_object_id
        order by m.created_at desc
        limit 12
      ) l
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$function$;

commit;

-- =====================================================================
-- Checks
-- =====================================================================
-- 1) View options survived (should match what it had before; null = see note):
--    select reloptions from pg_class where oid = 'public.sales_feed'::regclass;
-- 2) Dashboard still returns the same keys:
--    select jsonb_object_keys(dashboard_summary());
-- 3) Export works with the new columns:
--    select * from export_movements(now() - interval '7 days', now()) limit 5;
