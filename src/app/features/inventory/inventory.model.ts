

// =====================================================================
// Inventory domain types — semantic ledger edition
// =====================================================================
import { Urgency, WINDOW_DAYS } from '../../core/stock/runway';

export type { Urgency } from '../../core/stock/runway';
export { CRITICAL_DAYS, WARNING_DAYS } from '../../core/stock/runway';

export type MovementEvent =
  | 'DELIVERY'
  | 'SALE'
  | 'STOCK_COUNT'
  | 'ADJUSTMENT'
  | 'TRANSFER'
  | 'RETURN'
  | 'WRITE_OFF'
  | 'SUPPLIER_RETURN';


/** Events a human can record from the manual stock drawer. */
export const MANUAL_EVENTS: MovementEvent[] = ['SALE', 'ADJUSTMENT', 'RETURN', 'WRITE_OFF'];

/** Window used for trend, sales rate and runway (shared with Reports / Orders / Sales). */
export const INSIGHT_DAYS = WINDOW_DAYS;

/** Current stock balance for one object+product (trigger-maintained cache). */
export interface InventoryRow {
  id: string;
  object_id: string;
  product_id: string;
  quantity: number;
  updated_at: string;
  product?: { name: string; sku: string; barcode: string | null; category: string | null };
}

/** Inventory row enriched with 30-day behaviour. */
export interface InventoryItem extends InventoryRow {
  /** Daily closing balance, oldest ? today (length = INSIGHT_DAYS). */
  series: number[];
  sparkLine: string;
  sparkArea: string;
  in30: number;
  out30: number;
  sold30: number;
  dailyRate: number;
  daysLeft: number | null;     // null = no sales in the window
  urgency: Urgency;
  /** Too few sales to trust the forecast. */
  lowData: boolean;
  incomingQty: number; projectedDays: number | null; rawGapQty: number;
  orderablePacks: number; orderableQty: number;
  coverageState: 'urgent'|'needs_order'|'top_up'|'covered'|'no_pace';
  workflowState: 'none'|'requested'|'on_the_way';
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
  created_at: string;            // kad je upisano u bazu
  occurred_at: string;           // kad se desilo (koristi ovo za prikaz)
  unit_price: number | null;
  unit_cost: number | null;
  currency: string | null;
  product?: { name: string; sku: string };
}
