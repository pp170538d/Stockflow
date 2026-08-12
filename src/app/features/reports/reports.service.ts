import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';

export interface TopProduct {
  productId: string;
  name: string;
  sku: string;
  unitsOut: number;
}

export interface Bucket {
  date: string;    // ISO day (start of the bucket)
  count: number;
  label: string;   // pre-computed x-axis label
}

export interface ReportStats {
  totalUnits: number;
  movementsMonth: number;   // movements within the selected range
  ordersMonth: number;      // orders within the selected range
  lowStock: number;
}

const LOW_STOCK_THRESHOLD = 10;

@Injectable({ providedIn: 'root' })
export class ReportsService {
  readonly stats = signal<ReportStats>({
    totalUnits: 0, movementsMonth: 0, ordersMonth: 0, lowStock: 0,
  });
  readonly topProducts = signal<TopProduct[]>([]);
  readonly buckets = signal<Bucket[]>([]);
  readonly granularity = signal<'day' | 'week'>('day');
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  /**
   * @param objectId  null = all objects, otherwise scope to one object.
   * @param days      size of the reporting window (7 / 30 / 90).
   */
  async load(objectId: string | null = null, days: number = 30): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const since = new Date();
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);
    const sinceIso = since.toISOString();

    const scope = (q: any) => (objectId ? q.eq('object_id', objectId) : q);

    const [invRes, movRes, ordersRes, outRes] = await Promise.all([
      scope(supabase.from('inventory').select('quantity')),
      // KPI: TOTAL movements in the window — every event counts, no filter.
      scope(supabase.from('stock_movements')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', sinceIso)),
      scope(supabase.from('orders').select('id, created_at').gte('created_at', sinceIso)),
      // Top-moving products: genuine OUTBOUND events only (semantic ledger, V4+).
      // SALE / WRITE_OFF / TRANSFER = real goods leaving this object.
      // STOCK_COUNT and ADJUSTMENT are deliberately excluded — they are
      // corrections/reconciliation, not movement, and would poison the metric.
      scope(supabase.from('stock_movements')
        .select('product_id, quantity, event, product:products ( name, sku )')
        .in('event', ['SALE', 'WRITE_OFF', 'TRANSFER'])
        .gte('created_at', sinceIso)),
    ]);

    if (invRes.error || movRes.error || ordersRes.error || outRes.error) {
      this.error.set(
        invRes.error?.message || movRes.error?.message ||
        ordersRes.error?.message || outRes.error?.message || 'Failed to load reports.'
      );
      this.loading.set(false);
      return;
    }

    // --- KPI stats ---
    const invRows = (invRes.data ?? []) as { quantity: number }[];
    const totalUnits = invRows.reduce((s, r) => s + (r.quantity ?? 0), 0);
    const lowStock = invRows.filter((r) => r.quantity > 0 && r.quantity <= LOW_STOCK_THRESHOLD).length;

    this.stats.set({
      totalUnits,
      movementsMonth: movRes.count ?? 0,
      ordersMonth: (ordersRes.data ?? []).length,
      lowStock,
    });

    // --- Top-moving products ---
    // outRes now returns only outbound events; quantities are negative, so we
    // take the absolute value to accumulate "units shipped out" per product.
    const map = new Map<string, TopProduct>();
    for (const row of (outRes.data ?? []) as any[]) {
      const id = row.product_id;
      const units = Math.abs(row.quantity ?? 0);
      const existing = map.get(id);
      if (existing) existing.unitsOut += units;
      else map.set(id, {
        productId: id,
        name: row.product?.name ?? 'Unknown',
        sku: row.product?.sku ?? '',
        unitsOut: units,
      });
    }
    this.topProducts.set(
      Array.from(map.values()).sort((a, b) => b.unitsOut - a.unitsOut).slice(0, 8)
    );

    // --- Throughput: adaptive granularity ---
    // Long ranges (>=90d) aggregate by WEEK so bars stay fat & readable.
    const useWeek = days >= 90;
    this.granularity.set(useWeek ? 'week' : 'day');
    const orders = (ordersRes.data ?? []) as { created_at: string }[];

    this.buckets.set(
      useWeek ? this.weeklyBuckets(since, days, orders)
              : this.dailyBuckets(since, days, orders)
    );

    this.loading.set(false);
  }

  // ---- one bar per day ----
  private dailyBuckets(since: Date, days: number, orders: { created_at: string }[]): Bucket[] {
    const out: Bucket[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(since.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      out.push({ date: iso, count: 0, label: d.getDate().toString() });
    }
    const byDay = new Map(out.map((b) => [b.date, b]));
    for (const o of orders) {
      const b = byDay.get(o.created_at.slice(0, 10));
      if (b) b.count++;
    }
    return out;
  }

  // ---- one bar per week (~13 for 90 days) ----
  private weeklyBuckets(since: Date, days: number, orders: { created_at: string }[]): Bucket[] {
    const weeks = Math.ceil(days / 7);
    const out: Bucket[] = [];
    for (let w = 0; w < weeks; w++) {
      const start = new Date(since);
      start.setDate(since.getDate() + w * 7);
      const label = `${start.getDate()}/${start.getMonth() + 1}`; // e.g. 12/6
      out.push({ date: start.toISOString().slice(0, 10), count: 0, label });
    }
    for (const o of orders) {
      const od = new Date(o.created_at);
      const diffDays = Math.floor((od.getTime() - since.getTime()) / 86_400_000);
      const wIdx = Math.floor(diffDays / 7);
      if (wIdx >= 0 && wIdx < out.length) out[wIdx].count++;
    }
    return out;
  }
}