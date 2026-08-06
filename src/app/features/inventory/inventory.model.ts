// =====================================================================
// Inventory domain types — semantic ledger edition
// =====================================================================

/**
 * Semantic stock-movement events. The TYPE carries meaning; the signed
 * `quantity` carries direction (+ in / − out).
 *
 *   DELIVERY    (+)  goods received from a supplier/carrier  (from orders)
 *   SALE        (−)  sold / consumed to final customer       (blocks oversell)
 *   STOCK_COUNT (±)  correction from a physical count        (exempt)
 *   ADJUSTMENT  (±)  manual correction with a reason         (exempt)
 *   TRANSFER    (±)  moved between locations                 (out-leg blocks oversell)
 *   RETURN      (+)  customer return back into stock
 *   WRITE_OFF   (−)  damage / loss / expiry                  (blocks oversell)
 */
export type MovementEvent =
  | 'DELIVERY'
  | 'SALE'
  | 'STOCK_COUNT'
  | 'ADJUSTMENT'
  | 'TRANSFER'
  | 'RETURN'
  | 'WRITE_OFF';

/** Events a human can record from the manual stock drawer. */
export const MANUAL_EVENTS: MovementEvent[] = ['ADJUSTMENT', 'RETURN', 'WRITE_OFF'];

/** Current stock balance for one object+product (trigger-maintained cache). */
export interface InventoryRow {
  id: string;
  object_id: string;
  product_id: string;
  quantity: number;
  updated_at: string;
  product?: { name: string; sku: string; category: string | null };
}

/** One immutable ledger event. */
export interface StockMovement {
  id: string;
  object_id: string;
  product_id: string;
  event: MovementEvent;          // ← was `movement_type`
  quantity: number;              // SIGNED (+ in / − out)
  reference: string | null;      // e.g. 'delivery:<id>', 'manual', 'count:<id>'
  note: string | null;
  created_by: string | null;
  created_at: string;
  product?: { name: string; sku: string };
}
