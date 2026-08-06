import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import {
  StockCount, StockCountItem, StockCountSummary, StockCountLineInput,
} from './stock-count.model';

/** One row the drawer counts against: a product + its expected (system) qty. */
export interface CountableRow {
  product_id: string;
  name: string;
  sku: string;
  expected_qty: number;
}

@Injectable({ providedIn: 'root' })
export class StockCountService {
  readonly countable = signal<CountableRow[]>([]);
  readonly summaries = signal<StockCountSummary[]>([]);
  readonly items = signal<StockCountItem[]>([]);
  readonly loading = signal<boolean>(false);
  readonly saving = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  /**
   * Snapshot what to count for an object: every product ASSIGNED to it,
   * joined with its current inventory balance as the "expected" quantity.
   * Products assigned but never stocked show expected 0 (still countable).
   */
  async loadCountable(objectId: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    // Assigned products for this object
    const { data: assigned, error: aErr } = await supabase
      .from('object_products')
      .select('product:products ( id, sku, name, active )')
      .eq('object_id', objectId);
    if (aErr) { this.error.set(this.friendly(aErr.message)); this.loading.set(false); return; }

    // Current balances (the "expected" side)
    const { data: inv, error: iErr } = await supabase
      .from('inventory')
      .select('product_id, quantity')
      .eq('object_id', objectId);
    if (iErr) { this.error.set(this.friendly(iErr.message)); this.loading.set(false); return; }

    const expected = new Map<string, number>();
    for (const row of inv ?? []) expected.set(row.product_id, row.quantity);

    const rows: CountableRow[] = (assigned ?? [])
      .map((r: any) => r.product)
      .filter((p: any) => p && p.active)
      .map((p: any) => ({
        product_id: p.id,
        name: p.name,
        sku: p.sku,
        expected_qty: expected.get(p.id) ?? 0,
      }))
      .sort((a: CountableRow, b: CountableRow) => a.name.localeCompare(b.name));

    this.countable.set(rows);
    this.loading.set(false);
  }

  /** Record the count via the atomic RPC. */
  async record(
    objectId: string,
    countedBy: string | null,
    note: string | null,
    lines: StockCountLineInput[]
  ): Promise<string | null> {
    this.saving.set(true);
    this.error.set(null);
    const { error } = await supabase.rpc('record_stock_count', {
      p_object_id: objectId,
      p_counted_by: countedBy,
      p_note: note,
      p_items: lines.map((l) => ({
        product_id: l.product_id,
        counted_qty: l.counted_qty,
        reason: l.reason,
      })),
    });
    this.saving.set(false);
    if (error) {
      const msg = this.friendly(error.message);
      this.error.set(msg);
      return msg;
    }
    return null;
  }

  /** Count history for an object (from the summary view). */
  async loadSummaries(objectId: string): Promise<void> {
    const { data } = await supabase
      .from('stock_count_summary')
      .select('*')
      .eq('object_id', objectId)
      .order('counted_at', { ascending: false });
    this.summaries.set((data ?? []) as StockCountSummary[]);
  }

  /** Line detail for one count (for the read-only summary drawer). */
  async loadItems(countId: string): Promise<void> {
    const { data } = await supabase
      .from('stock_count_items')
      .select('*, product:products ( name, sku )')
      .eq('count_id', countId);
    this.items.set((data ?? []) as unknown as StockCountItem[]);
  }

  private friendly(msg: string): string {
    if (msg.includes('A reason is required'))
      return 'Add a reason for every product whose counted quantity differs from the expected.';
    if (msg.includes('at least one product'))
      return 'Count at least one product before submitting.';
    if (msg.includes('violates row-level security'))
      return 'You don’t have permission to record a count for this object.';
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError'))
      return 'Network issue — check your connection and try again.';
    return 'Could not record the stock count. Please try again.';
  }
}
