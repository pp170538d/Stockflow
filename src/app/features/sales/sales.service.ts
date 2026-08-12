import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';

// A single SALE ledger entry, flattened for the list view.
export interface SaleRow {
  id: string;
  productId: string;
  name: string;
  sku: string;
  objectId: string;
  objectName: string;
  units: number;        // positive magnitude (abs of the signed ledger qty)
  note: string | null;
  createdAt: string;    // ISO timestamp
}

// KPI summary for the header strip.
export interface SalesSummary {
  totalUnits: number;   // total units sold in the window
  saleCount: number;    // number of SALE events in the window
  productCount: number; // distinct products sold (never sums across SKUs)
}

@Injectable({ providedIn: 'root' })
export class SalesService {
  readonly rows = signal<SaleRow[]>([]);
  readonly summary = signal<SalesSummary>({ totalUnits: 0, saleCount: 0, productCount: 0 });
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  /**
   * Read-only feed of SALE events. No write path — sales are still recorded
   * via the inventory movement drawer; this is a filtered view of the ledger.
   *
   * @param objectId  null = all objects, otherwise scope to one object.
   * @param days      lookback window (7 / 30 / 90). null = all time.
   */
  async load(objectId: string | null = null, days: number | null = 30): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    let query = supabase
      .from('stock_movements')
      .select('id, object_id, product_id, quantity, note, created_at, ' +
              'product:products ( name, sku ), object:objects ( name )')
      .eq('event', 'SALE')
      .order('created_at', { ascending: false });

    if (objectId) query = query.eq('object_id', objectId);
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - (days - 1));
      since.setHours(0, 0, 0, 0);
      query = query.gte('created_at', since.toISOString());
    }

    const { data, error } = await query;

    if (error) {
      this.error.set(error.message || 'Failed to load sales.');
      this.loading.set(false);
      return;
    }

    const rows: SaleRow[] = (data ?? []).map((r: any) => ({
      id: r.id,
      productId: r.product_id,
      name: r.product?.name ?? 'Unknown',
      sku: r.product?.sku ?? '',
      objectId: r.object_id,
      objectName: r.object?.name ?? '—',
      units: Math.abs(r.quantity ?? 0),   // SALE is stored negative; show magnitude
      note: r.note ?? null,
      createdAt: r.created_at,
    }));
    this.rows.set(rows);

    // Summary — honest reporting: count products, don't sum across SKUs
    // except for the genuinely-additive "total units sold".
    const totalUnits = rows.reduce((s, r) => s + r.units, 0);
    const productIds = new Set(rows.map((r) => r.productId));
    this.summary.set({
      totalUnits,
      saleCount: rows.length,
      productCount: productIds.size,
    });

    this.loading.set(false);
  }
}
