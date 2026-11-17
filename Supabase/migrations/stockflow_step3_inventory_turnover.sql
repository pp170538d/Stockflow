-- Stockflow Step 3: inventory turnover / obrt lagera
-- One row per active store x assigned active product.

create or replace function public.inventory_turnover(
  p_days int default 30,
  p_object_id uuid default null)
returns table (
  object_id uuid,
  object_name text,
  product_id uuid,
  sku text,
  product_name text,
  category text,
  on_hand int,
  sold int,
  avg_stock numeric,
  turnover numeric,
  days_of_stock numeric,
  days_out int,
  revenue numeric,
  cogs numeric,
  margin numeric,
  priced_share numeric,
  stock_value numeric,
  last_sale_at timestamptz,
  class text
)
language plpgsql stable security invoker set search_path = public as $$
declare
  v_tz text := app_timezone();
  v_today date := (now() at time zone v_tz)::date;
  v_first date;
  v_since timestamptz;
begin
  if p_days is null or p_days < 7 or p_days > 365 then
    raise exception 'Period must be between 7 and 365 days' using errcode = '22023';
  end if;

  v_first := v_today - (p_days - 1);
  v_since := v_first::timestamp at time zone v_tz;

  return query
  with
  base as (
    select op.object_id, op.product_id, coalesce(i.quantity, 0) as qty
    from object_products op
    left join inventory i
      on i.object_id = op.object_id and i.product_id = op.product_id
    where p_object_id is null or op.object_id = p_object_id
  ),
  mv as (
    select m.object_id, m.product_id, m.event, m.quantity,
           m.unit_price, m.unit_cost,
           (m.occurred_at at time zone v_tz)::date as d
    from stock_movements m
    join base b on b.object_id = m.object_id and b.product_id = m.product_id
    where m.occurred_at >= v_since
  ),
  net as (
    select mv.object_id, mv.product_id, mv.d, sum(mv.quantity) as n
    from mv
    group by 1,2,3
  ),
  grid as (
    select b.object_id, b.product_id, b.qty, g.d::date as d
    from base b
    cross join generate_series(v_first, v_today, interval '1 day') g(d)
  ),
  daily as (
    select gr.object_id, gr.product_id,
           gr.qty - coalesce(sum(coalesce(n.n, 0)) over (
             partition by gr.object_id, gr.product_id
             order by gr.d desc
             rows between unbounded preceding and 1 preceding
           ), 0) as eod
    from grid gr
    left join net n
      on n.object_id = gr.object_id
     and n.product_id = gr.product_id
     and n.d = gr.d
  ),
  stock as (
    select daily.object_id, daily.product_id,
           avg(greatest(daily.eod, 0)) as avg_stock,
           count(*) filter (where daily.eod <= 0)::int as days_out
    from daily
    group by 1,2
  ),
  sales as (
    select mv.object_id, mv.product_id,
           sum(-mv.quantity)::int as sold,
           sum(-mv.quantity * mv.unit_price) as revenue,
           sum(-mv.quantity * mv.unit_cost) as cogs,
           sum(-mv.quantity * (mv.unit_price - mv.unit_cost)) as margin,
           count(*) filter (where mv.unit_price is not null)::numeric
             / nullif(count(*), 0) as priced_share
    from mv
    where mv.event in ('SALE', 'RETURN')
    group by 1,2
  ),
  last_sale as (
    select m.object_id, m.product_id, max(m.occurred_at) as at
    from stock_movements m
    join base b on b.object_id = m.object_id and b.product_id = m.product_id
    where m.event = 'SALE'
    group by 1,2
  ),
  calc as (
    select b.object_id, b.product_id, b.qty,
           greatest(coalesce(s.sold, 0), 0) as sold,
           st.avg_stock, st.days_out,
           s.revenue, s.cogs, s.margin, s.priced_share,
           ls.at as last_sale_at
    from base b
    join stock st using (object_id, product_id)
    left join sales s using (object_id, product_id)
    left join last_sale ls using (object_id, product_id)
  )
  select
    c.object_id, o.name, c.product_id, p.sku, p.name, p.category,
    c.qty::int,
    c.sold::int,
    round(c.avg_stock, 2),
    round(c.sold / nullif(c.avg_stock, 0), 2),
    round(p_days * c.avg_stock / nullif(c.sold, 0), 1),
    c.days_out,
    round(c.revenue, 2),
    round(c.cogs, 2),
    round(c.margin, 2),
    round(c.priced_share, 2),
    case when c.qty > 0 and p.cost_price is not null
         then round(c.qty * p.cost_price, 2) end,
    c.last_sale_at,
    case
      when c.sold = 0 and c.qty <= 0 then 'idle'
      when c.sold = 0 then 'dead'
      when c.days_out > 0 then 'stockout'
      when c.sold / nullif(c.avg_stock, 0) * 30 / p_days >= 4 then 'fast'
      when c.sold / nullif(c.avg_stock, 0) * 30 / p_days >= 1 then 'normal'
      when c.avg_stock = 0 then 'fast'
      else 'slow'
    end
  from calc c
  join objects o on o.id = c.object_id
  join products p on p.id = c.product_id
  where p.active and o.active;
end;
$$;

revoke all on function public.inventory_turnover(int, uuid) from public, anon;
grant execute on function public.inventory_turnover(int, uuid) to authenticated;

-- TEST AFTER CREATION:
-- select object_name, sku, product_name, on_hand, sold, avg_stock, turnover,
--        days_of_stock, days_out, revenue, cogs, margin, priced_share,
--        stock_value, last_sale_at, class
-- from public.inventory_turnover(30)
-- order by object_name, sku;
