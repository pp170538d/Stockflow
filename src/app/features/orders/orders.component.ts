import {
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { printPurchaseOrder } from './order-pdf';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';

import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.model';

import { DeliveriesService } from '../deliveries/deliveries.service';
import { BusinessObject } from '../objects/object.model';

import { LocationPickerComponent } from '../../shared/ui/location-picker.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
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
  private route = inject(ActivatedRoute);
  private router = inject(Router);

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
  readonly workQueue = signal(true);
  readonly receivedThisMonth =
    signal(false);
  readonly workload = signal({ needs_review: 0, awaiting_receipt: 0, needs_resolution: 0, received_this_month: 0 });
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
  readonly operational = signal<
    Record<
      string,
      {
        grn: string | null;

        held: number;
        openClaims: number;

        damaged: number;
        wrongItem: number;
        otherQuality: number;

        openShort: number;
        openOver: number;
        openHeld: number;
        oldestOpenAt: string | null;
      }
    >
  >({});

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
      label: 'Requests',
      hint: 'Waiting for review',
      chip: 'bg-amber-50 text-amber-700 ring-amber-200',
      text: 'text-amber-600',
      dot: 'bg-status-pending',
      card: 'bg-amber-50 ring-amber-300',
    },

    APPROVED: {
      label: 'Purchase orders',
      hint: 'Approved · awaiting receipt',
      chip: 'bg-blue-50 text-blue-700 ring-blue-200',
      text: 'text-blue-600',
      dot: 'bg-status-approved',
      card: 'bg-blue-50 ring-blue-300',
    },

    DELIVERED: {
      label: 'Received',
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
      void this.loadOperationalRefs(this.svc.orders().map((o) => o.id));
    });
  }

  // =========================================================
  // Init
  // =========================================================

  async ngOnInit(): Promise<void> {
    if (this.auth.isAdmin()) {
      await this.loadObjects();
    }

    const queryParams =
      this.route.snapshot.queryParamMap;

    const focusId =
      queryParams.get('focus');

    const openExceptions =
      queryParams.get('exceptions') === '1';

    const requestedStatus =
      queryParams.get('status');

    // 1. Explicitly focus one specific order.
    if (focusId) {
      await this.focusOrder(focusId);
      return;
    }

    // 2. Open only orders with unresolved delivery differences.
    if (openExceptions) {
      this.exceptionsOnly.set(true);
      this.statusFilter.set('');
      this.search.set('');

      this.reload(1);
      return;
    }

    // 3. Open a requested status, e.g.
    // /orders?status=APPROVED
    if (
      requestedStatus &&
      this.statuses.includes(
        requestedStatus as OrderStatus
      )
    ) {
      this.workQueue.set(false);
      this.exceptionsOnly.set(false);

      this.statusFilter.set(
        requestedStatus as OrderStatus
      );

      // Important after a split:
      // don't leave an order number in the search box.
      this.search.set('');

      this.reload(1);
      return;
    }

    // 4. Normal Orders landing.
    this.exceptionsOnly.set(false);
    this.search.set('');

    this.reload(1);
  }

  /** Finds the exact order regardless of pagination, then scrolls and flashes it. */
  private async focusOrder(orderId: string): Promise<void> {
    const { data: target, error } = await supabase
      .from('orders')
      .select('id, order_number, object_id, status')
      .eq('id', orderId)
      .maybeSingle();

    if (error || !target) {
      this.reload(1);
      return;
    }

    this.exceptionsOnly.set(false);
    this.statusFilter.set(target.status as OrderStatus);
    this.selectedObjectId.set(target.object_id);
    this.search.set(target.order_number);

    await Promise.all([
      this.svc.load({
        page: 1,
        status: this.statusFilter(),
        objectId: this.selectedObjectId(),
        search: this.search(),
        exceptionsOnly: false,
      }),
      this.loadCounts(),
    ]);

    this.scrollAndFlashOrder(orderId);

    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { focus: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private scrollAndFlashOrder(orderId: string): void {
    this.flashId.set(orderId);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(`[data-order-id="${orderId}"]`)
        );
        const target = nodes.find((node) => node.offsetParent !== null) ?? nodes[0];
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });

    setTimeout(() => this.flashId.set(null), 2300);
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
    const { data: workload } = await supabase.rpc('orders_workload_summary', { p_object_id: this.selectedObjectId() || null });
    if (workload) this.workload.set(workload as any);
    const objectId =
      this.selectedObjectId() || null;

    // -------------------------------------------------------
    // ORDER STATUS COUNTS
    // -------------------------------------------------------

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

    // Needs resolution counts affected ORDERS, not individual lines.
    // An order needs action when it has an open receipt exception OR physical held goods.
    const [{ data: openRows, error: openError }, { data: heldRows, error: heldError }] = await Promise.all([
      supabase.rpc('delivery_exceptions', {
        p_status: 'open', p_object_id: objectId, p_delivery_id: null,
      }),
      (() => {
        let q = supabase.from('held_stock_overview')
          .select('delivery_id, object_id, remaining_qty')
          .gt('remaining_qty', 0);
        if (objectId) q = q.eq('object_id', objectId);
        return q;
      })(),
    ]);

    if (openError || heldError) {
      console.error('Could not load orders needing resolution', openError ?? heldError);
      this.exceptionCount.set(0);
      return;
    }

    const actionOrderIds = new Set<string>(
      ((openRows ?? []) as Array<{ order_id: string | null }>)
        .map((row) => row.order_id)
        .filter((id): id is string => !!id)
    );
    const heldDeliveryIds = [...new Set(
      ((heldRows ?? []) as Array<{ delivery_id: string | null }>)
        .map((row) => row.delivery_id)
        .filter((id): id is string => !!id)
    )];
    if (heldDeliveryIds.length) {
      const { data: heldDeliveries } = await supabase
        .from('deliveries').select('order_id').in('id', heldDeliveryIds);
      for (const row of (heldDeliveries ?? []) as Array<{ order_id: string }>) {
        if (row.order_id) actionOrderIds.add(row.order_id);
      }
    }
    this.exceptionCount.set(actionOrderIds.size);
  }

  // =========================================================
  // Loading / filters
  // =========================================================

  reload(page = 1): void {
    void this.svc.load({
      receivedThisMonth:
        this.receivedThisMonth(),
      page,
      status: this.statusFilter(),
      objectId: this.selectedObjectId(),
      search: this.search(),
      exceptionsOnly: this.exceptionsOnly(),
      workQueue: this.workQueue(),
    });

    void this.loadCounts();
  }

  onStatusChange(status: OrderStatus | ''): void {
    this.receivedThisMonth.set(false);
    this.workQueue.set(false);
    this.exceptionsOnly.set(false);

    this.statusFilter.set(
      this.statusFilter() === status
        ? ''
        : status
    );

    this.reload(1);
  }

  showWorkQueue(): void {
    this.receivedThisMonth.set(false);
    this.workQueue.set(true); this.statusFilter.set(''); this.exceptionsOnly.set(false); this.reload(1);
  }

  showReceivedThisMonth(): void {
    this.workQueue.set(false);
    this.exceptionsOnly.set(false);
    this.receivedThisMonth.set(true);
    this.statusFilter.set('');

    this.reload(1);
  }

  showAll(): void {
    this.receivedThisMonth.set(false);
    this.workQueue.set(false);
    this.statusFilter.set('');
    this.exceptionsOnly.set(false);
    this.reload(1);
  }

  showExceptions(): void {
    this.receivedThisMonth.set(false);
    this.workQueue.set(false);
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
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(async () => {
      if (await this.resolveDocumentSearch(value)) return;
      this.reload(1);
    }, 250);
  }

  previous(): void {
    void this.svc.previous({
      receivedThisMonth:
        this.receivedThisMonth(),
      status: this.statusFilter(),
      objectId: this.selectedObjectId(),
      search: this.search(),
      exceptionsOnly: this.exceptionsOnly(),
      workQueue: this.workQueue(),
    });
  }

  next(): void {
    void this.svc.next({
      receivedThisMonth:
        this.receivedThisMonth(),
      status: this.statusFilter(),
      objectId: this.selectedObjectId(),
      search: this.search(),
      exceptionsOnly: this.exceptionsOnly(),
      workQueue: this.workQueue(),
    });
  }

  private async loadOperationalRefs(orderIds: string[]): Promise<void> {
    if (!orderIds.length) { this.operational.set({}); return; }
    const { data: receipts } = await supabase.from('deliveries').select('id, order_id, delivery_number').in('order_id', orderIds);
    const deliveryIds = (receipts ?? []).map((r: any) => r.id as string);
    const [{ data: held }, { data: claims }, { data: rejected }] = await Promise.all([
      deliveryIds.length ? supabase.from('held_stock_overview').select('delivery_id, remaining_qty').in('delivery_id', deliveryIds) : Promise.resolve({ data: [] } as any),
      supabase.from('supplier_claims').select('order_id, status').in('order_id', orderIds),
      deliveryIds.length
        ? supabase
          .from('delivery_items')
          .select(`
        delivery_id,
        short_qty,
        over_qty,
        held_qty,
        quality_rejected_qty,
        rejection_reason_code,
        resolution_status,
        created_at
      `)
          .in('delivery_id', deliveryIds)
        : Promise.resolve({ data: [] } as any),
    ]);
    const next: Record<
      string,
      {
        grn: string | null;

        held: number;
        openClaims: number;

        damaged: number;
        wrongItem: number;
        otherQuality: number;

        openShort: number;
        openOver: number;
        openHeld: number;
        oldestOpenAt: string | null;
      }
    > = {};
    const owners = new Map<string, string>();
    orderIds.forEach((id) => {
      next[id] = {
        grn: null,

        held: 0,
        openClaims: 0,

        damaged: 0,
        wrongItem: 0,
        otherQuality: 0,

        openShort: 0,
        openOver: 0,
        openHeld: 0,
        oldestOpenAt: null,
      };
    });
    for (const r of (receipts ?? []) as any[]) { if (next[r.order_id]) next[r.order_id].grn = r.delivery_number; owners.set(r.id, r.order_id); }
    for (const r of (held ?? []) as any[]) { const id = owners.get(r.delivery_id); if (id && next[id]) next[id].held += Number(r.remaining_qty ?? 0); }
    for (const r of (claims ?? []) as any[]) if (next[r.order_id] && ['AWAITING_SUPPLIER', 'REPLACEMENT_PROMISED'].includes(r.status)) next[r.order_id].openClaims++;
    for (const row of (rejected ?? []) as any[]) {
      const orderId =
        owners.get(row.delivery_id);

      if (
        !orderId ||
        !next[orderId]
      ) {
        continue;
      }

      const target =
        next[orderId];

      /*
       * Audit information.
       * Keep this for All / Received views.
       */
      const qualityQty =
        Number(
          row.quality_rejected_qty ?? 0
        );

      if (qualityQty > 0) {
        if (
          row.rejection_reason_code ===
          'DAMAGED'
        ) {
          target.damaged += qualityQty;
        } else if (
          row.rejection_reason_code ===
          'WRONG_ITEM'
        ) {
          target.wrongItem += qualityQty;
        } else {
          target.otherQuality +=
            qualityQty;
        }
      }

      /*
       * Work queue information.
       * Count only rows which still require action.
       */
      if (
        row.resolution_status !== 'open'
      ) {
        continue;
      }

      target.openShort +=
        Number(
          row.short_qty ?? 0
        );

      target.openOver +=
        Number(
          row.over_qty ?? 0
        );

      target.openHeld +=
        Number(
          row.held_qty ?? 0
        );

      const openedAt =
        row.created_at as string | null;

      if (
        openedAt &&
        (
          !target.oldestOpenAt ||
          new Date(openedAt).getTime() <
          new Date(
            target.oldestOpenAt
          ).getTime()
        )
      ) {
        target.oldestOpenAt =
          openedAt;
      }
    }
    this.operational.set(next);
  }
  grn(o: Order): string | null { return this.operational()[o.id]?.grn ?? null; }
  heldUnits(o: Order): number { return this.operational()[o.id]?.held ?? 0; }
  openClaims(o: Order): number { return this.operational()[o.id]?.openClaims ?? 0; }
  damagedUnits(o: Order): number { return this.operational()[o.id]?.damaged ?? 0; }
  wrongItemUnits(o: Order): number { return this.operational()[o.id]?.wrongItem ?? 0; }
  otherQualityUnits(o: Order): number { return this.operational()[o.id]?.otherQuality ?? 0; }
  openShortUnits(
    order: Order
  ): number {
    return (
      this.operational()[order.id]
        ?.openShort ?? 0
    );
  }

  openOverUnits(
    order: Order
  ): number {
    return (
      this.operational()[order.id]
        ?.openOver ?? 0
    );
  }

  openHeldUnits(
    order: Order
  ): number {
    return (
      this.operational()[order.id]
        ?.openHeld ?? 0
    );
  }

  queueLabel(
    order: Order
  ): string {
    if (
      order.status === 'PENDING'
    ) {
      return 'Needs review';
    }

    if (
      order.status === 'APPROVED'
    ) {
      return 'Awaiting receipt';
    }

    const parts: string[] = [];

    const short =
      this.openShortUnits(order);

    const over =
      this.openOverUnits(order);

    const held =
      Math.max(
        this.openHeldUnits(order),
        this.heldUnits(order)
      );

    const claims =
      this.openClaims(order);

    if (short > 0) {
      parts.push(
        `Short ${short}`
      );
    }

    if (over > 0) {
      parts.push(
        `Over ${over}`
      );
    }

    if (held > 0) {
      parts.push(
        `HELD ${held}`
      );
    }

    if (claims > 0) {
      parts.push(
        `${claims} open claim${claims === 1 ? '' : 's'}`
      );
    }

    return parts.length
      ? parts.join(' · ')
      : 'Needs resolution';
  }

  queueAge(
    order: Order
  ): string {
    const operational =
      this.operational()[order.id];

    const since =
      order.status === 'DELIVERED'
        ? operational?.oldestOpenAt
        : order.approved_at ??
        order.created_at;

    if (!since) {
      return '';
    }

    const milliseconds =
      Date.now() -
      new Date(since).getTime();

    const minutes =
      Math.max(
        1,
        Math.floor(
          milliseconds / 60_000
        )
      );

    if (minutes < 60) {
      return `${minutes}m`;
    }

    const hours =
      Math.floor(
        minutes / 60
      );

    if (hours < 24) {
      return `${hours}h`;
    }

    const days =
      Math.floor(
        hours / 24
      );

    return `${days}d`;
  }

  queueTone(
    order: Order
  ): string {
    const operational =
      this.operational()[order.id];

    const since =
      operational?.oldestOpenAt;

    if (
      order.status !== 'DELIVERED' ||
      !since
    ) {
      return 'bg-blue-50 text-blue-700';
    }

    const hours =
      (
        Date.now() -
        new Date(since).getTime()
      ) /
      3_600_000;

    if (hours >= 72) {
      return 'bg-red-50 text-red-700';
    }

    if (hours >= 24) {
      return 'bg-orange-50 text-orange-700';
    }

    return 'bg-amber-50 text-amber-700';
  }
  isPurchaseOrder(o: Order): boolean { return o.status === 'APPROVED' || o.status === 'DELIVERED'; }
  private async resolveDocumentSearch(raw: string): Promise<boolean> {
    const q = raw.trim(); if (!q) return false;
    if (/^GRN-/i.test(q)) { const { data } = await supabase.from('deliveries').select('order_id').ilike('delivery_number', q).maybeSingle(); if (data?.order_id) { await this.focusOrder(data.order_id); return true; } }
    if (/^CLM-/i.test(q)) { const { data } = await supabase.from('supplier_claims').select('order_id').ilike('claim_number', q).maybeSingle(); if (data?.order_id) { await this.focusOrder(data.order_id); return true; } }
    return false;
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

  /** Hint under a pipeline card, depending on role. */
  cardHint(status: OrderStatus): string {
    if (status === 'PENDING') {
      return this.auth.isAdmin() ? 'need your review' : 'waiting for procurement';
    }
    return this.meta[status].hint.toLowerCase();
  }

  /** Supplier line: a request gets its supplier(s) on review. */
  supplierLabel(order: Order): string {
    const name = order.supplier?.name || order.supplier_snapshot?.name;
    if (name) return name;
    return order.status === 'PENDING' ? 'Supplier assigned on review' : 'No supplier';
  }

  nextHint(order: Order): string {
    if (order.status === 'PENDING') {
      return this.auth.isAdmin()
        ? 'Needs review'
        : 'Waiting for procurement';
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

    const damaged = this.damagedUnits(order);
    const wrongItem = this.wrongItemUnits(order);
    const otherQuality = this.otherQualityUnits(order);
    const held = this.heldUnits(order);
    const claims = this.openClaims(order);
    if (damaged > 0) parts.push(`${damaged} damaged`);
    if (wrongItem > 0) parts.push(`${wrongItem} wrong item${wrongItem === 1 ? '' : 's'}`);
    if (otherQuality > 0) parts.push(`${otherQuality} quality issue${otherQuality === 1 ? '' : 's'}`);
    if (held > 0) parts.push(`${held} HELD`);
    if (claims > 0) parts.push(`${claims} claim${claims === 1 ? '' : 's'} open`);
    if (!parts.length && variance.open > 0) parts.push(`${variance.open} to resolve`);
    return parts.length ? parts.join(' · ') : 'resolved';
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


  async reject(
    order: Order
  ): Promise<void> {
    const ok =
      await this.confirm.ask({
        title:
          'Reject this request?',

        message:
          `${order.order_number} for ` +
          `${order.object?.name ?? 'this location'} ` +
          `will be marked REJECTED. ` +
          `This can't be undone.`,

        confirmLabel:
          'Reject request',

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

  /** Refresh list and Needs resolution count after a receipt decision. */
  onResolved(): void {
    this.reload(this.svc.page());
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
