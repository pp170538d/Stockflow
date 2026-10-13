import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { Urgency, runway as forecast } from '../../core/stock/runway';

export type { Urgency } from '../../core/stock/runway';
export { TARGET_DAYS } from '../../core/stock/runway';


export type MovementEvent =
  | 'DELIVERY'
  | 'SALE'
  | 'STOCK_COUNT'
  | 'ADJUSTMENT'
  | 'TRANSFER'
  | 'RETURN'
  | 'WRITE_OFF';

/** One column of the stock-flow chart (a day, or a week for 90d). */
export interface FlowBucket {
  start: string;
  label: string;
  inU: number;      // units in  (positive movements)
  outU: number;     // units out (negative movements, as a positive number)
  net: number;
  sold: number;
  events: number;
  balance: number;  // closing stock at the end of this bucket
}

export interface MixSlice {
  event: MovementEvent;
  count: number;
  units: number;
  pct: number;      // share of events, 0–100
  offset: number;   // cumulative pct before this slice (for the donut)
}

export interface TopProduct {
  productId: string;
  name: string;
  sku: string;
  unitsOut: number;
  unitsIn: number;
  share: number;    // share of all units out, 0–100
}

export interface RunwayRow {
  productId: string;
  /** Store to reorder for — the selected one, or the only store holding it. */
  objectId: string | null;
  name: string;
  sku: string;
  onHand: number;
  unitsSold: number;
  dailyRate: number;
  daysLeft: number | null;
  urgency: Urgency;
  /** Too few sales to trust the forecast. */
  lowData: boolean;
  /** Units already on PENDING / APPROVED orders. */
  incoming: number;
  /** Units to order so the shelf covers TARGET_DAYS, after incoming (0 = nothing to do). */
  suggestQty: number;
}

export interface ReportKpis {
  onHand: number;
  onHandStart: number;
  unitsIn: number;
  unitsOut: number;
  sold: number;
  soldPrev: number;
  movements: number;
  movementsPrev: number;
  orders: number;
  ordersPrev: number;
  reorder: number;
  soon: number;
}

const DAY = 86_400_000;

const EMPTY_KPIS: ReportKpis = {
  onHand: 0, onHandStart: 0, unitsIn: 0, unitsOut: 0,
  sold: 0, soldPrev: 0, movements: 0, movementsPrev: 0,
  orders: 0, ordersPrev: 0, reorder: 0, soon: 0,
};

const MIX_ORDER: MovementEvent[] = [
  'SALE', 'DELIVERY', 'STOCK_COUNT', 'ADJUSTMENT', 'RETURN', 'WRITE_OFF', 'TRANSFER',
];

const RANK: Record<Urgency, number> = { out: 0, critical: 1, warning: 2, healthy: 3, idle: 4 };

@Injectable({ providedIn: 'root' })
export class ReportsService {
  readonly kpis = signal<ReportKpis>(EMPTY_KPIS);
  readonly buckets = signal<FlowBucket[]>([]);
  readonly granularity = signal<'day' | 'week'>('day');
  readonly mix = signal<MixSlice[]>([]);
  readonly topProducts = signal<TopProduct[]>([]);
  readonly runway = signal<RunwayRow[]>([]);

  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Loads the selected window AND the window before it (for "vs previous" deltas)
   * in three parallel queries. Everything else is computed client-side.
   */
  async load(objectId: string | null = null, days = 30): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - days);

    const scope = (q: any) => (objectId ? q.eq('object_id', objectId) : q);

    const [invRes, movRes, ordRes, openRes] = await Promise.all([
      scope(
        supabase.from('inventory').select('object_id, product_id, quantity, product:products ( name, sku )')
      ),
      scope(
        supabase
          .from('stock_movements')
          .select('product_id, event, quantity, created_at, product:products ( name, sku )')
          .gte('created_at', prevStart.toISOString())
          .order('created_at', { ascending: false })
          .limit(10000)
      ),
      scope(supabase.from('orders').select('id, created_at').gte('created_at', prevStart.toISOString())),
      scope(
        supabase
          .from('orders')
          .select('object_id, order_items ( product_id, quantity )')
          .in('status', ['PENDING', 'APPROVED'])
      ),
    ]);

    if (invRes.error || movRes.error || ordRes.error) {
      this.error.set(
        invRes.error?.message || movRes.error?.message || ordRes.error?.message || 'Failed to load reports.'
      );
      this.loading.set(false);
      return;
    }

    const inv = (invRes.data ?? []) as any[];
    const movs = (movRes.data ?? []) as any[];
    const orders = (ordRes.data ?? []) as { created_at: string }[];

    const startMs = start.getTime();
    const cur = movs.filter((m) => new Date(m.created_at).getTime() >= startMs);
    const prev = movs.filter((m) => new Date(m.created_at).getTime() < startMs);

    // ---------- stock-flow buckets ----------
    const size = days >= 90 ? 7 : 1;
    const n = Math.ceil(days / size);
    this.granularity.set(size === 7 ? 'week' : 'day');

    const buckets: FlowBucket[] = Array.from({ length: n }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i * size);
      return {
        start: d.toISOString(),
        label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
        inU: 0, outU: 0, net: 0, sold: 0, events: 0, balance: 0,
      };
    });

    let unitsIn = 0;
    let unitsOut = 0;
    let sold = 0;

    for (const m of cur) {
      const q = Number(m.quantity) || 0;
      const d = new Date(m.created_at);
      d.setHours(0, 0, 0, 0);
      const day = Math.round((d.getTime() - startMs) / DAY);   // round = DST-safe
      const b = buckets[Math.min(n - 1, Math.max(0, Math.floor(day / size)))];
      if (q > 0) { b.inU += q; unitsIn += q; } else { b.outU += -q; unitsOut += -q; }
      b.net += q;
      b.events += 1;
      if (m.event === 'SALE') { b.sold += Math.abs(q); sold += Math.abs(q); }
    }

    // Walk back from today's balance: closing(i-1) = closing(i) - net(i)
    const onHand = inv.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    let bal = onHand;
    for (let i = n - 1; i >= 0; i--) {
      buckets[i].balance = bal;
      bal -= buckets[i].net;
    }
    const onHandStart = bal;
    this.buckets.set(buckets);

    // ---------- movement mix ----------
    const mixMap = new Map<MovementEvent, { count: number; units: number }>();
    for (const m of cur) {
      const e = m.event as MovementEvent;
      const v = mixMap.get(e) ?? { count: 0, units: 0 };
      v.count += 1;
      v.units += Math.abs(Number(m.quantity) || 0);
      mixMap.set(e, v);
    }
    const totalEvents = cur.length || 1;
    let offset = 0;
    this.mix.set(
      MIX_ORDER.filter((e) => mixMap.has(e)).map((e) => {
        const v = mixMap.get(e)!;
        const pct = (v.count / totalEvents) * 100;
        const slice: MixSlice = { event: e, count: v.count, units: v.units, pct, offset };
        offset += pct;
        return slice;
      })
    );

    // ---------- top-moving products ----------
    const topMap = new Map<string, TopProduct>();
    for (const m of cur) {
      const q = Number(m.quantity) || 0;
      const t = topMap.get(m.product_id) ?? {
        productId: m.product_id,
        name: m.product?.name ?? 'Product',
        sku: m.product?.sku ?? '',
        unitsOut: 0, unitsIn: 0, share: 0,
      };
      if (q < 0) t.unitsOut += -q; else t.unitsIn += q;
      topMap.set(m.product_id, t);
    }
    const totalOut = [...topMap.values()].reduce((s, t) => s + t.unitsOut, 0) || 1;
    this.topProducts.set(
      [...topMap.values()]
        .filter((t) => t.unitsOut > 0)
        .sort((a, b) => b.unitsOut - a.unitsOut)
        .slice(0, 6)
        .map((t) => ({ ...t, share: (t.unitsOut / totalOut) * 100 }))
    );

    // ---------- runway (aggregated per product across stores) ----------
    const soldMap = new Map<string, number>();
    for (const m of cur) {
      if (m.event !== 'SALE') continue;
      soldMap.set(m.product_id, (soldMap.get(m.product_id) ?? 0) + Math.abs(Number(m.quantity) || 0));
    }

    const prodMap = new Map<string, { name: string; sku: string; onHand: number; objects: Set<string> }>();
    for (const r of inv) {
      const p = prodMap.get(r.product_id) ?? {
        name: r.product?.name ?? 'Product',
        sku: r.product?.sku ?? '',
        onHand: 0,
        objects: new Set<string>(),
      };
      p.onHand += Number(r.quantity) || 0;
      p.objects.add(r.object_id);
      prodMap.set(r.product_id, p);
    }

    // Units already on the way (PENDING / APPROVED) — so we never suggest ordering twice.
    const incomingMap = new Map<string, number>();
    for (const o of (openRes.data ?? []) as any[]) {
      for (const it of (o.order_items ?? []) as { product_id: string; quantity: number }[]) {
        incomingMap.set(it.product_id, (incomingMap.get(it.product_id) ?? 0) + (Number(it.quantity) || 0));
      }
    }

    const runway: RunwayRow[] = [...prodMap.entries()].map(([productId, p]) => {
      const unitsSold = soldMap.get(productId) ?? 0;
      const incoming = incomingMap.get(productId) ?? 0;
      const rw = forecast(p.onHand, unitsSold, days, incoming);

      return {
        productId,
        objectId: objectId ?? (p.objects.size === 1 ? [...p.objects][0] : null),
        name: p.name,
        sku: p.sku,
        onHand: p.onHand,
        unitsSold,
        dailyRate: rw.dailyRate,
        daysLeft: rw.daysLeft,
        urgency: rw.urgency,
        lowData: rw.lowData,
        incoming,
        suggestQty: rw.suggest,
      };
    });

    runway.sort(
      (a, b) =>
        RANK[a.urgency] - RANK[b.urgency] ||
        (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) ||
        a.name.localeCompare(b.name)
    );
    this.runway.set(runway);

    // ---------- KPIs ----------
    const soldPrev = prev
      .filter((m) => m.event === 'SALE')
      .reduce((s, m) => s + Math.abs(Number(m.quantity) || 0), 0);
    const ordersCur = orders.filter((o) => new Date(o.created_at).getTime() >= startMs).length;

    this.kpis.set({
      onHand,
      onHandStart,
      unitsIn,
      unitsOut,
      sold,
      soldPrev,
      movements: cur.length,
      movementsPrev: prev.length,
      orders: ordersCur,
      ordersPrev: orders.length - ordersCur,
      reorder: runway.filter((r) => r.urgency === 'out' || r.urgency === 'critical').length,
      soon: runway.filter((r) => r.urgency === 'warning').length,
    });

    this.loaded.set(true);
    this.loading.set(false);
  }
}
