import {
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { LocationPickerComponent } from '../../shared/ui/location-picker.component';
import { OrdersService } from './orders.service';
import { BusinessObject } from '../objects/object.model';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import {
  Urgency,
  runway,
  runwayLabel,
  WINDOW_DAYS,
  CRITICAL_DAYS,
  WARNING_DAYS,
  TARGET_DAYS,
  MIN_SALES,
} from '../../core/stock/runway';

interface Orderable {
  id: string;
  name: string;
  sku: string;
  category: string | null;
  onHand: number;
  incoming: number;
  sold30: number;
  dailyRate: number;
  daysLeft: number | null;
  urgency: Urgency;
  lowData: boolean;
  suggest: number;
}

interface OrderSupplierOption {
  id: string;
  name: string;
  order_email: string | null;
}

interface BasketLine extends Orderable {
  qty: number;
  after: number;
  daysAfter: number | null;
}

interface Placed {
  orderId: string;
  orderNumber: string;
  objectName: string;
  supplierName: string;
  units: number;
  lines: BasketLine[];
}

const OVERSTOCK_DAYS = TARGET_DAYS * 2;

const RANK: Record<Urgency, number> = {
  out: 0,
  critical: 1,
  warning: 2,
  healthy: 3,
  idle: 4,
};

@Component({
  selector: 'app-order-create',
  standalone: true,
  imports: [
    DecimalPipe,
    RouterLink,
    EmptyStateComponent,
    LocationPickerComponent,
  ],
  templateUrl: './order-create.component.html',
  styles: [`
    @keyframes rowIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }

    .row-in {
      animation: rowIn .45s cubic-bezier(.2,.8,.2,1) backwards;
    }

    @keyframes pop {
      0% { transform: scale(.6); opacity: 0; }
      60% { transform: scale(1.08); }
      100% { transform: scale(1); opacity: 1; }
    }

    .pop {
      animation: pop .35s cubic-bezier(.2,.8,.2,1) backwards;
    }

    @keyframes bump {
      0% { transform: scale(1); }
      40% { transform: scale(1.25); }
      100% { transform: scale(1); }
    }

    .bump {
      animation: bump .25s ease-out;
    }

    .check path {
      stroke-dasharray: 24;
      stroke-dashoffset: 24;
      animation: dash .45s ease-out .2s forwards;
    }

    @keyframes dash {
      to { stroke-dashoffset: 0; }
    }

    @keyframes ping {
      0% { transform: scale(1); opacity: .55; }
      100% { transform: scale(2.4); opacity: 0; }
    }

    .step-ping {
      animation: ping 1.6s cubic-bezier(0,0,.2,1) infinite;
    }

    input[type=number]::-webkit-outer-spin-button,
    input[type=number]::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    input[type=number] {
      -moz-appearance: textfield;
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
      100% { transform: translateX(100%); }
    }

    @media (prefers-reduced-motion: reduce) {
      .row-in,
      .pop,
      .bump,
      .step-ping,
      .sk::after {
        animation: none;
      }

      .check path {
        animation: none;
        stroke-dashoffset: 0;
      }
    }
  `],
})
export class OrderCreateComponent implements OnInit {
  private auth = inject(AuthService);
  private orders = inject(OrdersService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly targetDays = TARGET_DAYS;

  readonly loading = signal(true);
  readonly productsLoading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly objects = signal<BusinessObject[]>([]);
  readonly selectedObjectId = signal<string | null>(null);
  readonly suppliers = signal<OrderSupplierOption[]>([]);
  readonly selectedSupplierId = signal<string | null>(null);
  readonly products = signal<Orderable[]>([]);
  readonly search = signal('');
  readonly onlyNeeded = signal(false);
  readonly comment = signal('');

  readonly cart = signal<Record<string, number>>({});
  readonly bumpId = signal<string | null>(null);
  readonly placed = signal<Placed | null>(null);

  readonly isAdmin = computed(() => this.auth.isAdmin());

  readonly objectName = computed(() =>
    this.objects().find(
      (object) => object.id === this.selectedObjectId()
    )?.name ?? 'Your location'
  );

  readonly selectedSupplier = computed(() =>
    this.suppliers().find(
      (supplier) => supplier.id === this.selectedSupplierId()
    ) ?? null
  );

  readonly supplierName = computed(() =>
    this.selectedSupplier()?.name ?? 'No supplier selected'
  );

  readonly shortcut =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform)
      ? '⌘ Enter'
      : 'Ctrl Enter';

  readonly needing = computed(() =>
    this.products().filter(
      (product) => product.onHand <= 0 || product.suggest > 0
    )
  );

  readonly suggestedProducts = computed(() =>
    this.products().filter((product) => product.suggest > 0)
  );

  readonly suggestedUnits = computed(() =>
    this.suggestedProducts().reduce(
      (sum, product) => sum + product.suggest,
      0
    )
  );

  readonly filtered = computed(() => {
    const query = this.search().trim().toLowerCase();

    return this.products()
      .filter(
        (product) =>
          !this.onlyNeeded() ||
          product.onHand <= 0 ||
          product.suggest > 0
      )
      .filter(
        (product) =>
          !query ||
          product.name.toLowerCase().includes(query) ||
          product.sku.toLowerCase().includes(query) ||
          (product.category ?? '').toLowerCase().includes(query)
      );
  });

  readonly lines = computed<BasketLine[]>(() => {
    const cart = this.cart();

    return this.products()
      .filter((product) => (cart[product.id] ?? 0) > 0)
      .map((product) => {
        const qty = cart[product.id];
        const after =
          Math.max(0, product.onHand) +
          product.incoming +
          qty;

        return {
          ...product,
          qty,
          after,
          daysAfter:
            product.dailyRate > 0
              ? after / product.dailyRate
              : null,
        };
      });
  });

  readonly totalUnits = computed(() =>
    this.lines().reduce((sum, line) => sum + line.qty, 0)
  );

  async ngOnInit(): Promise<void> {
    const { data: suppliers, error: suppliersError } = await supabase
      .from('suppliers')
      .select('id, name, order_email')
      .eq('active', true)
      .order('name');

    if (suppliersError) {
      this.error.set(suppliersError.message);
    } else {
      this.suppliers.set(
        (suppliers ?? []) as OrderSupplierOption[]
      );
      this.selectedSupplierId.set(null);
    }

    const queryParams = this.route.snapshot.queryParamMap;
    const fromObject = queryParams.get('object');
    const fromProduct = queryParams.get('product');
    const fromQty = Number(queryParams.get('qty')) || 0;

    if (this.isAdmin()) {
      const { data } = await supabase
        .from('objects')
        .select('*')
        .eq('active', true)
        .order('name');

      this.objects.set((data ?? []) as BusinessObject[]);

      const chosen =
        this.objects().find((object) => object.id === fromObject)?.id ??
        this.objects()[0]?.id ??
        null;

      this.selectedObjectId.set(chosen);
    } else {
      const ownObjectId = this.auth.profile()?.object_id ?? null;
      this.selectedObjectId.set(ownObjectId);

      if (ownObjectId) {
        const { data } = await supabase
          .from('objects')
          .select('*')
          .eq('id', ownObjectId)
          .maybeSingle();

        if (data) {
          this.objects.set([data as BusinessObject]);
        }
      }
    }

    const objectId = this.selectedObjectId();

    if (objectId) {
      await this.loadProducts(objectId);
    }

    if (fromProduct) {
      const product = this.products().find(
        (item) => item.id === fromProduct
      );

      if (product) {
        this.cart.set({
          [product.id]:
            fromQty > 0
              ? fromQty
              : Math.max(1, product.suggest),
        });
      }
    }

    this.loading.set(false);
  }

  async onObjectChange(objectId: string): Promise<void> {
    if (!objectId) return;

    this.selectedObjectId.set(objectId);
    this.cart.set({});
    this.search.set('');
    this.onlyNeeded.set(false);
    this.error.set(null);

    void this.router.navigate([], {
      queryParams: { object: objectId },
      replaceUrl: true,
    });

    await this.loadProducts(objectId);
  }

  private async loadProducts(objectId: string): Promise<void> {
    this.productsLoading.set(true);
    this.error.set(null);

    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (WINDOW_DAYS - 1));

    const [assigned, inventory, sales, openOrders] = await Promise.all([
      supabase
        .from('object_products')
        .select(`
          product:products (
            id,
            sku,
            name,
            category,
            active
          )
        `)
        .eq('object_id', objectId),

      supabase
        .from('inventory')
        .select('product_id, quantity')
        .eq('object_id', objectId),

      supabase
        .from('stock_movements')
        .select('product_id, quantity')
        .eq('object_id', objectId)
        .eq('event', 'SALE')
        .gte('created_at', since.toISOString())
        .limit(5000),

      supabase
        .from('orders')
        .select(`
          status,
          order_items (
            product_id,
            quantity
          )
        `)
        .eq('object_id', objectId)
        .in('status', ['PENDING', 'APPROVED']),
    ]);

    if (assigned.error) {
      this.error.set(assigned.error.message);
      this.products.set([]);
      this.productsLoading.set(false);
      return;
    }

    if (inventory.error) {
      this.error.set(inventory.error.message);
      this.products.set([]);
      this.productsLoading.set(false);
      return;
    }

    if (sales.error) {
      this.error.set(sales.error.message);
      this.products.set([]);
      this.productsLoading.set(false);
      return;
    }

    if (openOrders.error) {
      this.error.set(openOrders.error.message);
      this.products.set([]);
      this.productsLoading.set(false);
      return;
    }

    const onHand = new Map<string, number>();

    for (const row of (inventory.data ?? []) as {
      product_id: string;
      quantity: number;
    }[]) {
      onHand.set(row.product_id, Number(row.quantity) || 0);
    }

    const sold = new Map<string, number>();

    for (const movement of (sales.data ?? []) as {
      product_id: string;
      quantity: number;
    }[]) {
      sold.set(
        movement.product_id,
        (sold.get(movement.product_id) ?? 0) +
          Math.abs(Number(movement.quantity) || 0)
      );
    }

    const incoming = new Map<string, number>();

    for (const order of (openOrders.data ?? []) as any[]) {
      for (const item of (order.order_items ?? []) as {
        product_id: string;
        quantity: number;
      }[]) {
        incoming.set(
          item.product_id,
          (incoming.get(item.product_id) ?? 0) +
            (Number(item.quantity) || 0)
        );
      }
    }

    const list: Orderable[] = ((assigned.data ?? []) as any[])
      .map((row) => row.product)
      .filter((product: any) => product && product.active)
      .map((product: any) => {
        const have = onHand.get(product.id) ?? 0;
        const inc = incoming.get(product.id) ?? 0;
        const sold30 = sold.get(product.id) ?? 0;
        const result = runway(have, sold30, WINDOW_DAYS, inc);

        return {
          id: product.id,
          name: product.name,
          sku: product.sku,
          category: product.category ?? null,
          onHand: have,
          incoming: inc,
          sold30,
          dailyRate: result.dailyRate,
          daysLeft: result.daysLeft,
          urgency: result.urgency,
          lowData: result.lowData,
          suggest: result.suggest,
        };
      })
      .sort(
        (a: Orderable, b: Orderable) =>
          Number(b.suggest > 0) - Number(a.suggest > 0) ||
          RANK[a.urgency] - RANK[b.urgency] ||
          (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) ||
          a.name.localeCompare(b.name)
      );

    this.products.set(list);
    this.productsLoading.set(false);
  }

  tone(urgency: Urgency): {
    hex: string;
    text: string;
    chip: string;
    label: string;
  } {
    return {
      out: {
        hex: '#ef4444',
        text: 'text-red-600',
        chip: 'bg-red-50 text-red-700 ring-red-200',
        label: 'Out of stock',
      },
      critical: {
        hex: '#ef4444',
        text: 'text-red-600',
        chip: 'bg-red-50 text-red-700 ring-red-200',
        label: 'Reorder now',
      },
      warning: {
        hex: '#f59e0b',
        text: 'text-amber-600',
        chip: 'bg-amber-50 text-amber-700 ring-amber-200',
        label: 'Reorder soon',
      },
      healthy: {
        hex: '#22c55e',
        text: 'text-slate-900',
        chip: 'bg-green-50 text-green-700 ring-green-200',
        label: 'Healthy',
      },
      idle: {
        hex: '#cbd5e1',
        text: 'text-slate-900',
        chip: 'bg-slate-100 text-slate-600 ring-slate-200',
        label: 'No recent sales',
      },
    }[urgency];
  }

  daysText(
    onHandValue: number,
    days: number | null,
    sold = MIN_SALES
  ): string {
    return runwayLabel(
      onHandValue,
      days,
      sold > 0 && sold < MIN_SALES
    );
  }

  afterTone(days: number | null): string {
    if (days === null) {
      return 'bg-slate-100 text-slate-600 ring-slate-200';
    }

    if (days <= CRITICAL_DAYS) {
      return 'bg-red-50 text-red-700 ring-red-200';
    }

    if (days <= WARNING_DAYS) {
      return 'bg-amber-50 text-amber-700 ring-amber-200';
    }

    if (days > OVERSTOCK_DAYS) {
      return 'bg-amber-50 text-amber-700 ring-amber-200';
    }

    return 'bg-green-50 text-green-700 ring-green-200';
  }

  isOverstock(days: number | null): boolean {
    return days !== null && days > OVERSTOCK_DAYS;
  }

  coveredByIncoming(product: Orderable): boolean {
    return (
      product.incoming > 0 &&
      product.suggest === 0 &&
      (
        product.urgency === 'out' ||
        product.urgency === 'critical' ||
        product.urgency === 'warning'
      )
    );
  }

  targetQty(line: BasketLine): number {
    return Math.max(
      0,
      Math.ceil(
        line.dailyRate * TARGET_DAYS -
          Math.max(0, line.onHand) -
          line.incoming
      )
    );
  }

  delay(index: number): number {
    return Math.min(index, 12) * 30;
  }

  qty(id: string): number {
    return this.cart()[id] ?? 0;
  }

  private setQty(id: string, qty: number): void {
    const next = Math.max(
      0,
      Math.min(9999, Math.floor(qty) || 0)
    );

    this.cart.update((cart) => ({
      ...cart,
      [id]: next,
    }));

    this.error.set(null);
    this.bumpId.set(null);

    setTimeout(() => {
      this.bumpId.set(id);
    });
  }

  add(product: Orderable, delta = 1): void {
    this.setQty(product.id, this.qty(product.id) + delta);
  }

  addSuggested(product: Orderable): void {
    if (product.suggest > 0) {
      this.setQty(product.id, product.suggest);
    }
  }

  addAllSuggested(): void {
    const next = { ...this.cart() };

    for (const product of this.suggestedProducts()) {
      next[product.id] = Math.max(
        next[product.id] ?? 0,
        product.suggest
      );
    }

    this.cart.set(next);
    this.error.set(null);
  }

  onQtyInput(id: string, value: string): void {
    this.setQty(id, Number(value));
  }

  remove(id: string): void {
    this.cart.update((cart) => ({
      ...cart,
      [id]: 0,
    }));
  }

  clear(): void {
    this.cart.set({});
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === 'Enter' &&
      !this.placed() &&
      !!this.selectedSupplierId() &&
      this.totalUnits() > 0 &&
      !this.saving()
    ) {
      event.preventDefault();
      void this.submit();
    }
  }

  async submit(): Promise<void> {
    const objectId = this.selectedObjectId();
    const supplierId = this.selectedSupplierId();
    const snapshot = this.lines();

    if (!objectId || snapshot.length === 0 || this.saving()) {
      return;
    }

    if (!supplierId) {
      this.error.set('Select a supplier before placing the order.');
      return;
    }

    this.saving.set(true);
    this.error.set(null);

    const result = await this.orders.create(
      objectId,
      supplierId,
      this.comment().trim() || null,
      snapshot.map((line) => ({
        product_id: line.id,
        quantity: line.qty,
      }))
    );

    this.saving.set(false);

    if (result.error || !result.order) {
      this.error.set(
        result.error ?? 'Could not create the order.'
      );
      return;
    }

    this.placed.set({
      orderId: result.order.id,
      orderNumber: result.order.orderNumber,
      objectName: this.objectName(),
      supplierName: this.supplierName(),
      units: snapshot.reduce(
        (sum, line) => sum + line.qty,
        0
      ),
      lines: snapshot,
    });

    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  }

  async newOrder(): Promise<void> {
    this.placed.set(null);
    this.cart.set({});
    this.comment.set('');
    this.search.set('');
    this.onlyNeeded.set(false);
    this.selectedSupplierId.set(null);
    this.error.set(null);

    const objectId = this.selectedObjectId();

    if (objectId) {
      await this.loadProducts(objectId);
    }
  }
}
