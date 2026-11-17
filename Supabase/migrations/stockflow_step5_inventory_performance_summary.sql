-- Stockflow Step 5: aggregate Inventory Performance summary for Dashboard/Reports.
-- Depends on public.inventory_turnover(int, uuid).

create or replace function public.inventory_performance_summary(
  p_days int default 30,
  p_object_id uuid default null
)
returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_result jsonb;
begin
  if p_days is null or p_days < 7 or p_days > 365 then
    raise exception 'Period must be between 7 and 365 days' using errcode = '22023';
  end if;

  with perf as (
    select * from public.inventory_turnover(p_days, p_object_id)
  ),
  agg as (
    select
      coalesce(sum(on_hand),0)::numeric as on_hand,
      coalesce(sum(sold),0)::numeric as sold,
      coalesce(sum(avg_stock),0)::numeric as avg_stock,
      coalesce(sum(revenue),0)::numeric as revenue,
      coalesce(sum(cogs),0)::numeric as cogs,
      coalesce(sum(margin),0)::numeric as margin,
      coalesce(sum(stock_value),0)::numeric as inventory_value,
      count(*)::int as products,
      count(*) filter (where on_hand > 0)::int as stocked_products,
      count(*) filter (where class='fast')::int as fast,
      count(*) filter (where class='normal')::int as normal,
      count(*) filter (where class='slow')::int as slow,
      count(*) filter (where class='dead')::int as dead,
      count(*) filter (where class='stockout')::int as stockout,
      count(*) filter (where class='idle')::int as idle,
      count(*) filter (where on_hand > 0 and stock_value is not null)::int as valued_stocked,
      count(*) filter (where sold > 0 and priced_share = 1)::int as fully_priced_sellers,
      count(*) filter (where sold > 0)::int as selling_products
    from perf
  ),
  slow_value as (
    select coalesce(sum(stock_value),0)::numeric v from perf where class in ('slow','dead')
  )
  select jsonb_build_object(
    'generated_at', now(),
    'days', p_days,
    'currency', public.app_currency(),
    'inventory_value', round(a.inventory_value,2),
    'cost_coverage', round(a.valued_stocked::numeric / nullif(a.stocked_products,0),4),
    'sold_units', a.sold,
    'avg_stock', round(a.avg_stock,2),
    'turnover', round(a.sold / nullif(a.avg_stock,0),2),
    'days_of_inventory', round(p_days * a.avg_stock / nullif(a.sold,0),1),
    'revenue', round(a.revenue,2),
    'cogs', round(a.cogs,2),
    'margin', round(a.margin,2),
    'gross_margin_pct', round(100 * a.margin / nullif(a.revenue,0),2),
    'price_coverage', round(a.fully_priced_sellers::numeric / nullif(a.selling_products,0),4),
    'slow_dead_value', round(sv.v,2),
    'slow_dead_share', round(sv.v / nullif(a.inventory_value,0),4),
    'classes', jsonb_build_object(
      'fast',a.fast,'normal',a.normal,'slow',a.slow,
      'dead',a.dead,'stockout',a.stockout,'idle',a.idle
    ),
    'actions', coalesce((
      select jsonb_agg(x order by x.rank, x.stock_value desc nulls last, x.object_name, x.product_name)
      from (
        select object_id, object_name, product_id, sku, product_name, on_hand, sold,
               turnover, days_of_stock, days_out, stock_value, class,
               case class when 'stockout' then 0 when 'dead' then 1 when 'slow' then 2 else 3 end rank
        from perf
        where class in ('stockout','dead','slow')
        order by rank, stock_value desc nulls last
        limit 12
      ) x
    ), '[]'::jsonb)
  ) into v_result
  from agg a cross join slow_value sv;

  return v_result;
end;
$$;

revoke all on function public.inventory_performance_summary(int, uuid) from public, anon;
grant execute on function public.inventory_performance_summary(int, uuid) to authenticated;

-- TEST:
-- select jsonb_pretty(public.inventory_performance_summary(30));
