import {
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { printPurchaseOrder } from './order-pdf';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';

import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.model';

import { DeliveriesService } from '../deliveries/deliveries.service';
import { BusinessObject } from '../objects/object.model';

import { LocationPickerComponent } from '../../shared/ui/location-picker.component';
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
    LocationPickerComponent,
  ],
  templateUrl: './orders.component.html',
  styles: [`
    @keyframes rowIn {
      from {
        opacity: 0;
        transform: translateY(6px);
      }

      to {
        opacity: 1;
        transform: none;
      }
    }

    .row-in {
      animation: rowIn .45s cubic-bezier(.2,.8,.2,1) backwards;
    }

    @keyframes flash {
      0%, 40% {
        background: #eef2ff;
      }

      100% {
        background: transparent;
      }
    }

    .row-flash {
      animation: flash 2.2s ease-out;
    }

    @keyframes ping {
      0% {
        transform: scale(1);
        opacity: .55;
      }

      100% {
        transform: scale(2.4);
        opacity: 0;
      }
    }

    .step-ping {
      animation: ping 1.6s cubic-bezier(0,0,.2,1) infinite;
    }

    .sk {
      position: relative;
      overflow: hidden;
      background: #f1f5f9;
      border-radius: .5rem;
    }

    .sk::after {
      content: '';
      position: absolute;
      inset: 0;
      transform: translateX(-100%);
      background: linear-gradient(
        90deg,
        transparent,
        rgba(255,255,255,.7),
        transparent
      );
      animation: shimmer 1.3s infinite;
    }

    @keyframes shimmer {
      100% {
        transform: translateX(100%);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .row-in,
      .row-flash,
      .step-ping,
      .sk::after {
        animation: none;
      }
    }
  `],
})
export class OrdersComponent implements OnInit {
  readonly svc = inject(OrdersService);
  readonly deliveries = inject(DeliveriesService);
  readonly auth = inject(AuthService);

  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  // =========================================================
  // Filters
  // =========================================================

  readonly objects = signal<BusinessObject[]>([]);

  readonly selectedObjectId = signal<string>('');

  readonly filterLocations = computed(() => [
    {
      id: '',
      name: 'All locations',
    },
    ...this.objects(),
  ]);

  readonly statusFilter = signal<OrderStatus | ''>('');
  readonly exceptionsOnly = signal(false);
  readonly exceptionCount = signal(0);
  readonly search = signal('');

  readonly statuses: OrderStatus[] = [
    'PENDING',
    'APPROVED',
    'DELIVERED',
    'REJECTED',
  ];

  /**
   * Normal fulfillment path.
   *
   * REJECTED is intentionally not part of this flow.
   */
  readonly flow: OrderStatus[] = [
    'PENDING',
    'APPROVED',
    'DELIVERED',
  ];

  readonly counts = signal<Record<OrderStatus, number>>({
    PENDING: 0,
    APPROVED: 0,
    DELIVERED: 0,
    REJECTED: 0,
  });

  readonly countsTotal = computed(() =>
    Object.values(this.counts()).reduce(
      (sum, value) => sum + value,
      0
    )
  );

  /**
   * Recently changed order.
   * Used for the flash animation after status updates.
   */
  readonly flashId = signal<string | null>(null);

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // =========================================================
  // Confirm delivery drawer
  // =========================================================

  readonly deliveringOrder = signal<Order | null>(null);
  readonly deliverDrawerOpen = signal(false);

  private lastDeliveringId: string | null = null;

  // =========================================================
  // Delivery summary drawer
  // =========================================================

  readonly summaryOrder = signal<Order | null>(null);
  readonly summaryDrawerOpen = signal(false);

  // =========================================================
  // Status presentation
  // =========================================================

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
    /**
     * Load variance information only for delivered orders
     * currently visible on the page.
     */
    effect(() => {
      const deliveredIds = this.svc
        .orders()
        .filter((order) => order.status === 'DELIVERED')
        .map((order) => order.id);

      void this.deliveries.loadVariances(deliveredIds);
    });
  }

  // =========================================================
  // Init
  // =========================================================

  async ngOnInit(): Promise<void> {
    if (this.auth.isAdmin()) {
      await this.loadObjects();
    }

    this.reload(1);
  }

  private async loadObjects(): Promise<void> {
    const { data } = await supabase
      .from('objects')
      .select('*')
      .eq('active', true)
      .order('name');

    this.objects.set(
      (data ?? []) as BusinessObject[]
    );
  }

  // =========================================================
  // Counts
  // =========================================================

  /**
   * RLS still controls which orders the current user
   * is allowed to count.
   */
  private async loadCounts(): Promise<void> {
    const objectId = this.selectedObjectId();

    const results = await Promise.all(
      this.statuses.map((status) => {
        let query = supabase
          .from('orders')
          .select('id', {
            count: 'exact',
            head: true,
          })
          .eq('status', status);

        if (objectId) {
          query = query.eq(
            'object_id',
            objectId
          );
        }

        return query;
      })
    );

    const next: Record<OrderStatus, number> = {
      PENDING: 0,
      APPROVED: 0,
      DELIVERED: 0,
      REJECTED: 0,
    };

    results.forEach((result, index) => {
      next[this.statuses[index]] =
        result.count ?? 0;
    });

    this.counts.set(next);

    let exceptionQuery = supabase
      .from('order_fulfillment')
      .select('order_id')
      .neq('variance', 0);

    const {
      data: exceptionRows,
      error: exceptionError,
    } = await exceptionQuery;

    if (exceptionError) {
      this.exceptionCount.set(0);
      return;
    }

    const exceptionIds = [
      ...new Set(
        (exceptionRows ?? []).map(
          (row) => row.order_id as string
        )
      ),
    ];

    if (
      !objectId ||
      exceptionIds.length === 0
    ) {
      this.exceptionCount.set(
        objectId
          ? 0
          : exceptionIds.length
      );

      return;
    }

    const {
      count: locationExceptionCount,
    } = await supabase
      .from('orders')
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq('status', 'DELIVERED')
      .eq('object_id', objectId)
      .in('id', exceptionIds);

    this.exceptionCount.set(
      locationExceptionCount ?? 0
    );
  }

  // =========================================================
  // Loading / filters
  // =========================================================

  reload(page = 1): void {
    void this.svc.load({
      page,
      status: this.statusFilter(),
      objectId: this.selectedObjectId(),
      search: this.search(),
      exceptionsOnly: this.exceptionsOnly(),
    });

    void this.loadCounts();
  }

  onStatusChange(status: OrderStatus | ''): void {
    this.exceptionsOnly.set(false);

    this.statusFilter.set(
      this.statusFilter() === status
        ? ''
        : status
    );

    this.reload(1);
  }

  showAll(): void {
    this.statusFilter.set('');
    this.exceptionsOnly.set(false);
    this.reload(1);
  }

  showExceptions(): void {
    const willEnable =
      !this.exceptionsOnly();

    this.exceptionsOnly.set(
      willEnable
    );

    this.statusFilter.set('');

    this.reload(1);
  }

  onObjectChange(
    objectId: string
  ): void {
    this.selectedObjectId.set(objectId);
    this.reload(1);
  }

  onSearch(value: string): void {
    this.search.set(value);

    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }

    this.searchTimer = setTimeout(
      () => this.reload(1),
      250
    );
  }

  previous(): void {
    void this.svc.previous({
      status: this.statusFilter(),
      objectId: this.selectedObjectId(),
      search: this.search(),
      exceptionsOnly: this.exceptionsOnly(),
    });
  }

  next(): void {
    void this.svc.next({
      status: this.statusFilter(),
      objectId: this.selectedObjectId(),
      search: this.search(),
      exceptionsOnly: this.exceptionsOnly(),
    });
  }

  // =========================================================
  // Presentation helpers
  // =========================================================

  itemCount(order: Order): number {
    return (
      order.order_items?.reduce(
        (sum, item) =>
          sum + item.quantity,
        0
      ) ?? 0
    );
  }

  /**
   * Where the order currently sits in:
   *
   * PENDING → APPROVED → DELIVERED
   */
  stepState(
    order: Order,
    step: number
  ): StepState {
    if (order.status === 'REJECTED') {
      if (step === 0) {
        return 'done';
      }

      if (step === 1) {
        return 'rejected';
      }

      return 'todo';
    }

    const index = this.flow.indexOf(
      order.status
    );

    if (step < index) {
      return 'done';
    }

    if (step === index) {
      return order.status === 'DELIVERED'
        ? 'done'
        : 'current';
    }

    return 'todo';
  }

  stepDot(
    order: Order,
    step: number
  ): string {
    const state = this.stepState(
      order,
      step
    );

    if (state === 'rejected') {
      return 'bg-status-rejected';
    }

    if (state === 'todo') {
      return 'bg-slate-200';
    }

    return this.meta[
      this.flow[step]
    ].dot;
  }

  /**
   * Connector leading INTO a lifecycle step.
   */
  stepLine(
    order: Order,
    step: number
  ): string {
    const state = this.stepState(
      order,
      step
    );

    if (state === 'rejected') {
      return 'bg-red-200';
    }

    if (state === 'todo') {
      return 'bg-slate-200';
    }

    return this.meta[
      this.flow[step]
    ].dot;
  }

  nextHint(order: Order): string {
    if (order.status === 'PENDING') {
      return this.auth.isAdmin()
        ? 'Needs your approval'
        : 'Waiting for approval';
    }

    if (order.status === 'APPROVED') {
      return 'Ready to receive';
    }

    return this.meta[
      order.status
    ].hint;
  }

  ago(iso: string): string {
    const seconds = Math.max(
      0,
      (
        Date.now() -
        new Date(iso).getTime()
      ) / 1000
    );

    if (seconds < 60) {
      return 'just now';
    }

    if (seconds < 3600) {
      return `${Math.floor(
        seconds / 60
      )}m ago`;
    }

    if (seconds < 86400) {
      return `${Math.floor(
        seconds / 3600
      )}h ago`;
    }

    if (seconds < 604800) {
      return `${Math.floor(
        seconds / 86400
      )}d ago`;
    }

    return new Date(
      iso
    ).toLocaleDateString(
      'en-GB',
      {
        day: 'numeric',
        month: 'short',
      }
    );
  }

  delay(index: number): number {
    return Math.min(
      index,
      12
    ) * 35;
  }

  variance(order: Order) {
    return this.deliveries
      .variances()[order.id];
  }

  varianceLabel(
    order: Order
  ): string {
    const variance =
      this.variance(order);

    if (!variance) {
      return '';
    }

    const parts: string[] = [];

    if (variance.short > 0) {
      parts.push(
        `${variance.short} short`
      );
    }

    if (variance.over > 0) {
      parts.push(
        `${variance.over} over`
      );
    }

    return parts.join(' · ');
  }

  private flash(id: string): void {
    this.flashId.set(id);

    setTimeout(
      () =>
        this.flashId.set(null),
      2300
    );
  }

  // =========================================================
  // Actions
  // =========================================================
  printOrder(order: Order): void {
    const error = printPurchaseOrder(order);

    if (error) {
      this.toast.error(error);
    }
  }


  async approve(
    order: Order
  ): Promise<void> {
    const error =
      await this.svc.setStatus(
        order.id,
        'APPROVED'
      );

    if (error) {
      this.toast.error(error);
      return;
    }

    this.reload(
      this.svc.page()
    );

    this.flash(order.id);

    this.toast.success(
      `${order.order_number} approved`,
      {
        action: {
          label: 'Undo',

          run: async () => {
            const undoError =
              await this.svc.setStatus(
                order.id,
                'PENDING'
              );

            if (undoError) {
              this.toast.error(
                undoError
              );

              return;
            }

            this.reload(
              this.svc.page()
            );

            this.flash(
              order.id
            );

            this.toast.info(
              'Approval undone — back to Pending.'
            );
          },
        },
      }
    );
  }

  async reject(
    order: Order
  ): Promise<void> {
    const ok =
      await this.confirm.ask({
        title:
          'Reject this order?',

        message:
          `${order.order_number} for ` +
          `${order.object?.name ?? 'this location'} ` +
          `will be marked REJECTED. ` +
          `This can't be undone.`,

        confirmLabel:
          'Reject order',

        tone:
          'danger',
      });

    if (!ok) {
      return;
    }

    const error =
      await this.svc.setStatus(
        order.id,
        'REJECTED'
      );

    if (error) {
      this.toast.error(error);
      return;
    }

    this.reload(
      this.svc.page()
    );

    this.flash(
      order.id
    );

    this.toast.info(
      `${order.order_number} rejected.`
    );
  }

  // =========================================================
  // Delivery
  // =========================================================

  openDeliver(
    order: Order
  ): void {
    this.lastDeliveringId =
      order.id;

    this.deliveringOrder.set(
      order
    );

    this.deliverDrawerOpen.set(
      true
    );
  }

  closeDeliver(): void {
    this.deliverDrawerOpen.set(
      false
    );

    this.deliveringOrder.set(
      null
    );
  }

  onDelivered(
    summary?: string
  ): void {
    this.reload(
      this.svc.page()
    );

    if (
      this.lastDeliveringId
    ) {
      this.flash(
        this.lastDeliveringId
      );
    }

    this.toast.success(
      summary ??
      'Delivery recorded — stock updated.'
    );
  }

  // =========================================================
  // Delivery summary
  // =========================================================

  openSummary(
    order: Order
  ): void {
    this.summaryOrder.set(
      order
    );

    this.summaryDrawerOpen.set(
      true
    );
  }

  closeSummary(): void {
    this.summaryDrawerOpen.set(
      false
    );

    this.summaryOrder.set(
      null
    );
  }
}