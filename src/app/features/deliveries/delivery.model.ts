// =====================================================================
// Deliveries — domain types
// One (final) delivery per order = one goods receipt (GRN).
// variance = delivered − ordered; a line with a variance needs a reason
// at receipt, and an admin decision afterwards (resolution).
// =====================================================================

export interface Delivery {
  id: string;
  delivery_number: string | null;
  order_id: string;
  object_id: string;
  carrier: string | null;
  received_by: string | null;
  recorded_by: string | null;
  note: string | null;
  delivered_at: string;
  created_at: string;
}

export interface DeliveryItem {
  id: string;
  delivery_id: string;
  order_item_id: string;
  product_id: string;
  delivered_qty: number;
  reason: string | null;
  reason_code: string | null;
  created_at: string;
}

/** A row from the `order_fulfillment` view (used by Confirm delivery). */
export interface OrderFulfillment {
  order_item_id: string;
  order_id: string;
  product_id: string;
  ordered_qty: number;
  delivered_qty: number | null;
  variance: number | null;
  reason: string | null;
  delivery_id: string | null;
  delivered_at: string | null;
  product?: { name: string; sku: string };
}

export interface DeliveryLineInput {
  order_item_id: string;
  delivered_qty: number;
  reason_code: string | null;
  reason: string | null;
}

export type ResolutionStatus = 'open' | 'resolved';
export type Resolution = 'BACKORDER' | 'CLOSE_SHORT' | 'CLAIM' | 'ACCEPT' | 'RETURN_TO_SUPPLIER';

/** Party block frozen on the order at approval. */
export interface ReceiptParty {
  name?: string | null;
  address?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: string | null;
  tax_id?: string | null;
  registration_number?: string | null;
  email?: string | null;
  order_email?: string | null;
  phone?: string | null;
}

/** One line of a goods receipt (every order line, exact or not). */
export interface ReceiptLine {
  line_id: string | null;
  order_item_id: string;
  product_id: string;
  sku: string;
  product_name: string;
  ordered_qty: number;
  received_qty: number;
  variance: number;
  unit_cost: number | null;
  ordered_value: number | null;
  received_value: number | null;
  variance_value: number | null;
  reason_code: string | null;
  reason: string | null;
  resolution_status: ResolutionStatus | null;
  resolution: Resolution | null;
  resolution_note: string | null;
  resolved_at: string | null;
  backorder_number: string | null;
}

/** The `goods_receipt` RPC: the full document, used by the drawer and the PDF. */
export interface GoodsReceipt {
  currency: string;
  object_name: string;
  delivery: {
    id: string;
    delivery_number: string | null;
    delivered_at: string;
    received_by: string | null;
    carrier: string | null;
    note: string | null;
  };
  order: {
    id: string;
    order_number: string;
    status: string;
    comment: string | null;
    approved_at: string | null;
    company: ReceiptParty | null;
    supplier: ReceiptParty | null;
    deliver_to: ReceiptParty | null;
  };
  lines: ReceiptLine[];
}

/** A row from the `delivery_exceptions` RPC (Orders list counters). */
export interface DeliveryException {
  line_id: string;
  delivery_id: string;
  delivery_number: string | null;
  order_id: string;
  order_number: string | null;
  variance: number;
  resolution_status: ResolutionStatus | null;
}
