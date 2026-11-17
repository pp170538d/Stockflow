-- =====================================================================
-- Stockflow Step 6: history-aware inventory performance
--
-- Fixes inflated turnover / false stockouts when the selected period is
-- longer than the available ledger history.
--
-- Example: 15 days of history + 90d filter => calculate on 15 days and
-- return history_days=15, requested_days=90, history_coverage=0.1667.
-- =====================================================================

begin;

-- Summary depends on turnover, so remove it first.
drop function if exists public.inventory_performance_summary(int, uuid);
drop function if exists public.inventory_turnover(int, uuid);

create function public.inventory_turnover(
  p_days int default 30,
  p_object_id uuid default null
)
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
  class text,
  requested_days int,
  history_days int,
  history_coverage numeric,
  history_start date
)
language plpgsql stable security invoker set search_path = public as $$
#variable_conflict use_column
declare
  v_tz text := app_timezone();
  v_today date := (now() at time zone v_tz)::date;
  v_requested_from date;
begin
  if p_days is null or p_days < 7 or p_days > 365 then
    raise exception 'Period must be between 7 and 365 days' using errcode = '22023';
  end if;

  v_requested_from := v_today - (p_days - 1);

  return query
  with
  assigned as (
    select op.object_id, op.product_id, coalesce(i.quantity, 0) as qty
    from object_products op
    left join inventory i
      on i.object_id = op.object_id and i.product_id = op.product_id
    where p_object_id is null or op.object_id = p_object_id
  ),
  first_event as (
    select m.object_id, m.product_id,
           min((m.occurred_at at time zone v_tz)::date) as first_day
    from stock_movements m
    join assigned a on a.object_id = m.object_id and a.product_id = m.product_id
    group by 1,2
  ),
  base as (
    select a.object_id, a.product_id, a.qty,
           f.first_day,
           case when f.first_day is null then null
                else greatest(v_requested_from, f.first_day) end as effective_from,
           case when f.first_day is null then 0
                else (v_today - greatest(v_requested_from, f.first_day) + 1)::int end as hdays
    from assigned a
    left join first_event f using (object_id, product_id)
  ),
  mv as (
    select m.object_id, m.product_id, m.event, m.quantity,
           m.unit_price, m.unit_cost, m.occurred_at,
           (m.occurred_at at time zone v_tz)::date as d
    from stock_movements m
    join base b on b.object_id = m.object_id and b.product_id = m.product_id
    where b.effective_from is not null
      and m.occurred_at >= (b.effective_from::timestamp at time zone v_tz)
  ),
  net as (
    select object_id, product_id, d, sum(quantity) as n
    from mv group by 1,2,3
  ),
  grid as (
    select b.object_id, b.product_id, b.qty, b.first_day, b.effective_from, b.hdays,
           g.d::date as d
    from base b
    cross join lateral generate_series(b.effective_from, v_today, interval '1 day') g(d)
    where b.effective_from is not null
  ),
  daily as (
    select g.object_id, g.product_id, g.hdays,
           g.qty - coalesce(sum(coalesce(n.n,0)) over (
             partition by g.object_id, g.product_id
             order by g.d desc
             rows between unbounded preceding and 1 preceding
           ),0) as eod
    from grid g
    left join net n on n.object_id=g.object_id and n.product_id=g.product_id and n.d=g.d
  ),
  stock as (
    select object_id, product_id, max(hdays)::int as hdays,
           avg(greatest(eod,0)) as avg_stock,
           count(*) filter(where eod<=0)::int as days_out
    from daily group by 1,2
  ),
  sales as (
    select object_id, product_id,
           sum(-quantity)::int as sold,
           sum(-quantity*unit_price) as revenue,
           sum(-quantity*unit_cost) as cogs,
           sum(-quantity*(unit_price-unit_cost)) as margin,
           sum(abs(quantity)) filter(where unit_price is not null)::numeric
             / nullif(sum(abs(quantity)),0) as priced_share
    from mv
    where event in ('SALE','RETURN')
    group by 1,2
  ),
  last_sale as (
    select m.object_id, m.product_id, max(m.occurred_at) as at
    from stock_movements m
    join base b on b.object_id=m.object_id and b.product_id=m.product_id
    where m.event='SALE'
    group by 1,2
  ),
  calc as (
    select b.object_id,b.product_id,b.qty,b.first_day,b.hdays,
           greatest(coalesce(s.sold,0),0) as sold,
           coalesce(st.avg_stock,0) as avg_stock,
           coalesce(st.days_out,0) as days_out,
           s.revenue,s.cogs,s.margin,s.priced_share,ls.at as last_sale_at
    from base b
    left join stock st using(object_id,product_id)
    left join sales s using(object_id,product_id)
    left join last_sale ls using(object_id,product_id)
  )
  select c.object_id,o.name,c.product_id,p.sku,p.name,p.category,
         c.qty::int,c.sold::int,round(c.avg_stock,2),
         round(c.sold/nullif(c.avg_stock,0),2),
         round(c.hdays*c.avg_stock/nullif(c.sold,0),1),
         c.days_out,round(c.revenue,2),round(c.cogs,2),round(c.margin,2),
         round(c.priced_share,4),
         case when c.qty>0 and p.cost_price is not null then round(c.qty*p.cost_price,2) end,
         c.last_sale_at,
         case
           when c.hdays=0 and c.qty<=0 then 'idle'
           when c.sold=0 and c.qty<=0 then 'idle'
           when c.sold=0 then 'dead'
           when c.days_out>0 then 'stockout'
           when c.sold/nullif(c.avg_stock,0)*30/nullif(c.hdays,0)>=4 then 'fast'
           when c.sold/nullif(c.avg_stock,0)*30/nullif(c.hdays,0)>=1 then 'normal'
           when c.avg_stock=0 then 'fast'
           else 'slow'
         end,
         p_days,c.hdays,
         round(c.hdays::numeric/p_days,4),
         c.first_day
  from calc c
  join objects o on o.id=c.object_id
  join products p on p.id=c.product_id
  where p.active and o.active;
end;
$$;

revoke all on function public.inventory_turnover(int,uuid) from public,anon;
grant execute on function public.inventory_turnover(int,uuid) to authenticated;

create function public.inventory_performance_summary(
  p_days int default 30,
  p_object_id uuid default null
)
returns jsonb
language plpgsql stable security invoker set search_path=public as $$
declare v_result jsonb;
begin
  with perf as (select * from inventory_turnover(p_days,p_object_id)),
  agg as (
    select coalesce(sum(on_hand),0)::numeric on_hand,
           coalesce(sum(sold),0)::numeric sold,
           coalesce(sum(avg_stock),0)::numeric avg_stock,
           coalesce(sum(revenue),0)::numeric revenue,
           coalesce(sum(cogs),0)::numeric cogs,
           coalesce(sum(margin),0)::numeric margin,
           coalesce(sum(stock_value),0)::numeric inventory_value,
           count(*)::int products,
           count(*) filter(where on_hand>0)::int stocked_products,
           count(*) filter(where class='fast')::int fast,
           count(*) filter(where class='normal')::int normal,
           count(*) filter(where class='slow')::int slow,
           count(*) filter(where class='dead')::int dead,
           count(*) filter(where class='stockout')::int stockout,
           count(*) filter(where class='idle')::int idle,
           count(*) filter(where on_hand>0 and stock_value is not null)::int valued_stocked,
           count(*) filter(where sold>0 and priced_share=1)::int fully_priced_sellers,
           count(*) filter(where sold>0)::int selling_products,
           coalesce(min(history_days) filter(where history_days>0),0)::int history_days_min,
           coalesce(max(history_days),0)::int history_days_max,
           coalesce(sum(sold/nullif(history_days,0)),0)::numeric daily_sales_rate
    from perf
  ),
  slow_value as (select coalesce(sum(stock_value),0)::numeric v from perf where class in('slow','dead'))
  select jsonb_build_object(
    'generated_at',now(),'days',p_days,'currency',app_currency(),
    'history_days_min',a.history_days_min,'history_days_max',a.history_days_max,
    'history_complete',a.history_days_min>=p_days,
    'history_coverage',round(a.history_days_min::numeric/p_days,4),
    'inventory_value',round(a.inventory_value,2),
    'cost_coverage',round(a.valued_stocked::numeric/nullif(a.stocked_products,0),4),
    'sold_units',a.sold,'avg_stock',round(a.avg_stock,2),
    'turnover',round(a.sold/nullif(a.avg_stock,0),2),
    'days_of_inventory',round(a.avg_stock/nullif(a.daily_sales_rate,0),1),
    'revenue',round(a.revenue,2),'cogs',round(a.cogs,2),'margin',round(a.margin,2),
    'gross_margin_pct',round(100*a.margin/nullif(a.revenue,0),2),
    'price_coverage',round(a.fully_priced_sellers::numeric/nullif(a.selling_products,0),4),
    'slow_dead_value',round(sv.v,2),'slow_dead_share',round(sv.v/nullif(a.inventory_value,0),4),
    'classes',jsonb_build_object('fast',a.fast,'normal',a.normal,'slow',a.slow,'dead',a.dead,'stockout',a.stockout,'idle',a.idle),
    'actions',coalesce((select jsonb_agg(x order by x.rank,x.stock_value desc nulls last,x.object_name,x.product_name)
      from (select object_id,object_name,product_id,sku,product_name,on_hand,sold,turnover,days_of_stock,days_out,stock_value,class,
            requested_days,history_days,history_coverage,
            case class when 'stockout' then 0 when 'dead' then 1 when 'slow' then 2 else 3 end rank
            from perf where class in('stockout','dead','slow') order by rank,stock_value desc nulls last limit 12) x),'[]'::jsonb)
  ) into v_result from agg a cross join slow_value sv;
  return v_result;
end;
$$;

revoke all on function public.inventory_performance_summary(int,uuid) from public,anon;
grant execute on function public.inventory_performance_summary(int,uuid) to authenticated;

commit;

-- Verification
select object_name,sku,requested_days,history_days,history_coverage,avg_stock,turnover,days_of_stock,days_out,class
from public.inventory_turnover(365)
order by object_name,sku;
