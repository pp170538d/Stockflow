import { Component, computed, inject, signal, effect, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AuthService } from '../../core/auth/auth.service';
import { OrdersService } from './orders.service';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { Order, OrderStatus } from './order.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { RouterLink } from '@angular/router';
import { ConfirmDeliveryComponent } from '../deliveries/confirm-delivery.component';
import { DeliverySummaryComponent } from '../deliveries/delivery-summary.component';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';

@Component({
  selector: 'app-orders',
  standalone: true,
  imports: [
    DatePipe,
    RouterLink,
    BadgeComponent,
    EmptyStateComponent,
    ConfirmDeliveryComponent,
    DeliverySummaryComponent,
  ],
  templateUrl: './orders.component.html',
})
export class OrdersComponent implements OnInit {
  readonly svc = inject(OrdersService);
  readonly deliveries = inject(DeliveriesService);
  readonly auth = inject(AuthService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly statusFilter = signal<OrderStatus | ''>('');
  readonly statuses: OrderStatus[] = ['PENDING', 'APPROVED', 'DELIVERED', 'REJECTED'];

  // --- Confirm-delivery drawer state ---
  readonly deliveringOrder = signal<Order | null>(null);
  readonly deliverDrawerOpen = signal(false);

  // --- View-delivery (read-only) drawer state ---
  readonly summaryOrder = signal<Order | null>(null);
  readonly summaryDrawerOpen = signal(false);

  readonly filtered = computed(() => {
    const s = this.statusFilter();
    const list = this.svc.orders();
    return s ? list.filter((o) => o.status === s) : list;
  });

  constructor() {
    // Whenever the orders list changes, refresh the variance chips for the
    // DELIVERED orders in ONE bulk query (no per-row round-trips).
    effect(() => {
      const deliveredIds = this.svc
        .orders()
        .filter((o) => o.status === 'DELIVERED')
        .map((o) => o.id);
      void this.deliveries.loadVariances(deliveredIds);
    });
  }

  ngOnInit(): void {
    this.svc.load();
  }

  tone(status: OrderStatus): 'warning' | 'info' | 'success' | 'error' {
    return {
      PENDING: 'warning' as const,
      APPROVED: 'info' as const,
      DELIVERED: 'success' as const,
      REJECTED: 'error' as const,
    }[status];
  }

  itemCount(o: Order): number {
    return o.order_items?.reduce((sum, i) => sum + i.quantity, 0) ?? 0;
  }

  /** Variance summary for an order (undefined when it matched exactly). */
  variance(o: Order) {
    return this.deliveries.variances()[o.id];
  }

  /** Short human label for the chip, e.g. "1 short", "2 over", "1 short · 1 over". */
  varianceLabel(o: Order): string {
    const v = this.variance(o);
    if (!v) return '';
    const parts: string[] = [];
    if (v.short > 0) parts.push(`${v.short} short`);
    if (v.over > 0) parts.push(`${v.over} over`);
    return parts.join(' · ');
  }

  // --- Approve: instant, with an Undo toast (revert to PENDING) ---
  async approve(o: Order): Promise<void> {
    const err = await this.svc.setStatus(o.id, 'APPROVED');
    if (err) {
      this.toast.error('Could not approve the order — try again.');
      return;
    }
    this.toast.success(`Order approved for ${o.object?.name ?? 'location'}`, {
      action: {
        label: 'Undo',
        run: async () => {
          await this.svc.setStatus(o.id, 'PENDING');
          this.toast.info('Approval undone — back to Pending.');
        },
      },
    });
  }

  // --- Reject: destructive, so confirm first (danger tone), then toast ---
  async reject(o: Order): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Reject this order?',
      message: `The order for ${o.object?.name ?? 'this location'} will be marked REJECTED. This can’t be undone.`,
      confirmLabel: 'Reject order',
      tone: 'danger',
    });
    if (!ok) return;
    const err = await this.svc.setStatus(o.id, 'REJECTED');
    if (err) this.toast.error('Could not reject the order — try again.');
    else this.toast.info('Order rejected.');
  }

  // --- Confirm delivery ---
  openDeliver(o: Order): void {
    this.deliveringOrder.set(o);
    this.deliverDrawerOpen.set(true);
  }

  closeDeliver(): void {
    this.deliverDrawerOpen.set(false);
    this.deliveringOrder.set(null);
  }

  /** Called after a successful delivery — refresh + confirm with a toast. */
  onDelivered(summary?: string): void {
    this.svc.load();
    this.toast.success(summary ?? 'Delivery recorded — stock updated.');
  }

  // --- View delivery (read-only reconciliation) ---
  openSummary(o: Order): void {
    this.summaryOrder.set(o);
    this.summaryDrawerOpen.set(true);
  }

  closeSummary(): void {
    this.summaryDrawerOpen.set(false);
    this.summaryOrder.set(null);
  }
}
