import { Component, inject, signal, effect, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { OrdersService } from './orders.service';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { Order, OrderStatus } from './order.model';
import { BusinessObject } from '../objects/object.model';

import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
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

  readonly objects = signal<BusinessObject[]>([]);
  readonly selectedObjectId = signal<string>('');
  readonly statusFilter = signal<OrderStatus | ''>('');
  readonly search = signal('');

  readonly statuses: OrderStatus[] = ['PENDING', 'APPROVED', 'DELIVERED', 'REJECTED'];

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // Confirm-delivery drawer state
  readonly deliveringOrder = signal<Order | null>(null);
  readonly deliverDrawerOpen = signal(false);

  // View-delivery drawer state
  readonly summaryOrder = signal<Order | null>(null);
  readonly summaryDrawerOpen = signal(false);

  constructor() {
    // Whenever the current page changes, refresh variance chips only for delivered orders on this page.
    effect(() => {
      const deliveredIds = this.svc
        .orders()
        .filter((o) => o.status === 'DELIVERED')
        .map((o) => o.id);

      void this.deliveries.loadVariances(deliveredIds);
    });
  }

  async ngOnInit(): Promise<void> {
    await this.loadObjects();
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

  reload(page = 1): void {
    void this.svc.load({
      page,
      status: this.statusFilter(),
      objectId: this.selectedObjectId(),
      search: this.search(),
    });
  }

  onStatusChange(status: OrderStatus | ''): void {
    this.statusFilter.set(status);
    this.reload(1);
  }

  onObjectChange(objectId: string): void {
    this.selectedObjectId.set(objectId);
    this.reload(1);
  }

  onSearch(value: string): void {
    this.search.set(value);

    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }

    this.searchTimer = setTimeout(() => {
      this.reload(1);
    }, 250);
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

  variance(o: Order) {
    return this.deliveries.variances()[o.id];
  }

  varianceLabel(o: Order): string {
    const v = this.variance(o);

    if (!v) return '';

    const parts: string[] = [];

    if (v.short > 0) {
      parts.push(`${v.short} short`);
    }

    if (v.over > 0) {
      parts.push(`${v.over} over`);
    }

    return parts.join(' · ');
  }

  async approve(o: Order): Promise<void> {
    const err = await this.svc.setStatus(o.id, 'APPROVED');

    if (err) {
      this.toast.error('Could not approve the order — try again.');
      return;
    }

    this.reload(this.svc.page());

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
    this.toast.info('Order rejected.');
  }

  openDeliver(o: Order): void {
    this.deliveringOrder.set(o);
    this.deliverDrawerOpen.set(true);
  }

  closeDeliver(): void {
    this.deliverDrawerOpen.set(false);
    this.deliveringOrder.set(null);
  }

  onDelivered(summary?: string): void {
    this.reload(this.svc.page());
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
