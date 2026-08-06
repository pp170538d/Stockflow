// =====================================================================
// Stock Count domain types
// A count snapshots EXPECTED stock, the user enters COUNTED, and each
// difference becomes a signed STOCK_COUNT ledger event.
// =====================================================================

/** A physical-count session for an object. */
export interface StockCount {
  id: string;
  object_id: string;
  note: string | null;
  counted_by: string | null;    // who walked the shelves (a name)
  recorded_by: string | null;   // the app user who submitted (auth.uid())
  counted_at: string;
  created_at: string;
}

/** One counted product within a session. */
export interface StockCountItem {
  id: string;
  count_id: string;
  product_id: string;
  expected_qty: number;
  counted_qty: number;
  variance: number;             // counted − expected
  reason: string | null;
  created_at: string;
  product?: { name: string; sku: string };  // joined for display
}

/** A row from the `stock_count_summary` view (for history/reports). */
export interface StockCountSummary {
  count_id: string;
  object_id: string;
  counted_by: string | null;
  recorded_by: string | null;
  counted_at: string;
  lines: number;                // products counted
  discrepancies: number;        // products that differed
  products_short: number;       // products counted LOWER than expected (mix-safe)
  products_over: number;        // products counted HIGHER than expected (mix-safe)
  units_short: number;          // (per-product context only — never summed in UI)
  units_over: number;
  object?: { name: string };    // joined for display
}

/** One line sent to the `record_stock_count` RPC. */
export interface StockCountLineInput {
  product_id: string;
  counted_qty: number;
  reason: string | null;
}
