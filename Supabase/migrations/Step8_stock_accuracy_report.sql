-- =====================================================================
-- Stockflow Step 8 · Stock Accuracy report backend
--
-- Purpose:
--   Give Reports a real analytical Stock Accuracy tab without replacing
--   the operational Stock Count / Orders histories.
--
-- Primary metrics deliberately compare PRODUCT LINES, not summed units
-- across different SKUs:
--   count_accuracy_pct    = exact count lines / count lines
--   delivery_accuracy_pct = exact delivery lines / delivered lines
--
-- Monetary impact IS safely aggregatable because every line is normalized
-- into company currency using products.cost_price.
-- =====================================================================

create or replace function public.stock_accuracy_report(
  p_days int default 30,
  p_object_id uuid default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_tz text := app_timezone();
  v_from timestamptz;
  v_result jsonb;
begin
  if p_days is null or p_days < 7 or p_days > 365 then
    raise exception 'Period must be between 7 and 365 days' using errcode = '22023';
  end if;

  v_from := (((now() at time zone v_tz)::date - (p_days - 1))::timestamp at time zone v_tz);

  with
  count_lines as (
    select
      sc.id as count_id,
      sc.object_id,
      o.name as object_name,
      sc.counted_at,
      sci.product_id,
      p.sku,
      p.name as product_name,
      sci.expected_qty,
      sci.counted_qty,
      sci.variance,
      sci.reason,
      p.cost_price,
      case when p.cost_price is not null
           then abs(sci.variance) * p.cost_price end as variance_value
    from stock_counts sc
    join stock_count_items sci on sci.count_id = sc.id
    join objects o on o.id = sc.object_id
    join products p on p.id = sci.product_id
    where sc.counted_at >= v_from
      and (p_object_id is null or sc.object_id = p_object_id)
  ),
  count_agg as (
    select
      count(distinct count_id)::int as sessions,
      count(*)::int as lines,
      count(*) filter(where variance = 0)::int as exact_lines,
      count(*) filter(where variance < 0)::int as short_lines,
      count(*) filter(where variance > 0)::int as over_lines,
      count(distinct product_id) filter(where variance <> 0)::int as affected_products,
      coalesce(sum(variance_value),0)::numeric as variance_value,
      count(*) filter(where variance <> 0 and cost_price is not null)::int as valued_variance_lines,
      count(*) filter(where variance <> 0)::int as variance_lines
    from count_lines
  ),
  delivery_lines as (
    select
      f.order_id,
      ord.object_id,
      o.name as object_name,
      f.delivered_at,
      f.product_id,
      p.sku,
      p.name as product_name,
      f.ordered_qty,
      f.delivered_qty,
      coalesce(f.variance, f.delivered_qty - f.ordered_qty) as variance,
      f.reason,
      p.cost_price,
      case when p.cost_price is not null
           then abs(coalesce(f.variance, f.delivered_qty - f.ordered_qty)) * p.cost_price end as variance_value
    from order_fulfillment f
    join orders ord on ord.id = f.order_id
    join objects o on o.id = ord.object_id
    join products p on p.id = f.product_id
    where f.delivered_at is not null
      and f.delivered_at >= v_from
      and (p_object_id is null or ord.object_id = p_object_id)
  ),
  delivery_agg as (
    select
      count(distinct order_id)::int as deliveries,
      count(*)::int as lines,
      count(*) filter(where variance = 0)::int as exact_lines,
      count(*) filter(where variance < 0)::int as short_lines,
      count(*) filter(where variance > 0)::int as over_lines,
      count(distinct product_id) filter(where variance <> 0)::int as affected_products,
      coalesce(sum(variance_value),0)::numeric as variance_value,
      count(*) filter(where variance <> 0 and cost_price is not null)::int as valued_variance_lines,
      count(*) filter(where variance <> 0)::int as variance_lines
    from delivery_lines
  ),
  product_issues as (
    select object_id, object_name, product_id, sku, product_name,
           sum(count_issues)::int as count_issues,
           sum(delivery_issues)::int as delivery_issues,
           sum(issue_value)::numeric as issue_value,
           max(last_issue_at) as last_issue_at
    from (
      select object_id, object_name, product_id, sku, product_name,
             count(*) filter(where variance <> 0) as count_issues,
             0::bigint as delivery_issues,
             coalesce(sum(variance_value) filter(where variance <> 0),0) as issue_value,
             max(counted_at) filter(where variance <> 0) as last_issue_at
      from count_lines
      group by 1,2,3,4,5
      union all
      select object_id, object_name, product_id, sku, product_name,
             0::bigint,
             count(*) filter(where variance <> 0),
             coalesce(sum(variance_value) filter(where variance <> 0),0),
             max(delivered_at) filter(where variance <> 0)
      from delivery_lines
      group by 1,2,3,4,5
    ) x
    group by 1,2,3,4,5
    having sum(count_issues) + sum(delivery_issues) > 0
  ),
  reasons as (
    select type, reason, count(*)::int occurrences
    from (
      select 'count'::text type, nullif(btrim(reason),'') reason
      from count_lines where variance <> 0
      union all
      select 'delivery', nullif(btrim(reason),'')
      from delivery_lines where variance <> 0
    ) r
    where reason is not null
    group by 1,2
  )
  select jsonb_build_object(
    'days', p_days,
    'currency', app_currency(),
    'generated_at', now(),

    'counts', jsonb_build_object(
      'sessions', c.sessions,
      'lines', c.lines,
      'exact_lines', c.exact_lines,
      'short_lines', c.short_lines,
      'over_lines', c.over_lines,
      'affected_products', c.affected_products,
      'accuracy_pct', round(100 * c.exact_lines::numeric / nullif(c.lines,0), 1),
      'variance_value', round(c.variance_value,2),
      'value_coverage', round(c.valued_variance_lines::numeric / nullif(c.variance_lines,0),4)
    ),

    'deliveries', jsonb_build_object(
      'deliveries', d.deliveries,
      'lines', d.lines,
      'exact_lines', d.exact_lines,
      'short_lines', d.short_lines,
      'over_lines', d.over_lines,
      'affected_products', d.affected_products,
      'accuracy_pct', round(100 * d.exact_lines::numeric / nullif(d.lines,0), 1),
      'variance_value', round(d.variance_value,2),
      'value_coverage', round(d.valued_variance_lines::numeric / nullif(d.variance_lines,0),4)
    ),

    'top_issues', coalesce((
      select jsonb_agg(q order by q.total_issues desc, q.issue_value desc, q.last_issue_at desc)
      from (
        select object_id, object_name, product_id, sku, product_name,
               count_issues, delivery_issues,
               count_issues + delivery_issues as total_issues,
               round(issue_value,2) as issue_value,
               last_issue_at
        from product_issues
        order by count_issues + delivery_issues desc, issue_value desc, last_issue_at desc
        limit 10
      ) q
    ), '[]'::jsonb),

    'reasons', coalesce((
      select jsonb_agg(q order by q.occurrences desc, q.type, q.reason)
      from (
        select * from reasons order by occurrences desc, type, reason limit 10
      ) q
    ), '[]'::jsonb),

    'recent_count_issues', coalesce((
      select jsonb_agg(q order by q.counted_at desc)
      from (
        select count_id, object_id, object_name, product_id, sku, product_name,
               expected_qty, counted_qty, variance, reason,
               round(variance_value,2) variance_value, counted_at
        from count_lines
        where variance <> 0
        order by counted_at desc
        limit 20
      ) q
    ), '[]'::jsonb),

    'recent_delivery_issues', coalesce((
      select jsonb_agg(q order by q.delivered_at desc)
      from (
        select order_id, object_id, object_name, product_id, sku, product_name,
               ordered_qty, delivered_qty, variance, reason,
               round(variance_value,2) variance_value, delivered_at
        from delivery_lines
        where variance <> 0
        order by delivered_at desc
        limit 20
      ) q
    ), '[]'::jsonb)
  ) into v_result
  from count_agg c cross join delivery_agg d;

  return v_result;
end;
$$;

revoke all on function public.stock_accuracy_report(int, uuid) from public, anon;
grant execute on function public.stock_accuracy_report(int, uuid) to authenticated;

-- Verification
select jsonb_pretty(public.stock_accuracy_report(30));
