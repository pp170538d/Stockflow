-- READ-ONLY regression assertions against the scenarios created during this review.
-- Raises an exception on the first failure. Safe to run repeatedly.
do $test$
declare v int;
begin
  -- ORD-63: over 2, HELD split into ACCEPT 1 + RETURN_LATER 1.
  select count(*) into v
  from public.orders o join public.deliveries d on d.order_id=o.id
  join public.delivery_items di on di.delivery_id=d.id
  join public.held_stock h on h.delivery_item_id=di.id
  where o.order_number='ORD-2026-000063'
    and di.over_qty=2 and di.held_qty=2 and di.held_accepted_qty=1
    and h.remaining_qty=0 and h.status='CLOSED';
  if v<>1 then raise exception 'REGRESSION ORD-63 HELD lifecycle failed'; end if;

  select count(*) into v from public.external_documents x
  join public.held_stock_dispositions hd on hd.id=x.entity_id
  join public.held_stock h on h.id=hd.held_stock_id
  join public.deliveries d on d.id=h.delivery_id
  join public.orders o on o.id=d.order_id
  where o.order_number='ORD-2026-000063' and hd.disposition_type='RETURN_LATER'
    and x.entity_type='HELD_DISPOSITION' and x.document_type='DISPATCH'
    and x.direction='OUTBOUND' and x.movement_purpose='SUPPLIER_RETURN';
  if v<>1 then raise exception 'REGRESSION ORD-63 outbound return document failed'; end if;

  -- ORD-64 claim must be fulfilled by replacement tree ORD-65 + ORD-66, and original custody closed.
  select count(*) into v from public.supplier_claims sc
  join public.orders o on o.id=sc.order_id
  where o.order_number='ORD-2026-000064' and sc.status='REPLACEMENT_RECEIVED'
    and coalesce(sc.replacement_received_qty,0)>=sc.claimed_qty;
  if v<>1 then raise exception 'REGRESSION ORD-64 claim fulfillment failed'; end if;

  select count(*) into v from public.orders o
  join public.deliveries d on d.order_id=o.id
  join public.delivery_items di on di.delivery_id=d.id
  join public.held_stock h on h.delivery_item_id=di.id
  where o.order_number='ORD-2026-000064' and h.remaining_qty=0 and h.status='CLOSED'
    and exists(select 1 from public.held_stock_dispositions hd where hd.held_stock_id=h.id and hd.disposition_type='DISPOSED' and hd.quantity=2);
  if v<>1 then raise exception 'REGRESSION ORD-64 damaged custody disposal failed'; end if;

  -- Replacement fulfilled across root and child backorder.
  select count(*) into v from public.orders o
  where o.order_number='ORD-2026-000066'
    and o.parent_order_id=(select id from public.orders where order_number='ORD-2026-000065');
  if v<>1 then raise exception 'REGRESSION ORD-66 replacement backorder linkage failed'; end if;

  raise notice 'All known E2E regression assertions passed.';
end
$test$;
