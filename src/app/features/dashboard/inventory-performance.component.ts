import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { DashboardService, ReplenishmentRow, ReplenishmentStatus } from './dashboard.service';

export type PerformanceClass = 'fast' | 'normal' | 'slow' | 'dead' | 'stockout' | 'idle';

export interface PerformanceAction {
  object_id: string;
  object_name: string;
  product_id: string;
  sku: string;
  product_name: string;
  on_hand: number;
  sold: number;
  turnover: number | null;
  days_of_stock: number | null;
  days_out: number;
  stock_value: number | null;
  class: PerformanceClass;
  rank: number;
}

export interface PerformanceSummary {
  generated_at: string;
  days: number;
  currency: string;
  inventory_value: number;
  cost_coverage: number | null;
  sold_units: number;
  avg_stock: number;
  turnover: number | null;
  days_of_inventory: number | null;
  revenue: number;
  cogs: number;
  margin: number;
  gross_margin_pct: number | null;
  price_coverage: number | null;
  slow_dead_value: number;
  slow_dead_share: number | null;
  classes: Record<PerformanceClass, number>;
  actions: PerformanceAction[];
  history_days_min: number;
  history_days_max: number;
  history_complete: boolean;
  history_coverage: number;
}

@Component({
  selector: 'app-inventory-performance',
  standalone: true,
  imports: [DecimalPipe, PercentPipe, RouterLink],
  templateUrl: './inventory-performance.component.html',
})
export class InventoryPerformanceComponent {
  readonly auth = inject(AuthService);
  readonly dashboard = inject(DashboardService);

  readonly data = signal<PerformanceSummary | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly isAdmin = computed(() => this.auth.isAdmin());

  readonly totalClassified = computed(() => {
    const c = this.data()?.classes;
    return c ? Object.values(c).reduce((s, n) => s + n, 0) : 0;
  });

  readonly replenishment = computed(() => this.dashboard.replenishment());

  /** Replenishment rows where someone still has to place/top-up an order. */
  readonly openReplenishment = computed(() =>
    this.replenishment().filter((r) => r.status === 'needs_order' || r.status === 'top_up')
  );

  /** Replenishment rows that are already covered by the order workflow. */
  readonly handledReplenishment = computed(() =>
  this.replenishment().filter((r) =>
    r.status === 'in_transit' ||
    (!this.isAdmin() && r.status === 'pending')
  )
);

  readonly performanceActions = computed(() => this.data()?.actions ?? []);

  /**
   * Stockout here is historical performance (days at zero stock in the selected
   * period), not a current task. Current shortage work belongs to replenishment.
   * Keep stockout in Inventory Health and Reports, not in Needs attention.
   */
  readonly visiblePerformanceActions = computed(() =>
    this.performanceActions().filter((a) => a.class !== 'stockout')
  );

  /** Badge deliberately counts only unresolved work, not already-handled rows. */
  readonly attentionCount = computed(() =>
    this.openReplenishment().length + this.visiblePerformanceActions().length
  );

  constructor() {
    effect(() => {
      const days = this.dashboard.days();
      const refresh = this.dashboard.data()?.generated_at ?? '';
      untracked(() => void this.load(days, refresh));
    });
  }

  private async load(days: number, _refresh: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const objectId = this.isAdmin() ? null : this.auth.profile()?.object_id ?? null;
    const { data, error } = await supabase.rpc('inventory_performance_summary', {
      p_days: days,
      p_object_id: objectId,
    });

    if (error) {
      this.error.set(error.message);
      this.data.set(null);
    } else {
      this.data.set(data as PerformanceSummary);
    }

    this.loading.set(false);
  }

  classPct(kind: PerformanceClass): number {
    const d = this.data();
    const total = this.totalClassified();
    return !d || !total ? 0 : (d.classes[kind] / total) * 100;
  }

  classCount(kind: string): number {
    return this.data()?.classes[kind as PerformanceClass] ?? 0;
  }

  tone(kind: PerformanceClass): string {
    return {
      stockout: 'bg-red-50 text-red-700 ring-red-200',
      dead: 'bg-violet-50 text-violet-700 ring-violet-200',
      slow: 'bg-amber-50 text-amber-700 ring-amber-200',
      normal: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
      fast: 'bg-sky-50 text-sky-700 ring-sky-200',
      idle: 'bg-slate-100 text-slate-600 ring-slate-200',
    }[kind];
  }

  label(kind: PerformanceClass): string {
    return {
      stockout: 'Stockout risk',
      dead: 'Dead stock',
      slow: 'Slow mover',
      normal: 'Normal',
      fast: 'Fast mover',
      idle: 'Idle',
    }[kind];
  }

  actionText(a: PerformanceAction): string {
    if (a.class === 'dead') return 'No sales in this period';
    if (a.class === 'stockout') {
      return `${a.days_out} day${a.days_out === 1 ? '' : 's'} at zero stock`;
    }
    if (a.days_of_stock !== null) return `${a.days_of_stock.toFixed(1)} days of stock`;
    return 'Review inventory';
  }

  replTone(s: ReplenishmentStatus): string {
    return {
      needs_order: 'bg-red-50 text-red-700 ring-red-200',
      top_up: 'bg-orange-50 text-orange-700 ring-orange-200',
      pending: 'bg-amber-50 text-amber-700 ring-amber-200',
      in_transit: 'bg-sky-50 text-sky-700 ring-sky-200',
    }[s];
  }

  replLabel(s: ReplenishmentStatus): string {
    return {
      needs_order: 'Needs order',
      top_up: 'Order more',
      pending: 'Waiting approval',
      in_transit: 'On the way',
    }[s];
  }

  replText(r: ReplenishmentRow): string {
    const shelf = r.urgency === 'out'
      ? 'Out of stock'
      : r.days_left === null
        ? 'No sales pace'
        : `${Math.max(0, Math.round(r.days_left))} days left`;

    switch (r.status) {
      case 'needs_order':
        return shelf;
      case 'top_up':
        return `${shelf} · ${r.incoming_qty} ordered, not enough`;
      case 'pending':
        return `${shelf} · ${r.pending_qty} on ${r.open_order_number ?? 'an order'} · waiting approval`;
      default:
        return `${shelf} · ${r.approved_qty} approved, arriving`;
    }
  }

  orderParams(r: ReplenishmentRow): Record<string, string | number> {
    const params: Record<string, string | number> = {
      object: r.object_id,
      product: r.product_id,
    };
    if (r.suggested_qty) params['qty'] = r.suggested_qty;
    return params;
  }
}
