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
  reorderCount: number;     // V7: products at/under the urgent runway threshold
}

// V7 — one row of the runway/reorder table.
export interface RunwayRow {
  productId: string;
  name: string;
  sku: string;
  onHand: number;
  unitsSold: number;        // SALE units in the window (abs)
  dailyRate: number;        // avg units sold per day over the window
  daysLeft: number | null;  // null = no recent sales (runway not computable)
  turnover: number | null;  // unitsSold / onHand (null when onHand is 0)
  urgency: 'out' | 'critical' | 'warning' | 'healthy' | 'idle';
}

const LOW_STOCK_THRESHOLD = 10;

// V7 — two-tier reorder thresholds (days of stock remaining).
const CRITICAL_DAYS = 7;    // red
const WARNING_DAYS = 14;    // amber

@Injectable({ providedIn: 'root' })
export class ReportsService {
  readonly stats = signal<ReportStats>({
    totalUnits: 0, movementsMonth: 0, ordersMonth: 0, lowStock: 0, reorderCount: 0,
  });
  readonly topProducts = signal<TopProduct[]>([]);
  readonly buckets = signal<Bucket[]>([]);
  readonly granularity = signal<'day' | 'week'>('day');
  readonly runway = signal<RunwayRow[]>([]);   // V7
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

    const [invRes, movRes, ordersRes, outRes, salesRes] = await Promise.all([
      // Inventory joined with product info — needed for on-hand AND runway names.
      scope(supabase.from('inventory')
        .select('product_id, quantity, product:products ( name, sku )')),
      // KPI: TOTAL movements in the window — every event counts, no filter.
      scope(supabase.from('stock_movements')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', sinceIso)),
      scope(supabase.from('orders').select('id, created_at').gte('created_at', sinceIso)),
      // Top-moving products: genuine OUTBOUND events (SALE / WRITE_OFF / TRANSFER).
      scope(supabase.from('stock_movements')
        .select('product_id, quantity, event, product:products ( name, sku )')
        .in('event', ['SALE', 'WRITE_OFF', 'TRANSFER'])
        .gte('created_at', sinceIso)),
      // V7: SALE-only movements in the window — the demand signal for runway.
      scope(supabase.from('stock_movements')
        .select('product_id, quantity, product:products ( name, sku )')
        .eq('event', 'SALE')
        .gte('created_at', sinceIso)),
    ]);

    if (invRes.error || movRes.error || ordersRes.error || outRes.error || salesRes.error) {
      this.error.set(
        invRes.error?.message || movRes.error?.message ||
        ordersRes.error?.message || outRes.error?.message ||
        salesRes.error?.message || 'Failed to load reports.'
      );
      this.loading.set(false);
      return;
    }

    // --- Inventory rows (on-hand per product) ---
    const invRows = (invRes.data ?? []) as any[];
    const totalUnits = invRows.reduce((s, r) => s + (r.quantity ?? 0), 0);
    const lowStock = invRows.filter((r) => r.quantity > 0 && r.quantity <= LOW_STOCK_THRESHOLD).length;

    // --- Top-moving products ---
    const topMap = new Map<string, TopProduct>();
    for (const row of (outRes.data ?? []) as any[]) {
      const id = row.product_id;
      const units = Math.abs(row.quantity ?? 0);
      const existing = topMap.get(id);
      if (existing) existing.unitsOut += units;
      else topMap.set(id, {
        productId: id,
        name: row.product?.name ?? 'Unknown',
        sku: row.product?.sku ?? '',
        unitsOut: units,
      });
    }
    this.topProducts.set(
      Array.from(topMap.values()).sort((a, b) => b.unitsOut - a.unitsOut).slice(0, 8)
    );

    // --- V7: Runway / days-of-stock ---
    // Aggregate SALE units per product over the window.
    const soldMap = new Map<string, number>();
    for (const row of (salesRes.data ?? []) as any[]) {
      const id = row.product_id;
      soldMap.set(id, (soldMap.get(id) ?? 0) + Math.abs(row.quantity ?? 0));
    }

    const runway: RunwayRow[] = invRows.map((r) => {
      const onHand = r.quantity ?? 0;
      const unitsSold = soldMap.get(r.product_id) ?? 0;
      const dailyRate = unitsSold / days;              // avg units/day over the window
      // Runway is only meaningful when there IS recent demand. No sales → null
      // (we render "No recent sales" rather than a fabricated number).
      const daysLeft = dailyRate > 0 ? onHand / dailyRate : null;
      const turnover = onHand > 0 ? unitsSold / onHand : null;

      let urgency: RunwayRow['urgency'];
      if (onHand <= 0) urgency = 'out';                     // already out — most urgent
      else if (daysLeft === null) urgency = 'idle';         // no demand signal
      else if (daysLeft <= CRITICAL_DAYS) urgency = 'critical';
      else if (daysLeft <= WARNING_DAYS) urgency = 'warning';
      else urgency = 'healthy';

      return {
        productId: r.product_id,
        name: r.product?.name ?? 'Unknown',
        sku: r.product?.sku ?? '',
        onHand, unitsSold, dailyRate, daysLeft, turnover, urgency,
      };
    });

    // Sort most-at-risk first: out → critical → warning → healthy → idle.
    // Within a computable runway, fewer days-left ranks higher.
    const rank: Record<RunwayRow['urgency'], number> = {
      out: 0, critical: 1, warning: 2, healthy: 3, idle: 4,
    };
    runway.sort((a, b) => {
      if (rank[a.urgency] !== rank[b.urgency]) return rank[a.urgency] - rank[b.urgency];
      const ad = a.daysLeft ?? Infinity;
      const bd = b.daysLeft ?? Infinity;
      return ad - bd;
    });
    this.runway.set(runway);

    // Reorder count = products that are out OR under the critical threshold.
    const reorderCount = runway.filter(
      (r) => r.urgency === 'out' || r.urgency === 'critical'
    ).length;

    // --- KPI stats ---
    this.stats.set({
      totalUnits,
      movementsMonth: movRes.count ?? 0,
      ordersMonth: (ordersRes.data ?? []).length,
      lowStock,
      reorderCount,
    });

    // --- Throughput: adaptive granularity ---
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
      const label = `${start.getDate()}/${start.getMonth() + 1}`;
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