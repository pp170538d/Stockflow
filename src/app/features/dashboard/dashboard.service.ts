import { Injectable, computed, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../../core/supabase/supabase.client';

// ---------- types (mirror dashboard_summary() v2 JSON) ----------
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
  events?: FlowEvents;   // optional → still works against the v1 RPC
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

export interface BriefingPart { text: string; link?: string; tone?: 'danger' | 'warning' | 'ok'; }
export type Decision = 'APPROVED' | 'REJECTED';
export type RangeDays = 7 | 30 | 90;

@Injectable({ providedIn: 'root' })
export class DashboardService {
  readonly data = signal<DashboardSummary | null>(null);
  readonly loading = signal(false);
  /** Range switch in progress → dim the chart instead of showing skeletons. */
  readonly refreshing = signal(false);
  readonly error = signal<string | null>(null);
  readonly freshIds = signal<Set<string>>(new Set());
  readonly live = signal(false);
  readonly days = signal<RangeDays>(30);

  /** Orders being approved/rejected right now → instant optimistic hide. */
  readonly deciding = signal<Map<string, Decision>>(new Map());

  private channel: RealtimeChannel | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private objectId: string | null = null;

  // ---------- derived ----------
  readonly totals = computed(() => this.data()?.totals ?? null);
  readonly runningOut = computed(() => this.data()?.running_out ?? []);
  readonly critical = computed(() =>
    this.runningOut().filter((r) => r.urgency === 'out' || r.urgency === 'critical'));
  readonly ledger = computed(() => this.data()?.ledger ?? []);
  readonly stores = computed(() => this.data()?.stores ?? []);
  readonly variances = computed(() => this.data()?.variances ?? null);

  /** Pending orders minus the ones the user just decided on. */
  readonly pendingOrders = computed(() => {
    const hidden = this.deciding();
    return (this.data()?.pending_orders ?? []).filter((o) => !hidden.has(o.id));
  });

  /** Pending count corrected for optimistic decisions. */
  readonly pendingCount = computed(() =>
    Math.max(0, (this.totals()?.pending ?? 0) - this.deciding().size));

  /**
   * Flow trimmed to start one day before the first activity, so an empty
   * month doesn't squash all the action into the right edge. At least 7 days
   * are always shown so a single busy day still has context.
   */
  readonly flow = computed(() => {
    const f = this.data()?.flow ?? [];
    const first = f.findIndex((d) => d.in > 0 || d.out > 0 || d.closing !== 0);
    if (first <= 0) return f;
    const start = Math.max(0, Math.min(first - 1, f.length - 7));
    return f.slice(start);
  });

  /** Totals over the visible window, for the ledger equation. */
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
    const crit = this.critical().length;
    const waiting = isAdmin ? this.pendingCount() : d.totals.approved;
    const short = d.variances.net_week;

    if (crit > 0) parts.push({ text: `${crit} ${crit === 1 ? 'product runs' : 'products run'} out this week`, link: isAdmin ? '/reports' : '/inventory', tone: 'danger' });
    if (waiting > 0) parts.push({
      text: isAdmin
        ? `${waiting} ${waiting === 1 ? 'order waits' : 'orders wait'} for your approval`
        : `${waiting} ${waiting === 1 ? 'delivery is' : 'deliveries are'} on the way`,
      link: '/orders', tone: 'warning',
    });
    if (short !== 0) parts.push({ text: `deliveries this week were ${Math.abs(short)} ${short < 0 ? 'short' : 'over'}`, link: '/orders', tone: 'warning' });

    if (!parts.length) return [{ text: 'Everything is covered — no shelf runs out in the next 14 days.', tone: 'ok' }];
    return parts;
  }

  // ---------- loading ----------
  async load(objectId: string | null = null, days: RangeDays = this.days()): Promise<void> {
    this.objectId = objectId;
    this.days.set(days);
    if (!this.data()) this.loading.set(true);
    this.error.set(null);

    const { data, error } = await supabase.rpc('dashboard_summary', {
      p_object_id: objectId, p_days: days,
    });

    if (error) this.error.set(error.message);
    else this.data.set(data as DashboardSummary);
    this.loading.set(false);
  }

  async setRange(days: RangeDays): Promise<void> {
    if (days === this.days()) return;
    this.refreshing.set(true);
    await this.load(this.objectId, days);
    this.refreshing.set(false);
  }

  // ---------- approve / reject ----------
  /**
   * Same write as OrdersService.setStatus — RLS decides if it's allowed.
   * Optimistic: the card disappears immediately; on failure it comes back.
   * Returns an error message or null.
   */
  async decide(orderId: string, status: Decision | 'PENDING'): Promise<string | null> {
    if (status !== 'PENDING') {
      this.deciding.update((m) => new Map(m).set(orderId, status));
    }

    const { data, error } = await supabase
      .from('orders')
      .update({ status })
      .eq('id', orderId)
      .select('id');

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

  // ---------- realtime ----------
  connect(): void {
    if (this.channel) return;
    this.channel = supabase
      .channel('dashboard-live')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'stock_movements' },
        (payload) => {
          const id = (payload.new as { id?: string }).id;
          if (id) this.freshIds.update((s) => new Set(s).add(id));
          this.scheduleReload();
        })
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        () => this.scheduleReload())
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
