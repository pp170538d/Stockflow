// =====================================================================
// Inventory domain types — semantic ledger edition
// =====================================================================

export type MovementEvent =
  | 'DELIVERY'
  | 'SALE'
  | 'STOCK_COUNT'
  | 'ADJUSTMENT'
  | 'TRANSFER'
  | 'RETURN'
  | 'WRITE_OFF';

/** Events a human can record from the manual stock drawer. */
export const MANUAL_EVENTS: MovementEvent[] = ['SALE', 'ADJUSTMENT', 'RETURN', 'WRITE_OFF'];

/** Window used for trend, sales rate and runway. */
export const INSIGHT_DAYS = 30;
/** Same thresholds as Dashboard and Reports — one truth everywhere. */
export const CRITICAL_DAYS = 7;
export const WARNING_DAYS = 14;

export type Urgency = 'out' | 'critical' | 'warning' | 'healthy' | 'idle';

/** Current stock balance for one object+product (trigger-maintained cache). */
export interface InventoryRow {
  id: string;
  object_id: string;
  product_id: string;
  quantity: number;
  updated_at: string;
  product?: { name: string; sku: string; category: string | null };
}

/** Inventory row enriched with 30-day behaviour. */
export interface InventoryItem extends InventoryRow {
  /** Daily closing balance, oldest → today (length = INSIGHT_DAYS). */
  series: number[];
  sparkLine: string;
  sparkArea: string;
  in30: number;
  out30: number;
  sold30: number;
  dailyRate: number;
  daysLeft: number | null;     // null = no sales in the window
  urgency: Urgency;
  last: { event: MovementEvent; quantity: number; created_at: string } | null;
}

/** One immutable ledger event. */
export interface StockMovement {
  id: string;
  object_id: string;
  product_id: string;
  event: MovementEvent;
  quantity: number;              // SIGNED (+ in / - out)
  reference: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  product?: { name: string; sku: string };
}
