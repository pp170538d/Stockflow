-- Stockflow Step 15 - Small supplier performance
create or replace function public.supplier_performance(
  p_supplier_id uuid,
  p_days integer default 90
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_since timestamptz := now() - make_interval(days => p_days);
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only admin can view supplier performance' using errcode='42501';
  end if;
  if p_days not between 7 and 365 then
    raise exception 'Period must be between 7 and 365 days' using errcode='22023';
  end if;
  if not exists (select 1 from public.suppliers where id=p_supplier_id) then
    raise exception 'Supplier not found' using errcode='P0002';
  end if;

  with po as (
    select o.id, o.approved_at
    from public.orders o
    where o.supplier_id=p_supplier_id
      and o.status in ('APPROVED','DELIVERED')
      and coalesce(o.approved_at,o.created_at) >= v_since
  ),
  rec as (
    select d.id, d.order_id, d.delivered_at, po.approved_at
    from public.deliveries d join po on po.id=d.order_id
  ),
  lines as (
    select di.id, di.product_id, di.reason_code,
           oi.quantity as ordered_qty, di.delivered_qty,
           (di.delivered_qty-oi.quantity) as variance,
           oi.unit_cost,
           r.delivered_at, r.approved_at
    from rec r
    join public.delivery_items di on di.delivery_id=r.id
    join public.order_items oi on oi.id=di.order_item_id
  ),
  line_stats as (
    select count(*)::int lines,
      count(*) filter(where variance=0)::int exact_lines,
      count(*) filter(where variance<0)::int short_lines,
      count(*) filter(where variance>0)::int over_lines,
      count(*) filter(where reason_code='DAMAGED')::int damaged_lines,
      count(*) filter(where reason_code='WRONG_ITEM')::int wrong_item_lines,
      coalesce(sum(abs(variance)*unit_cost) filter(where variance<>0 and unit_cost is not null),0)::numeric exposure,
      count(*) filter(where variance<>0 and unit_cost is not null)::int valued_diff,
      count(*) filter(where variance<>0)::int diff_lines
    from lines
  ),
  lead as (
    select avg(extract(epoch from (delivered_at-approved_at))/86400.0)::numeric avg_days,
           percentile_cont(0.5) within group(order by extract(epoch from (delivered_at-approved_at))/86400.0)::numeric median_days
    from rec where approved_at is not null and delivered_at>=approved_at
  ),
  receipt_stats as (
    select count(*)::int receipts,
      count(*) filter(where not exists(select 1 from lines l where l.order_id=rec.order_id and l.variance<>0))::int perfect_receipts
    from rec
  ),
  price_rows as (
    select oi.product_id, oi.unit_cost, coalesce(o.approved_at,o.created_at) at,
      row_number() over(partition by oi.product_id order by coalesce(o.approved_at,o.created_at) desc, oi.id desc) rn
    from po
    join public.orders o on o.id=po.id
    join public.order_items oi on oi.order_id=o.id
    where oi.unit_cost is not null
  ),
  price_stats as (
    select count(*) filter(where p2.unit_cost is not null)::int comparable_products,
      avg(case when p2.unit_cost>0 then (p1.unit_cost-p2.unit_cost)/p2.unit_cost*100 end)::numeric avg_change_pct
    from price_rows p1 left join price_rows p2 on p2.product_id=p1.product_id and p2.rn=2
    where p1.rn=1
  )
  select jsonb_build_object(
    'days',p_days,
    'currency',public.app_currency(),
    'orders',(select count(*) from po),
    'receipts',rs.receipts,
    'perfect_receipts',rs.perfect_receipts,
    'lines',ls.lines,
    'exact_lines',ls.exact_lines,
    'delivery_accuracy',case when ls.lines>0 then round(ls.exact_lines::numeric/ls.lines,4) end,
    'short_lines',ls.short_lines,
    'over_lines',ls.over_lines,
    'damaged_lines',ls.damaged_lines,
    'wrong_item_lines',ls.wrong_item_lines,
    'variance_exposure',round(ls.exposure,2),
    'value_coverage',case when ls.diff_lines>0 then round(ls.valued_diff::numeric/ls.diff_lines,4) end,
    'avg_lead_time_days',round(lead.avg_days,1),
    'median_lead_time_days',round(lead.median_days,1),
    'avg_price_change_pct',round(ps.avg_change_pct,1),
    'comparable_products',ps.comparable_products
  ) into v_result
  from line_stats ls cross join lead cross join receipt_stats rs cross join price_stats ps;
  return v_result;
end;
$$;
revoke all on function public.supplier_performance(uuid,integer) from public,anon;
grant execute on function public.supplier_performance(uuid,integer) to authenticated;

-- smoke check for every active supplier
select s.name, public.supplier_performance(s.id,90) performance
from public.suppliers s where s.active order by s.name;
