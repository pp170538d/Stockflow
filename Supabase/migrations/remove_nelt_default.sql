-- Removes the historical hardcoded NELT fallback from delivery recording.
-- Carrier remains optional and is stored as NULL when left blank.
create or replace function public.record_delivery(
  p_order_id uuid,
  p_carrier text,
  p_received_by text,
  p_note text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery_id uuid;
  v_object_id uuid;
  v_status order_status;
  v_item jsonb;
  v_oi_id uuid;
  v_delivered int;
  v_ordered int;
  v_reason text;
  v_line_count int;
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
  values (
    p_order_id,
    v_object_id,
    nullif(btrim(p_carrier), ''),
    nullif(btrim(p_received_by), ''),
    auth.uid(),
    nullif(btrim(p_note), '')
  )
  returning id into v_delivery_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_oi_id := (v_item->>'order_item_id')::uuid;
    v_delivered := (v_item->>'delivered_qty')::int;
    v_reason := nullif(trim(coalesce(v_item->>'reason', '')), '');

    if v_delivered is null or v_delivered < 0 then
      raise exception 'Delivered quantity must be zero or a positive number.';
    end if;

    select quantity into v_ordered
    from public.order_items where id = v_oi_id and order_id = p_order_id;

    if v_ordered is null then
      raise exception 'Order item % does not belong to order %.', v_oi_id, p_order_id;
    end if;
    if v_delivered <> v_ordered and v_reason is null then
      raise exception 'A reason is required for line % (ordered %, delivered %).',
        v_oi_id, v_ordered, v_delivered;
    end if;

    insert into public.delivery_items(delivery_id, order_item_id, product_id, delivered_qty, reason)
    select v_delivery_id, oi.id, oi.product_id, v_delivered, v_reason
    from public.order_items oi where oi.id = v_oi_id;

    if v_delivered > 0 then
      insert into public.stock_movements(
        object_id, product_id, event, quantity, reference, note, created_by
      )
      select
        v_object_id,
        oi.product_id,
        'DELIVERY',
        v_delivered,
        'delivery:' || v_delivery_id,
        coalesce(v_reason, nullif(btrim(p_note), ''), 'Delivery'),
        auth.uid()
      from public.order_items oi where oi.id = v_oi_id;
    end if;
  end loop;

  update public.orders set status = 'DELIVERED' where id = p_order_id;
  return v_delivery_id;
end;
$$;
