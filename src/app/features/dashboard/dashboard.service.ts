

import { Injectable, computed, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../../core/supabase/supabase.client';

export type Urgency = 'out' | 'critical' | 'warning' | 'healthy' | 'idle';
export type MovementEvent =
  'DELIVERY' | 'SALE' | 'STOCK_COUNT' | 'ADJUSTMENT' | 'TRANSFER' | 'RETURN' | 'WRITE_OFF' | 'SUPPLIER_RETURN';

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

export interface ReceiptAccuracySummary {
  deliveries:number; lines:number; exact_lines:number; short_lines:number; over_lines:number; quality_lines:number;
  short_units:number; over_units:number; quality_rejected_units:number; accuracy_pct:number|null;
}
export interface ReceiptIssueLine {
  delivery_id:string; order_id:string; object_name:string; product_name:string; ordered_qty:number; physical_qty:number; accepted_qty:number;
  short_qty:number; over_qty:number; quality_rejected_qty:number; held_qty:number; immediate_return_qty:number;
  variance_reason_code:string|null; rejection_reason_code:string|null; delivered_at:string;
}
export interface AccuracyV2 { deliveries:ReceiptAccuracySummary; recent_delivery_issues:ReceiptIssueLine[]; counts:{variance:number;accuracy_pct:number|null}; }

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
/**
 * needs_order  nothing requested or ordered
 * top_up       ordered, but not enough
 * requested    a store request waits for procurement review (not incoming stock yet)
 * in_transit   approved purchase orders cover the need
 */
export type ReplenishmentStatus = 'needs_order' | 'top_up' | 'requested' | 'in_transit';
export type CoverageState = 'urgent' | 'needs_order' | 'top_up' | 'covered' | 'no_pace';

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
  urgency: 'out' | 'critical' | 'warning';
  pending_qty: number;
  approved_qty: number;
  incoming_qty: number;
  open_order_id: string | null;
  open_order_number: string | null;
  open_order_status: 'PENDING' | 'APPROVED' | null;
  status: ReplenishmentStatus;
  suggested_qty: number | null;
  shelf_days: number | null; shelf_state: 'out'|'low'|'watch'|'healthy'|'no_pace';
  workflow_state: 'none'|'requested'|'on_the_way';
  projected_qty: number; projected_days: number | null; target_days: number; raw_gap_qty: number;
  supplier_id: string | null; supplier_name: string | null; lead_time_days: number | null;
  pack_size: number; minimum_packs: number; pack_rule_source: string;
  orderable_packs: number; orderable_qty: number; coverage_state: CoverageState;
}

export interface BriefingPart {
  text: string;
  link?: string;
  queryParams?: Record<string, string>;
  /** Scroll to an element on the same page instead of navigating. */
  anchor?: string;
  tone?: 'danger' | 'warning' | 'ok';
}
/** Requests are approved on the review page (supplier split); here only reject. */
export type Decision = 'REJECTED';
export type RangeDays = 7 | 30 | 90;

@Injectable({ providedIn: 'root' })
export class DashboardService {
  readonly data = signal<DashboardSummary | null>(null);
  readonly replenishment = signal<ReplenishmentRow[]>([]);
  /** Open delivery discrepancy lines that still need a decision. */
  readonly deliveryExceptionCount = signal(0);
  readonly loading = signal(false);
  readonly refreshing = signal(false);
  readonly error = signal<string | null>(null);
  readonly accuracyV2 = signal<AccuracyV2 | null>(null);
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

  /** Already being handled: requested (waiting for procurement) or on the way. */
  readonly inProgress = computed(() =>
    this.replenishment().filter((r) => r.status === 'requested' || r.status === 'in_transit'));

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
    const toOrder = this.replenishment().filter(r => r.coverage_state === 'urgent' || r.coverage_state === 'needs_order').length;
    const topUps = this.replenishment().filter(r => r.coverage_state === 'top_up').length;
    const requests = this.pendingCount();
    const onTheWay = d.totals.approved;
    const deliveryIssues = this.deliveryExceptionCount();

    if (toOrder > 0) {
      parts.push({
        text: `${toOrder} ${toOrder === 1 ? 'product is' : 'products are'} at urgent stock risk`,
        anchor: 'needs-attention',
        tone: 'danger',
      });
    }


    if (requests > 0) {
      const pending = this.pendingOrders();
      const one = requests === 1 && pending.length === 1;
      parts.push({
        text: isAdmin
          ? `${requests} ${requests === 1 ? 'request waits' : 'requests wait'} for review`
          : `${requests} ${requests === 1 ? 'request is' : 'requests are'} waiting for procurement`,
        link: isAdmin && one ? `/orders/${pending[0].id}/review` : '/orders',
        queryParams: isAdmin && one ? undefined : { status: 'PENDING' },
        tone: 'warning',
      });
    }

    if (!isAdmin && onTheWay > 0) {
      parts.push({
        text: `${onTheWay} ${onTheWay === 1 ? 'delivery is' : 'deliveries are'} on the way`,
        link: '/orders',
        queryParams: { status: 'APPROVED' },
        tone: 'ok',
      });
    }

    if (deliveryIssues > 0) {
      parts.push({
        text: `${deliveryIssues} ${deliveryIssues === 1 ? 'delivery line needs' : 'delivery lines need'} resolution`,
        link: '/orders',
        queryParams: { exceptions: '1' },
        tone: 'warning',
      });
    }

    if (!parts.length) {
      const handled = this.inProgress().length;
      return [{
        text: handled > 0
          ? `Current replenishment is covered — ${handled} ${handled === 1 ? 'shortage is' : 'shortages are'} already requested or on the way.`
          : 'Current replenishment is covered — no shelf is forecast to run out in the next 7 days.',
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

    const [summary, queue, deliveryExceptions, accuracy] = await Promise.all([
      supabase.rpc('dashboard_summary', { p_object_id: objectId, p_days: days }),
      supabase.rpc('replenishment_queue_v2', { p_object_id: objectId }),
      supabase.rpc('delivery_exceptions', {
        p_status: 'open', p_object_id: objectId, p_delivery_id: null,
      }),
      supabase.rpc('stock_accuracy_report_v2', { p_days: 7, p_object_id: objectId }),
    ]);

    if (summary.error) this.error.set(summary.error.message);
    else this.data.set(summary.data as DashboardSummary);

    // The queue is an enhancement: if it fails the dashboard still works.
    if (queue.error) {
      console.error('replenishment_queue_v2', queue.error);
      this.replenishment.set([]);
    } else {
      this.replenishment.set(((queue.data ?? []) as any[]).map((r) => ({
        ...r,
        days_left: r.shelf_days,
        urgency: r.shelf_state === 'out' ? 'out' : r.shelf_state === 'low' ? 'critical' : 'warning',
        status: r.workflow_state === 'requested' ? 'requested'
          : r.workflow_state === 'on_the_way' && r.coverage_state === 'covered' ? 'in_transit'
          : r.coverage_state === 'top_up' ? 'top_up' : 'needs_order',
        suggested_qty: r.orderable_qty,
      })) as ReplenishmentRow[]);
    }

    if (accuracy.error) console.error('stock_accuracy_report_v2', accuracy.error);
    else this.accuracyV2.set(accuracy.data as AccuracyV2);

    if (deliveryExceptions.error) {
      console.error('delivery_exceptions', deliveryExceptions.error);
      this.deliveryExceptionCount.set(0);
    } else {
      const rows = (deliveryExceptions.data ?? []) as Array<{ line_id: string | null }>;
      this.deliveryExceptionCount.set(
        new Set(
          rows
            .map((row) => row.line_id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
        ).size
      );
    }

    this.loading.set(false);
  }

  async setRange(days: RangeDays): Promise<void> {
    if (days === this.days()) return;
    this.refreshing.set(true);
    await this.load(this.objectId, days);
    this.refreshing.set(false);
  }

  async decide(orderId: string, status: Decision): Promise<string | null> {
    this.deciding.update((m) => new Map(m).set(orderId, status));

    const { data, error } = await supabase
      .from('orders').update({ status }).eq('id', orderId).select('id');

    const failed = !!error || !data || data.length === 0;
    if (failed) this.forget(orderId);
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'delivery_items' }, () => this.scheduleReload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, () => this.scheduleReload())
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





