// =====================================================================
// V3 Deliveries — domain types
// Mirrors the DB: one (final) delivery per order, over-delivery accepted,
// variance = delivered − ordered, reason required when they differ.
// =====================================================================

/** A single, final delivery event recorded against an order. */
export interface Delivery {
  id: string;
  order_id: string;
  object_id: string;
  carrier: string | null;        // who physically delivered (e.g. 'NELT')
  received_by: string | null;    // name of the person who counted the drop
  recorded_by: string | null;    // app user who confirmed it (auth.uid())
  note: string | null;
  delivered_at: string;          // when the goods actually arrived
  created_at: string;            // when the row was written
}

/** One counted line within a delivery. */
export interface DeliveryItem {
  id: string;
  delivery_id: string;
  order_item_id: string;
  product_id: string;
  delivered_qty: number;         // may be 0 (line didn't arrive)
  reason: string | null;         // required by the DB when delivered ≠ ordered
  created_at: string;
}

/**
 * A row from the `order_fulfillment` view — the reconciliation picture
 * for one order line: what we asked for vs what actually arrived.
 */
export interface OrderFulfillment {
  order_item_id: string;
  order_id: string;
  product_id: string;
  ordered_qty: number;
  delivered_qty: number | null;  // null until a delivery exists
  variance: number | null;       // + over · − short · 0 exact
  reason: string | null;
  delivery_id: string | null;
  delivered_at: string | null;
  // joined for display (populated client-side from order_items)
  product?: { name: string; sku: string };
}

/** Payload for one line sent to the `record_delivery` RPC. */
export interface DeliveryLineInput {
  order_item_id: string;
  delivered_qty: number;
  reason: string | null;
}
