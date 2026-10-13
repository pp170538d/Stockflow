import { Component, inject, signal, effect, computed, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { OrdersService } from './orders.service';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { Order, OrderStatus } from './order.model';
import { BusinessObject } from '../objects/object.model';

import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { ConfirmDeliveryComponent } from '../deliveries/confirm-delivery.component';
import { DeliverySummaryComponent } from '../deliveries/delivery-summary.component';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';

type StepState = 'done' | 'current' | 'todo' | 'rejected';

interface StatusMeta {
  label: string;
  hint: string;
  chip: string;
  text: string;
  dot: string;
  card: string;
}

@Component({
  selector: 'app-orders',
  standalone: true,
  imports: [
    DatePipe,
    RouterLink,
    EmptyStateComponent,
    ConfirmDeliveryComponent,
    DeliverySummaryComponent,
  ],
  templateUrl: './orders.component.html',
  styles: [`
    @keyframes rowIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .row-in { animation: rowIn .45s cubic-bezier(.2,.8,.2,1) backwards; }

    @keyframes flash { 0%, 40% { background: #eef2ff; } 100% { background: transparent; } }
    .row-flash { animation: flash 2.2s ease-out; }

    @keyframes ping { 0% { transform: scale(1); opacity: .55; } 100% { transform: scale(2.4); opacity: 0; } }
    .step-ping { animation: ping 1.6s cubic-bezier(0,0,.2,1) infinite; }

    .sk { position: relative; overflow: hidden; background: #f1f5f9; border-radius: .5rem; }
    .sk::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.7), transparent);
      animation: shimmer 1.3s infinite; }
    @keyframes shimmer { 100% { transform: translateX(100%); } }

    @media (prefers-reduced-motion: reduce) {
      .row-in, .row-flash, .step-ping, .sk::after { animation: none; }
    }
  `],
})
export class OrdersComponent implements OnInit {
  readonly svc = inject(OrdersService);
  readonly deliveries = inject(DeliveriesService);
  readonly auth = inject(AuthService);

  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly objects = signal<BusinessObject[]>([]);
  readonly selectedObjectId = signal<string>('');
  readonly statusFilter = signal<OrderStatus | ''>('');
  readonly search = signal('');

  readonly statuses: OrderStatus[] = ['PENDING', 'APPROVED', 'DELIVERED', 'REJECTED'];
  /** The happy path, in order. */
  readonly flow: OrderStatus[] = ['PENDING', 'APPROVED', 'DELIVERED'];

  /** Orders per status for the pipeline cards (respects the object filter). */
  readonly counts = signal<Record<OrderStatus, number>>({
    PENDING: 0, APPROVED: 0, DELIVERED: 0, REJECTED: 0,
  });
  readonly countsTotal = computed(() =>
    Object.values(this.counts()).reduce((a, b) => a + b, 0));

  /** Row that just changed state — flashes once. */
  readonly flashId = signal<string | null>(null);

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // Confirm-delivery drawer state
  readonly deliveringOrder = signal<Order | null>(null);
  readonly deliverDrawerOpen = signal(false);
  private lastDeliveringId: string | null = null;

  // View-delivery drawer state
  readonly summaryOrder = signal<Order | null>(null);
  readonly summaryDrawerOpen = signal(false);

  readonly meta: Record<OrderStatus, StatusMeta> = {
    PENDING: {
      label: 'Pending',
      hint: 'Waiting for approval',
      chip: 'bg-amber-50 text-amber-700 ring-amber-200',
      text: 'text-amber-600',
      dot: 'bg-status-pending',
      card: 'bg-amber-50 ring-amber-300',
    },
    APPROVED: {
      label: 'Approved',
      hint: 'On the way to the store',
      chip: 'bg-blue-50 text-blue-700 ring-blue-200',
      text: 'text-blue-600',
      dot: 'bg-status-approved',
      card: 'bg-blue-50 ring-blue-300',
    },
    DELIVERED: {
      label: 'Delivered',
      hint: 'Received · stock updated',
      chip: 'bg-green-50 text-green-700 ring-green-200',
      text: 'text-green-600',
      dot: 'bg-status-delivered',
      card: 'bg-green-50 ring-green-300',
    },
    REJECTED: {
      label: 'Rejected',
      hint: 'Closed without delivery',
      chip: 'bg-red-50 text-red-700 ring-red-200',
      text: 'text-red-600',
      dot: 'bg-status-rejected',
      card: 'bg-red-50 ring-red-300',
    },
  };

  constructor() {
    // Refresh variance chips only for delivered orders on the current page.
    effect(() => {
      const deliveredIds = this.svc
        .orders()
        .filter((o) => o.status === 'DELIVERED')
        .map((o) => o.id);
      void this.deliveries.loadVariances(deliveredIds);
    });
  }

  async ngOnInit(): Promise<void> {
    if (this.auth.isAdmin()) await this.loadObjects();
    this.reload(1);
  }

  private async loadObjects(): Promise<void> {
    const { data } = await supabase
      .from('objects')
      .select('*')
      .eq('active', true)
      .order('name');
    this.objects.set((data ?? []) as BusinessObject[]);
  }

  /** One cheap head-count per status; RLS keeps store users on their own orders. */
  private async loadCounts(): Promise<void> {
    const objectId = this.selectedObjectId();
    const results = await Promise.all(
      this.statuses.map((s) => {
        let q = supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', s);
        if (objectId) q = q.eq('object_id', objectId);
        return q;
      })
    );
    const next = { PENDING: 0, APPROVED: 0, DELIVERED: 0, REJECTED: 0 } as Record<OrderStatus, number>;
    results.forEach((r, i) => (next[this.statuses[i]] = r.count ?? 0));
    this.counts.set(next);
  }

  reload(page = 1): void {
    void this.svc.load({
      page,
      status: this.statusFilter(),
      objectId: this.selectedObjectId(),
      search: this.search(),
    });
    void this.loadCounts();
  }

  onStatusChange(status: OrderStatus | ''): void {
    this.statusFilter.set(this.statusFilter() === status ? '' : status);
    this.reload(1);
  }

  onObjectChange(objectId: string): void {
    this.selectedObjectId.set(objectId);
    this.reload(1);
  }

  onSearch(value: string): void {
    this.search.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.reload(1), 250);
  }

  previous(): void {
    void this.svc.previous({
      status: this.statusFilter(),
      objectId: this.selectedObjectId(),
      search: this.search(),
    });
  }

  next(): void {
    void this.svc.next({
      status: this.statusFilter(),
      objectId: this.selectedObjectId(),
      search: this.search(),
    });
  }

  // ---------- presentation helpers ----------
  shortId(o: Order): string {
    return o.id.slice(0, 8);
  }

  itemCount(o: Order): number {
    return o.order_items?.reduce((sum, i) => sum + i.quantity, 0) ?? 0;
  }

  /** Where this order sits on PENDING → APPROVED → DELIVERED. */
  stepState(o: Order, step: number): StepState {
    if (o.status === 'REJECTED') {
      if (step === 0) return 'done';
      if (step === 1) return 'rejected';
      return 'todo';
    }
    const idx = this.flow.indexOf(o.status);
    if (step < idx) return 'done';
    if (step === idx) return o.status === 'DELIVERED' ? 'done' : 'current';
    return 'todo';
  }

  stepDot(o: Order, step: number): string {
    const state = this.stepState(o, step);
    if (state === 'rejected') return 'bg-status-rejected';
    if (state === 'todo') return 'bg-slate-200';
    return this.meta[this.flow[step]].dot;
  }

  /** Connector leading INTO this step. */
  stepLine(o: Order, step: number): string {
    const state = this.stepState(o, step);
    if (state === 'rejected') return 'bg-red-200';
    if (state === 'todo') return 'bg-slate-200';
    return this.meta[this.flow[step]].dot;
  }

  /** What happens next, said like a human. */
  nextHint(o: Order): string {
    if (o.status === 'PENDING') {
      return this.auth.isAdmin() ? 'Needs your approval' : 'Waiting for approval';
    }
    if (o.status === 'APPROVED') return 'Ready to receive';
    return this.meta[o.status].hint;
  }

  ago(iso: string): string {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  delay(i: number): number {
    return Math.min(i, 12) * 35;
  }

  variance(o: Order) {
    return this.deliveries.variances()[o.id];
  }

  varianceLabel(o: Order): string {
    const v = this.variance(o);
    if (!v) return '';
    const parts: string[] = [];
    if (v.short > 0) parts.push(`${v.short} short`);
    if (v.over > 0) parts.push(`${v.over} over`);
    return parts.join(' · ');
  }

  private flash(id: string): void {
    this.flashId.set(id);
    setTimeout(() => this.flashId.set(null), 2300);
  }

  // ---------- actions ----------
  async approve(o: Order): Promise<void> {
    const err = await this.svc.setStatus(o.id, 'APPROVED');
    if (err) {
      this.toast.error('Could not approve the order — try again.');
      return;
    }

    this.reload(this.svc.page());
    this.flash(o.id);

    this.toast.success(`Order approved for ${o.object?.name ?? 'location'}`, {
      action: {
        label: 'Undo',
        run: async () => {
          const undoErr = await this.svc.setStatus(o.id, 'PENDING');
          if (undoErr) {
            this.toast.error('Could not undo approval — try again.');
            return;
          }
          this.reload(this.svc.page());
          this.flash(o.id);
          this.toast.info('Approval undone — back to Pending.');
        },
      },
    });
  }

  async reject(o: Order): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Reject this order?',
      message: `The order for ${o.object?.name ?? 'this location'} will be marked REJECTED. This can't be undone.`,
      confirmLabel: 'Reject order',
      tone: 'danger',
    });
    if (!ok) return;

    const err = await this.svc.setStatus(o.id, 'REJECTED');
    if (err) {
      this.toast.error('Could not reject the order — try again.');
      return;
    }

    this.reload(this.svc.page());
    this.flash(o.id);
    this.toast.info('Order rejected.');
  }

  openDeliver(o: Order): void {
    this.lastDeliveringId = o.id;
    this.deliveringOrder.set(o);
    this.deliverDrawerOpen.set(true);
  }

  closeDeliver(): void {
    this.deliverDrawerOpen.set(false);
    this.deliveringOrder.set(null);
  }

  onDelivered(summary?: string): void {
    this.reload(this.svc.page());
    if (this.lastDeliveringId) this.flash(this.lastDeliveringId);
    this.toast.success(summary ?? 'Delivery recorded — stock updated.');
  }

  openSummary(o: Order): void {
    this.summaryOrder.set(o);
    this.summaryDrawerOpen.set(true);
  }

  closeSummary(): void {
    this.summaryDrawerOpen.set(false);
    this.summaryOrder.set(null);
  }
}
