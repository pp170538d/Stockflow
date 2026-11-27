-- ============================================================
-- STOCKFLOW GLOBAL INVARIANT AUDIT
--
-- READ ONLY.
-- This file does not INSERT, UPDATE or DELETE business data.
--
-- EXPECTED RESULT:
-- Every section should return ZERO rows.
-- ============================================================


-- ============================================================
-- A. RECEIVING PHYSICAL SPLIT
--
-- Everything physically received must end up as:
--
--   accepted to usable stock
--   + HELD
--   + immediate return
--
-- physical = accepted + held + immediate_return
-- ============================================================

select
  'RECEIVING_SPLIT_MISMATCH' as test,

  di.id as record_id,

  jsonb_build_object(
    'physical',
      di.physical_qty,

    'accepted',
      di.accepted_qty,

    'held',
      di.held_qty,

    'immediate_return',
      di.immediate_return_qty,

    'calculated_total',
      di.accepted_qty
      + di.held_qty
      + di.immediate_return_qty
  ) as detail

from public.delivery_items di

where di.physical_qty
      <>
      di.accepted_qty
      + di.held_qty
      + di.immediate_return_qty;


-- ============================================================
-- B. SHORT / OVER BUCKET VALUES
--
-- Stored variance buckets must correspond to:
--
-- short = max(ordered - physical, 0)
-- over  = max(physical - ordered, 0)
-- ============================================================

select
  'BUCKET_VALUE_MISMATCH' as test,

  di.id as record_id,

  jsonb_build_object(
    'ordered',
      oi.quantity,

    'physical',
      di.physical_qty,

    'short_stored',
      di.short_qty,

    'short_expected',
      greatest(
        oi.quantity
        - di.physical_qty,
        0
      ),

    'over_stored',
      di.over_qty,

    'over_expected',
      greatest(
        di.physical_qty
        - oi.quantity,
        0
      )
  ) as detail

from public.delivery_items di

join public.order_items oi
  on oi.id = di.order_item_id

where
  di.short_qty
    <>
  greatest(
    oi.quantity
    - di.physical_qty,
    0
  )

  or

  di.over_qty
    <>
  greatest(
    di.physical_qty
    - oi.quantity,
    0
  );


-- ============================================================
-- C. HELD LEDGER BALANCE
--
-- remaining HELD must always equal:
--
-- original HELD
-- minus every recorded disposition
-- ============================================================

select
  'HELD_LEDGER_MISMATCH' as test,

  h.id as record_id,

  jsonb_build_object(
    'original',
      h.quantity,

    'remaining',
      h.remaining_qty,

    'disposed_total',
      coalesce(
        sum(d.quantity),
        0
      ),

    'expected_remaining',
      h.quantity
      - coalesce(
          sum(d.quantity),
          0
        )
  ) as detail

from public.held_stock h

left join public.held_stock_dispositions d
  on d.held_stock_id = h.id

group by
  h.id,
  h.quantity,
  h.remaining_qty

having
  h.remaining_qty
  <>
  h.quantity
  - coalesce(
      sum(d.quantity),
      0
    );


-- ============================================================
-- D. HELD STATUS CONSISTENCY
--
-- CLOSED:
--   remaining must be 0
--
-- HELD / PARTIALLY_DISPOSED:
--   remaining must be > 0
-- ============================================================

select
  'HELD_STATUS_MISMATCH' as test,

  h.id as record_id,

  jsonb_build_object(
    'status',
      h.status,

    'original',
      h.quantity,

    'remaining',
      h.remaining_qty
  ) as detail

from public.held_stock h

where
  (
    h.status = 'CLOSED'
    and h.remaining_qty <> 0
  )

  or

  (
    h.status in (
      'HELD',
      'PARTIALLY_DISPOSED'
    )

    and h.remaining_qty <= 0
  );


-- ============================================================
-- E. HELD ACCEPT AUDIT
--
-- delivery_items.held_accepted_qty must equal the total
-- quantity of ACCEPT dispositions for its HELD record.
-- ============================================================

select
  'HELD_ACCEPT_AUDIT_MISMATCH' as test,

  di.id as record_id,

  jsonb_build_object(
    'stored_held_accepted_qty',
      di.held_accepted_qty,

    'accept_disposition_total',
      coalesce(
        sum(d.quantity)
          filter (
            where
              d.disposition_type = 'ACCEPT'
          ),
        0
      )
  ) as detail

from public.delivery_items di

left join public.held_stock h
  on h.delivery_item_id = di.id

left join public.held_stock_dispositions d
  on d.held_stock_id = h.id

group by
  di.id,
  di.held_accepted_qty

having
  di.held_accepted_qty
  <>
  coalesce(
    sum(d.quantity)
      filter (
        where
          d.disposition_type = 'ACCEPT'
      ),
    0
  );


-- ============================================================
-- F. ACCEPT STOCK MOVEMENT
--
-- Every ACCEPT disposition must create EXACTLY ONE stock
-- movement and movement quantity must equal disposition qty.
-- ============================================================

select
  'ACCEPT_MOVEMENT_MISMATCH' as test,

  d.id as record_id,

  jsonb_build_object(
    'disposition_qty',
      d.quantity,

    'movement_count',
      count(sm.id),

    'movement_qty',
      coalesce(
        sum(sm.quantity),
        0
      ),

    'movement_ids',
      coalesce(
        jsonb_agg(sm.id)
          filter (
            where sm.id is not null
          ),
        '[]'::jsonb
      )
  ) as detail

from public.held_stock_dispositions d

left join public.stock_movements sm
  on sm.reference =
     'held-accept:' || d.id

where d.disposition_type = 'ACCEPT'

group by
  d.id,
  d.quantity

having
  count(sm.id) <> 1

  or

  coalesce(
    sum(sm.quantity),
    0
  ) <> d.quantity;


-- ============================================================
-- G. RETURN_LATER EXTERNAL DOCUMENT
--
-- Every RETURN_LATER disposition must have exactly one:
--
-- HELD_DISPOSITION
-- DISPATCH
-- OUTBOUND
-- SUPPLIER_RETURN
-- ============================================================

select
  'RETURN_DOCUMENT_MISMATCH' as test,

  d.id as record_id,

  jsonb_build_object(
    'disposition_qty',
      d.quantity,

    'dispatch_number',
      d.dispatch_document_number,

    'document_count',
      count(x.id),

    'external_document_ids',
      coalesce(
        jsonb_agg(x.id)
          filter (
            where x.id is not null
          ),
        '[]'::jsonb
      )
  ) as detail

from public.held_stock_dispositions d

left join public.external_documents x
  on x.entity_type =
     'HELD_DISPOSITION'

 and x.entity_id =
     d.id

 and x.document_type =
     'DISPATCH'

 and x.direction =
     'OUTBOUND'

 and x.movement_purpose =
     'SUPPLIER_RETURN'

where d.disposition_type =
      'RETURN_LATER'

group by
  d.id,
  d.quantity,
  d.dispatch_document_number

having count(x.id) <> 1;


-- ============================================================
-- H. SHORTAGE RESOLUTION CONSISTENCY
-- ============================================================

select
  'SHORT_RESOLUTION_MISMATCH' as test,

  di.id as record_id,

  jsonb_build_object(
    'short_qty',
      di.short_qty,

    'short_resolution',
      di.short_resolution,

    'backorder_id',
      di.backorder_id,

    'resolution_status',
      di.resolution_status,

    'resolution',
      di.resolution
  ) as detail

from public.delivery_items di

where

  -- BACKORDER requires actual child order.
  (
    di.short_resolution =
      'BACKORDER'

    and di.backorder_id
        is null
  )

  or

  -- No shortage means there should be no shortage resolution.
  (
    di.short_qty = 0

    and di.short_resolution
        is not null
  )

  or

  -- An unresolved shortage must not leave the whole line
  -- terminally resolved.
  (
    di.short_qty > 0

    and di.short_resolution
        is null

    and di.resolution_status =
        'resolved'
  );


-- ============================================================
-- I. DUPLICATE HELD-ACCEPT MOVEMENTS
--
-- Idempotency / inventory protection.
--
-- Every held-accept reference must be globally unique in the
-- movement ledger.
-- ============================================================

select
  'DUPLICATE_HELD_ACCEPT_REFERENCE' as test,

  (
    array_agg(
      sm.id
      order by sm.created_at
    )
  )[1] as record_id,

  jsonb_build_object(
    'reference',
      sm.reference,

    'count',
      count(*),

    'movement_ids',
      jsonb_agg(
        sm.id
        order by sm.created_at
      )
  ) as detail

from public.stock_movements sm

where sm.reference like
      'held-accept:%'

group by
  sm.reference

having count(*) > 1;


-- ============================================================
-- J. HELD DISPOSITION OVERDRAW
--
-- Total dispositions may never exceed original HELD quantity.
--
-- C already catches remaining mismatch, but this explicit test
-- makes the failure easier to understand.
-- ============================================================

select
  'HELD_DISPOSITION_OVERDRAW' as test,

  h.id as record_id,

  jsonb_build_object(
    'original',
      h.quantity,

    'disposed_total',
      coalesce(
        sum(d.quantity),
        0
      )
  ) as detail

from public.held_stock h

left join public.held_stock_dispositions d
  on d.held_stock_id = h.id

group by
  h.id,
  h.quantity

having
  coalesce(
    sum(d.quantity),
    0
  ) > h.quantity;


-- ============================================================
-- K. IMMEDIATE RETURN MUST NOT CREATE HELD CUSTODY
--
-- With the new receiving flow, immediate returns leave with
-- the delivery vehicle and therefore must not also exist in
-- current HELD custody.
--
-- Historical rows created before the new flow could exist,
-- so this query deliberately checks only delivery lines where
-- held_qty = 0.
-- ============================================================

select
  'IMMEDIATE_RETURN_CUSTODY_MISMATCH'
    as test,

  di.id as record_id,

  jsonb_build_object(
    'immediate_return_qty',
      di.immediate_return_qty,

    'held_qty',
      di.held_qty,

    'held_stock_id',
      h.id
  ) as detail

from public.delivery_items di

join public.held_stock h
  on h.delivery_item_id =
     di.id

where
  di.immediate_return_qty > 0

  and di.held_qty = 0;


-- ============================================================
-- L. EXACT RECEIPT MUST NOT HAVE EXCEPTION BUCKETS
-- ============================================================

select
  'EXACT_RECEIPT_EXCEPTION_MISMATCH'
    as test,

  di.id as record_id,

  jsonb_build_object(
    'ordered',
      oi.quantity,

    'physical',
      di.physical_qty,

    'accepted',
      di.accepted_qty,

    'short',
      di.short_qty,

    'over',
      di.over_qty,

    'quality_rejected',
      di.quality_rejected_qty,

    'held',
      di.held_qty,

    'immediate_return',
      di.immediate_return_qty
  ) as detail

from public.delivery_items di

join public.order_items oi
  on oi.id = di.order_item_id

where
  oi.quantity =
    di.physical_qty

  and di.physical_qty =
      di.accepted_qty

  and (
    di.short_qty <> 0
    or di.over_qty <> 0
    or di.quality_rejected_qty <> 0
    or di.held_qty <> 0
    or di.immediate_return_qty <> 0
  );


-- ============================================================
-- EXPECTED RESULT
--
-- A through L:
-- ZERO rows.
--
-- Any returned row represents a real invariant that should be
-- inspected before modifying production data.
-- ============================================================