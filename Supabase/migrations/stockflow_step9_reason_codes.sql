-- =====================================================================
-- Stockflow · Step 9 · Standardized variance reasons (P2.2)
--
--  1. stock_count_items.reason_code + delivery_items.reason_code
--  2. Backfill of existing rows (best guess from the old free text)
--  3. record_stock_count / record_delivery: reason_code required on variance,
--     free-text reason becomes an optional note (label stored if empty,
--     so old screens still show something readable)
--  4. stock_accuracy_report: reasons grouped by code, shrinkage KPI,
--     initialization detected by code instead of text
--
-- The `reason` columns are kept and keep holding human-readable text.
-- Run as ONE script in the Supabase SQL editor.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Columns + allowed values
-- ---------------------------------------------------------------------
alter table public.stock_count_items add column if not exists reason_code text;
alter table public.delivery_items    add column if not exists reason_code text;

alter table public.stock_count_items
  drop constraint if exists stock_count_items_reason_code_chk,
  add  constraint stock_count_items_reason_code_chk check (
    reason_code is null or reason_code in
      ('FOUND_STOCK','MISSING','DAMAGED','THEFT','COUNT_ERROR','OPENING_BALANCE','OTHER'));

alter table public.delivery_items
  drop constraint if exists delivery_items_reason_code_chk,
  add  constraint delivery_items_reason_code_chk check (
    reason_code is null or reason_code in
      ('SUPPLIER_SHORT','SUPPLIER_OVER','DAMAGED','WRONG_ITEM','OTHER'));

-- Human label, used for notes when the user does not type one
create or replace function public.reason_label(p_code text)
returns text language sql immutable as $$
  select case p_code
    when 'FOUND_STOCK'     then 'Found stock'
    when 'MISSING'         then 'Missing'
    when 'DAMAGED'         then 'Damaged'
    when 'THEFT'           then 'Theft'
    when 'COUNT_ERROR'     then 'Count error'
    when 'OPENING_BALANCE' then 'Opening balance'
    when 'SUPPLIER_SHORT'  then 'Supplier short'
    when 'SUPPLIER_OVER'   then 'Supplier over'
    when 'WRONG_ITEM'      then 'Wrong item'
    when 'OTHER'           then 'Other'
  end;
$$;

-- ---------------------------------------------------------------------
-- 2. Backfill existing variances (only rows without a code)
-- ---------------------------------------------------------------------
update public.stock_count_items
set reason_code = case
    when reason ~* 'opening'                      then 'OPENING_BALANCE'
    when reason ~* 'found|extra|back room'   then 'FOUND_STOCK'
    when reason ~* 'damag|broken|expired'         then 'DAMAGED'
    when reason ~* 'theft|stol'                   then 'THEFT'
    when reason ~* 'miscount|count|wrong'         then 'COUNT_ERROR'
    when reason ~* 'miss|less|lost'               then 'MISSING'
    when variance > 0                             then 'FOUND_STOCK'
    else 'MISSING'
  end
where variance <> 0 and reason_code is null;

update public.delivery_items di
set reason_code = case
    when di.reason ~* 'damag|broken'              then 'DAMAGED'
    when di.reason ~* 'wrong'                     then 'WRONG_ITEM'
    when di.reason ~* 'short|missing|backorder'   then 'SUPPLIER_SHORT'
    when di.reason ~* 'additional|extra|over'     then 'SUPPLIER_OVER'
    when di.delivered_qty > oi.quantity           then 'SUPPLIER_OVER'
    when di.delivered_qty < oi.quantity           then 'SUPPLIER_SHORT'
    else 'OTHER'
  end
from public.order_items oi
where oi.id = di.order_item_id
  and di.delivered_qty <> oi.quantity
  and di.reason_code is null;

-- ---------------------------------------------------------------------
-- 3a. record_stock_count (same signature, items get "reason_code")
-- ---------------------------------------------------------------------
create or replace function public.record_stock_count(
  p_object_id uuid, p_counted_by text, p_note text, p_items jsonb)
returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count_id uuid;
  v_item     jsonb;
  v_product  uuid;
  v_counted  int;
  v_expected int;
  v_variance int;
  v_note     text;
  v_code     text;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'A stock count must include at least one product.';
  end if;
  if p_object_id is null then
    raise exception 'Object is required for a stock count.';
  end if;

  perform public.assert_object_access(p_object_id);

  insert into public.stock_counts (object_id, counted_by, recorded_by, note)
  values (p_object_id, p_counted_by, auth.uid(), p_note)
  returning id into v_count_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product := (v_item->>'product_id')::uuid;
    v_counted := (v_item->>'counted_qty')::int;
    v_note    := nullif(btrim(coalesce(v_item->>'reason', '')), '');
    v_code    := nullif(upper(btrim(coalesce(v_item->>'reason_code', ''))), '');

    if v_counted is null or v_counted < 0 then
      raise exception 'Counted quantity must be zero or a positive number.';
    end if;

    select quantity into v_expected
    from public.inventory
    where object_id = p_object_id and product_id = v_product
    for update;

    v_expected := coalesce(v_expected, 0);
    v_variance := v_counted - v_expected;

    if v_variance = 0 then
      v_code := null;
    else
      -- Older callers (e.g. opening import) only send free text
      if v_code is null and v_note is not null then
        v_code := case when v_note ~* 'opening' then 'OPENING_BALANCE' else 'OTHER' end;
      end if;
      if v_code is null then
        raise exception 'A reason is required for product % (expected %, counted %).',
          v_product, v_expected, v_counted;
      end if;
      if v_code not in ('FOUND_STOCK','MISSING','DAMAGED','THEFT','COUNT_ERROR','OPENING_BALANCE','OTHER') then
        raise exception 'Invalid count reason %.', v_code using errcode = '22023';
      end if;
      v_note := coalesce(v_note, public.reason_label(v_code));
    end if;

    insert into public.stock_count_items
      (count_id, product_id, expected_qty, counted_qty, variance, reason, reason_code)
    values (v_count_id, v_product, v_expected, v_counted, v_variance, v_note, v_code);

    if v_variance <> 0 then
      insert into public.stock_movements
        (object_id, product_id, event, quantity, reference, note, created_by)
      values (
        p_object_id, v_product, 'STOCK_COUNT', v_variance,
        'count:' || v_count_id,
        coalesce(v_note, 'Stock count correction'),
        auth.uid()
      );
    end if;
  end loop;

  return v_count_id;
end;
$function$;

-- ---------------------------------------------------------------------
-- 3b. record_delivery (same signature, items get "reason_code")
-- ---------------------------------------------------------------------
create or replace function public.record_delivery(
  p_order_id uuid, p_carrier text, p_received_by text, p_note text, p_items jsonb)
returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $function$
declare
  v_delivery_id uuid;
  v_object_id   uuid;
  v_status      order_status;
  v_item        jsonb;
  v_oi_id       uuid;
  v_delivered   int;
  v_ordered     int;
  v_reason      text;
  v_code        text;
  v_line_count  int;
  v_order_lines int;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'A delivery must record every line of the order.';
  end if;

  select object_id, status into v_object_id, v_status
  from public.orders where id = p_order_id for update;

  if v_object_id is null then
    raise exception 'Order % not found.', p_order_id;
  end if;

  perform public.assert_object_access(v_object_id);

  if v_status <> 'APPROVED' then
    raise exception 'Order must be APPROVED to record delivery (current: %).', v_status;
  end if;
  if exists (select 1 from public.deliveries where order_id = p_order_id) then
    raise exception 'This order has already been delivered.';
  end if;

  select count(*) into v_order_lines from public.order_items where order_id = p_order_id;
  select count(distinct (x->>'order_item_id')::uuid) into v_line_count
  from jsonb_array_elements(p_items) x;

  if v_line_count <> v_order_lines then
    raise exception 'Delivery must account for all % order lines (got %).', v_order_lines, v_line_count;
  end if;

  insert into public.deliveries(order_id, object_id, carrier, received_by, recorded_by, note)
  values (p_order_id, v_object_id,
          nullif(btrim(p_carrier), ''), nullif(btrim(p_received_by), ''),
          auth.uid(), nullif(btrim(p_note), ''))
  returning id into v_delivery_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_oi_id     := (v_item->>'order_item_id')::uuid;
    v_delivered := (v_item->>'delivered_qty')::int;
    v_reason    := nullif(btrim(coalesce(v_item->>'reason', '')), '');
    v_code      := nullif(upper(btrim(coalesce(v_item->>'reason_code', ''))), '');

    if v_delivered is null or v_delivered < 0 then
      raise exception 'Delivered quantity must be zero or a positive number.';
    end if;

    select quantity into v_ordered
    from public.order_items where id = v_oi_id and order_id = p_order_id;

    if v_ordered is null then
      raise exception 'Order item % does not belong to order %.', v_oi_id, p_order_id;
    end if;

    if v_delivered = v_ordered then
      v_code := null;
    else
      if v_code is null and v_reason is not null then
        v_code := case when v_delivered < v_ordered then 'SUPPLIER_SHORT' else 'SUPPLIER_OVER' end;
      end if;
      if v_code is null then
        raise exception 'A reason is required for line % (ordered %, delivered %).',
          v_oi_id, v_ordered, v_delivered;
      end if;
      if v_code not in ('SUPPLIER_SHORT','SUPPLIER_OVER','DAMAGED','WRONG_ITEM','OTHER') then
        raise exception 'Invalid delivery reason %.', v_code using errcode = '22023';
      end if;
      v_reason := coalesce(v_reason, public.reason_label(v_code));
    end if;

    insert into public.delivery_items(delivery_id, order_item_id, product_id, delivered_qty, reason, reason_code)
    select v_delivery_id, oi.id, oi.product_id, v_delivered, v_reason, v_code
    from public.order_items oi where oi.id = v_oi_id;

    if v_delivered > 0 then
      insert into public.stock_movements(object_id, product_id, event, quantity, reference, note, created_by)
      select v_object_id, oi.product_id, 'DELIVERY', v_delivered,
             'delivery:' || v_delivery_id,
             coalesce(v_reason, nullif(btrim(p_note), ''), 'Delivery'),
             auth.uid()
      from public.order_items oi where oi.id = v_oi_id;
    end if;
  end loop;

  update public.orders set status = 'DELIVERED' where id = p_order_id;
  return v_delivery_id;
end;
$function$;

-- ---------------------------------------------------------------------
-- 4. stock_accuracy_report v3
-- ---------------------------------------------------------------------
create or replace function public.stock_accuracy_report(
  p_days int default 30,
  p_object_id uuid default null
)
returns jsonb
language plpgsql stable security invoker set search_path = public
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
  all_count_lines as (
    select sc.id count_id, sc.object_id, o.name object_name, sc.counted_at,
           sci.product_id, p.sku, p.name product_name,
           sci.expected_qty, sci.counted_qty, sci.variance,
           sci.reason, sci.reason_code, p.cost_price,
           case when p.cost_price is not null then abs(sci.variance) * p.cost_price end variance_value,
           (sci.reason_code = 'OPENING_BALANCE'
             or lower(coalesce(btrim(sci.reason), '')) = 'opening balance') as is_initialization
    from stock_counts sc
    join stock_count_items sci on sci.count_id = sc.id
    join objects o on o.id = sc.object_id
    join products p on p.id = sci.product_id
    where sc.counted_at >= v_from
      and (p_object_id is null or sc.object_id = p_object_id)
  ),
  count_lines as (select * from all_count_lines where not is_initialization),
  initialization_agg as (
    select count(distinct count_id)::int sessions, count(*)::int lines,
           count(*) filter (where variance <> 0)::int variance_lines,
           coalesce(sum(variance_value) filter (where variance <> 0), 0)::numeric variance_value
    from all_count_lines where is_initialization
  ),
  count_agg as (
    select count(distinct count_id)::int sessions, count(*)::int lines,
           count(*) filter (where variance = 0)::int exact_lines,
           count(*) filter (where variance < 0)::int short_lines,
           count(*) filter (where variance > 0)::int over_lines,
           count(distinct product_id) filter (where variance <> 0)::int affected_products,
           coalesce(sum(variance_value), 0)::numeric variance_value,
           -- real loss: units that disappeared for a known loss reason
           coalesce(sum(variance_value) filter (
             where variance < 0 and reason_code in ('MISSING','THEFT','DAMAGED')), 0)::numeric shrinkage_value,
           count(*) filter (where variance <> 0 and cost_price is not null)::int valued_variance_lines,
           count(*) filter (where variance <> 0)::int variance_lines
    from count_lines
  ),
  delivery_lines as (
    select f.order_id, ord.object_id, o.name object_name, f.delivered_at, f.product_id,
           p.sku, p.name product_name, f.ordered_qty, f.delivered_qty,
           coalesce(f.variance, f.delivered_qty - f.ordered_qty) variance,
           f.reason, di.reason_code, p.cost_price,
           case when p.cost_price is not null
                then abs(coalesce(f.variance, f.delivered_qty - f.ordered_qty)) * p.cost_price end variance_value
    from order_fulfillment f
    join orders ord on ord.id = f.order_id
    join objects o on o.id = ord.object_id
    join products p on p.id = f.product_id
    left join delivery_items di
      on di.delivery_id = f.delivery_id and di.order_item_id = f.order_item_id
    where f.delivered_at is not null and f.delivered_at >= v_from
      and (p_object_id is null or ord.object_id = p_object_id)
  ),
  delivery_agg as (
    select count(distinct order_id)::int deliveries, count(*)::int lines,
           count(*) filter (where variance = 0)::int exact_lines,
           count(*) filter (where variance < 0)::int short_lines,
           count(*) filter (where variance > 0)::int over_lines,
           count(distinct product_id) filter (where variance <> 0)::int affected_products,
           coalesce(sum(variance_value), 0)::numeric variance_value,
           coalesce(sum(variance_value) filter (where variance < 0 and reason_code = 'DAMAGED'), 0)::numeric shrinkage_value,
           count(*) filter (where variance <> 0 and cost_price is not null)::int valued_variance_lines,
           count(*) filter (where variance <> 0)::int variance_lines
    from delivery_lines
  ),
  product_issues as (
    select object_id, object_name, product_id, sku, product_name,
           sum(count_issues)::int count_issues, sum(delivery_issues)::int delivery_issues,
           sum(issue_value)::numeric issue_value, max(last_issue_at) last_issue_at
    from (
      select object_id, object_name, product_id, sku, product_name,
             count(*) filter (where variance <> 0) count_issues, 0::bigint delivery_issues,
             coalesce(sum(variance_value) filter (where variance <> 0), 0) issue_value,
             max(counted_at) filter (where variance <> 0) last_issue_at
      from count_lines group by 1,2,3,4,5
      union all
      select object_id, object_name, product_id, sku, product_name, 0::bigint,
             count(*) filter (where variance <> 0),
             coalesce(sum(variance_value) filter (where variance <> 0), 0),
             max(delivered_at) filter (where variance <> 0)
      from delivery_lines group by 1,2,3,4,5
    ) x
    group by 1,2,3,4,5
    having sum(count_issues) + sum(delivery_issues) > 0
  ),
  reasons as (
    select type, coalesce(reason_code, 'OTHER') code, count(*)::int occurrences,
           round(coalesce(sum(variance_value), 0), 2) value
    from (
      select 'count'::text type, reason_code, variance_value from count_lines where variance <> 0
      union all
      select 'delivery', reason_code, variance_value from delivery_lines where variance <> 0
    ) r
    group by 1, 2
  )
  select jsonb_build_object(
    'days', p_days, 'currency', app_currency(), 'generated_at', now(),
    'counts', jsonb_build_object(
      'sessions', c.sessions, 'lines', c.lines, 'exact_lines', c.exact_lines,
      'short_lines', c.short_lines, 'over_lines', c.over_lines,
      'affected_products', c.affected_products,
      'accuracy_pct', round(100 * c.exact_lines::numeric / nullif(c.lines, 0), 1),
      'variance_value', round(c.variance_value, 2),
      'shrinkage_value', round(c.shrinkage_value, 2),
      'value_coverage', round(c.valued_variance_lines::numeric / nullif(c.variance_lines, 0), 4)
    ),
    'initialization', jsonb_build_object(
      'sessions', ia.sessions, 'lines', ia.lines, 'variance_lines', ia.variance_lines,
      'variance_value', round(ia.variance_value, 2), 'excluded_from_accuracy', true
    ),
    'deliveries', jsonb_build_object(
      'deliveries', d.deliveries, 'lines', d.lines, 'exact_lines', d.exact_lines,
      'short_lines', d.short_lines, 'over_lines', d.over_lines,
      'affected_products', d.affected_products,
      'accuracy_pct', round(100 * d.exact_lines::numeric / nullif(d.lines, 0), 1),
      'variance_value', round(d.variance_value, 2),
      'shrinkage_value', round(d.shrinkage_value, 2),
      'value_coverage', round(d.valued_variance_lines::numeric / nullif(d.variance_lines, 0), 4)
    ),
    'top_issues', coalesce((
      select jsonb_agg(q order by q.total_issues desc, q.issue_value desc, q.last_issue_at desc)
      from (
        select object_id, object_name, product_id, sku, product_name, count_issues, delivery_issues,
               count_issues + delivery_issues total_issues, round(issue_value, 2) issue_value, last_issue_at
        from product_issues
        order by count_issues + delivery_issues desc, issue_value desc, last_issue_at desc
        limit 10
      ) q), '[]'::jsonb),
    'reasons', coalesce((
      select jsonb_agg(q order by q.occurrences desc, q.value desc)
      from (select * from reasons order by occurrences desc, value desc limit 12) q), '[]'::jsonb),
    'recent_count_issues', coalesce((
      select jsonb_agg(q order by q.counted_at desc)
      from (
        select count_id, object_id, object_name, product_id, sku, product_name,
               expected_qty, counted_qty, variance, reason, reason_code,
               round(variance_value, 2) variance_value, counted_at
        from count_lines where variance <> 0
        order by counted_at desc limit 20
      ) q), '[]'::jsonb),
    'recent_delivery_issues', coalesce((
      select jsonb_agg(q order by q.delivered_at desc)
      from (
        select order_id, object_id, object_name, product_id, sku, product_name,
               ordered_qty, delivered_qty, variance, reason, reason_code,
               round(variance_value, 2) variance_value, delivered_at
        from delivery_lines where variance <> 0
        order by delivered_at desc limit 20
      ) q), '[]'::jsonb)
  ) into v_result
  from count_agg c cross join delivery_agg d cross join initialization_agg ia;

  return v_result;
end;
$$;

revoke all on function public.stock_accuracy_report(int, uuid) from public, anon;
grant execute on function public.stock_accuracy_report(int, uuid) to authenticated;

commit;

-- =====================================================================
-- Checks
-- =====================================================================
-- How the old free text was classified:
select 'count' as type, reason, reason_code, count(*)
from stock_count_items where variance <> 0 group by 1, 2, 3
union all
select 'delivery', di.reason, di.reason_code, count(*)
from delivery_items di join order_items oi on oi.id = di.order_item_id
where di.delivered_qty <> oi.quantity group by 1, 2, 3
order by 1, 4 desc;
