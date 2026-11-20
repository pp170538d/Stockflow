import { Injectable, computed, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../../core/supabase/supabase.client';

export type Urgency = 'out' | 'critical' | 'warning' | 'healthy' | 'idle';
export type MovementEvent =
  'DELIVERY' | 'SALE' | 'STOCK_COUNT' | 'ADJUSTMENT' | 'TRANSFER' | 'RETURN' | 'WRITE_OFF';

export interface DashTotals {
  on_hand: number; products: number; stores: number;
  pending: number; approved: number;
  orders_week: number; orders_prev: number;
  sold_week: number; sold_prev: number;
}
export interface RunningOutRow {
  object_id: string; product_id: string; name: string; sku: string; store: string;
  on_hand: number; daily_rate: number; days_left: number | null; urgency: Urgency;
}
export interface VarianceLine {
  order_id: string; name: string; store: string;
  ordered_qty: number; delivered_qty: number; variance: number;
  reason: string | null; delivered_at: string;
}
export interface FlowEvents { delivery: number; sale: number; count: number; other: number; }
export interface FlowDay {
  day: string; in: number; out: number; closing: number;
  events?: FlowEvents;
}
export interface PendingOrder {
  id: string; created_at: string; store: string; units: number;
  lines: { name: string; qty: number }[];
}
export interface StoreHealth {
  id: string; name: string; on_hand: number; critical: number; warning: number; rank: number;
}
export interface LedgerRow {
  id: string; event: MovementEvent; quantity: number; reference: string | null;
  created_at: string; name: string; store: string;
}
export interface DashboardSummary {
  generated_at: string;
  days?: number;
  totals: DashTotals;
  running_out: RunningOutRow[];
  variances: { net_week: number; count_net_week: number; lines: VarianceLine[] };
  flow: FlowDay[];
  pending_orders?: PendingOrder[];
  stores: StoreHealth[];
  ledger: LedgerRow[];
}

/** Lifecycle of a product that runs out this week (replenishment_queue RPC). */
export type ReplenishmentStatus = 'needs_order' | 'top_up' | 'pending' | 'in_transit';

export interface ReplenishmentRow {
  object_id: string;
  object_name: string;
  product_id: string;
  sku: string;
  product_name: string;
  on_hand: number;
  sold30: number;
  daily_rate: number;
  days_left: number | null;
  urgency: 'out' | 'critical';
  pending_qty: number;
  approved_qty: number;
  incoming_qty: number;
  open_order_id: string | null;
  open_order_number: string | null;
  open_order_status: 'PENDING' | 'APPROVED' | null;
  status: ReplenishmentStatus;
  suggested_qty: number | null;
}

export interface BriefingPart {
  text: string;
  link?: string;
  queryParams?: Record<string, string>;
  /** Scroll to an element on the same page instead of navigating. */
  anchor?: string;
  tone?: 'danger' | 'warning' | 'ok';
}
export type Decision = 'APPROVED' | 'REJECTED';
export type RangeDays = 7 | 30 | 90;

@Injectable({ providedIn: 'root' })
export class DashboardService {
  readonly data = signal<DashboardSummary | null>(null);
  readonly replenishment = signal<ReplenishmentRow[]>([]);
  readonly loading = signal(false);
  readonly refreshing = signal(false);
  readonly error = signal<string | null>(null);
  readonly freshIds = signal<Set<string>>(new Set());
  readonly live = signal(false);
  readonly days = signal<RangeDays>(30);
  readonly deciding = signal<Map<string, Decision>>(new Map());

  private channel: RealtimeChannel | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private objectId: string | null = null;

  readonly totals = computed(() => this.data()?.totals ?? null);
  readonly runningOut = computed(() => this.data()?.running_out ?? []);
  readonly critical = computed(() =>
    this.runningOut().filter((r) => r.urgency === 'out' || r.urgency === 'critical'));
  readonly ledger = computed(() => this.data()?.ledger ?? []);
  readonly stores = computed(() => this.data()?.stores ?? []);
  readonly variances = computed(() => this.data()?.variances ?? null);

  /** Still needs someone to place an order (nothing, or not enough, ordered). */
  readonly needsOrder = computed(() =>
    this.replenishment().filter((r) => r.status === 'needs_order' || r.status === 'top_up'));

  /** Already handled: enough is ordered and waits for approval or delivery. */
  readonly inProgress = computed(() =>
    this.replenishment().filter((r) => r.status === 'pending' || r.status === 'in_transit'));

  readonly pendingOrders = computed(() => {
    const hidden = this.deciding();
    return (this.data()?.pending_orders ?? []).filter((o) => !hidden.has(o.id));
  });
  readonly pendingCount = computed(() =>
    Math.max(0, (this.totals()?.pending ?? 0) - this.deciding().size));

  readonly flow = computed(() => {
    const f = this.data()?.flow ?? [];
    const first = f.findIndex((d) => d.in > 0 || d.out > 0 || d.closing !== 0);
    if (first <= 0) return f;
    const start = Math.max(0, Math.min(first - 1, f.length - 7));
    return f.slice(start);
  });

  readonly flowTotals = computed(() => {
    const f = this.flow();
    if (!f.length) return null;
    const units_in = f.reduce((s, d) => s + d.in, 0);
    const units_out = f.reduce((s, d) => s + d.out, 0);
    const closing = f[f.length - 1].closing;
    return { opening: closing - units_in + units_out, units_in, units_out, closing };
  });

  readonly salesTrend = computed(() => {
    const t = this.totals();
    if (!t || t.sold_prev === 0) return null;
    return Math.round(((t.sold_week - t.sold_prev) / t.sold_prev) * 100);
  });

  briefing(isAdmin: boolean): BriefingPart[] {
    const d = this.data();
    if (!d) return [];

    const parts: BriefingPart[] = [];
    const toOrder = this.needsOrder().length;
    const waiting = isAdmin ? this.pendingCount() : d.totals.approved;
    const short = d.variances.net_week;

    if (toOrder > 0) {
      parts.push({
        text: `${toOrder} ${toOrder === 1 ? 'product needs' : 'products need'} an order`,
        anchor: 'needs-attention',
        tone: 'danger',
      });
    }

    if (waiting > 0) {
  const pending = this.pendingOrders();

  parts.push({
    text: isAdmin
      ? `${waiting} ${
          waiting === 1
            ? 'order waits'
            : 'orders wait'
        } for your approval`
      : `${waiting} ${
          waiting === 1
            ? 'delivery is'
            : 'deliveries are'
        } on the way`,

    link: '/orders',

    queryParams:
      isAdmin && waiting === 1 && pending.length === 1
        ? {
            focus: pending[0].id,
          }
        : undefined,

    tone: 'warning',
  });
}

    if (short !== 0) parts.push({
      text: `deliveries this week were ${Math.abs(short)} ${short < 0 ? 'short' : 'over'}`,
      link: '/orders', tone: 'warning',
    });

    if (!parts.length) {
      const handled = this.inProgress().length;
      return [{
        text: handled > 0
          ? `Everything is covered — ${handled} ${handled === 1 ? 'shortage is' : 'shortages are'} already on order.`
          : 'Everything is covered — no shelf runs out in the next 7 days.',
        tone: 'ok',
      }];
    }
    return parts;
  }

  async load(objectId: string | null = null, days: RangeDays = this.days()): Promise<void> {
    this.objectId = objectId;
    this.days.set(days);
    if (!this.data()) this.loading.set(true);
    this.error.set(null);

    const [summary, queue] = await Promise.all([
      supabase.rpc('dashboard_summary', { p_object_id: objectId, p_days: days }),
      supabase.rpc('replenishment_queue', { p_object_id: objectId }),
    ]);

    if (summary.error) this.error.set(summary.error.message);
    else this.data.set(summary.data as DashboardSummary);

    // The queue is an enhancement: if it fails the dashboard still works.
    if (queue.error) {
      console.error('replenishment_queue', queue.error);
      this.replenishment.set([]);
    } else {
      this.replenishment.set((queue.data ?? []) as ReplenishmentRow[]);
    }

    this.loading.set(false);
  }

  async setRange(days: RangeDays): Promise<void> {
    if (days === this.days()) return;
    this.refreshing.set(true);
    await this.load(this.objectId, days);
    this.refreshing.set(false);
  }

  async decide(orderId: string, status: Decision | 'PENDING'): Promise<string | null> {
    if (status !== 'PENDING') this.deciding.update((m) => new Map(m).set(orderId, status));

    const { data, error } = await supabase
      .from('orders').update({ status }).eq('id', orderId).select('id');

    const failed = !!error || !data || data.length === 0;
    if (failed && status !== 'PENDING') this.forget(orderId);
    if (failed) return error?.message ?? 'You are not allowed to change this order.';

    await this.load(this.objectId, this.days());
    this.forget(orderId);
    return null;
  }

  private forget(orderId: string): void {
    this.deciding.update((m) => { const n = new Map(m); n.delete(orderId); return n; });
  }

  connect(): void {
    if (this.channel) return;
    this.channel = supabase
      .channel('dashboard-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'stock_movements' }, (payload) => {
        const id = (payload.new as { id?: string }).id;
        if (id) this.freshIds.update((s) => new Set(s).add(id));
        this.scheduleReload();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => this.scheduleReload())
      .subscribe((status) => this.live.set(status === 'SUBSCRIBED'));
  }

  disconnect(): void {
    if (this.channel) supabase.removeChannel(this.channel);
    this.channel = null;
    this.live.set(false);
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(async () => {
      await this.load(this.objectId, this.days());
      setTimeout(() => this.freshIds.set(new Set()), 2500);
    }, 400);
  }
}
