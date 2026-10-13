import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators,
} from '@angular/forms';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { InventoryService } from './inventory.service';
import {
  InventoryItem, MovementEvent, MANUAL_EVENTS, Urgency, INSIGHT_DAYS, StockMovement,
} from './inventory.model';
import { BusinessObject } from '../objects/object.model';
import { Product } from '../products/product.model';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { DrawerComponent } from '../../shared/ui/drawer.component';
import { ToastService } from '../../shared/ui/toast.service';
import { StockHistoryDialogComponent } from './stock-history-dialog.component';
import { runwayLabel } from '../../core/stock/runway';

type Filter = 'all' | 'reorder' | 'soon' | 'healthy' | 'idle';
type Sort = 'urgency' | 'days' | 'onhand' | 'sold' | 'name';

const RANK: Record<Urgency, number> = { out: 0, critical: 1, warning: 2, healthy: 3, idle: 4 };

/** A signed correction can be + or -, but never 0. */
function notZero(control: AbstractControl): ValidationErrors | null {
  const v = control.value;
  return v === 0 || v === null || v === '' ? { zero: true } : null;
}

@Component({
  selector: 'app-inventory',
  standalone: true,
  imports: [
    DatePipe,
    DecimalPipe,
    RouterLink,
    ReactiveFormsModule,
    EmptyStateComponent,
    DrawerComponent,
    StockHistoryDialogComponent,
  ],
  templateUrl: './inventory.component.html',
  styles: [`
    @keyframes rowIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .row-in { animation: rowIn .45s cubic-bezier(.2,.8,.2,1) backwards; }

    @keyframes flash { 0%, 40% { background: #eef2ff; } 100% { background: transparent; } }
    .row-flash { animation: flash 2.2s ease-out; }

    /* Sparkline reveals left → right; the line itself stays solid. */
    .spark { animation: reveal 1s cubic-bezier(.2,.8,.2,1) .15s backwards; }
    @keyframes reveal {
      from { clip-path: inset(-4px 100% -4px -4px); }
      to   { clip-path: inset(-4px -4px -4px -4px); }
    }

    .sk { position: relative; overflow: hidden; background: #f1f5f9; border-radius: .5rem; }
    .sk::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.7), transparent);
      animation: shimmer 1.3s infinite; }
    @keyframes shimmer { 100% { transform: translateX(100%); } }

    @media (prefers-reduced-motion: reduce) {
      .row-in, .row-flash, .sk::after, .spark { animation: none; }
    }
  `],
})
export class InventoryComponent implements OnInit {
  readonly svc = inject(InventoryService);
  readonly auth = inject(AuthService);
  private fb = inject(FormBuilder);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);

  readonly days = INSIGHT_DAYS;
  readonly isAdmin = computed(() => this.auth.isAdmin());

  readonly objects = signal<BusinessObject[]>([]);
  readonly selectedObjectId = signal<string | null>(null);
  readonly objectName = computed(() =>
    this.objects().find((o) => o.id === this.selectedObjectId())?.name ?? 'Your store');

  // ---------- list controls ----------
  readonly search = signal('');
  readonly filter = signal<Filter>('all');
  readonly sort = signal<Sort>('urgency');
  readonly flashId = signal<string | null>(null);

  readonly filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'reorder', label: 'Reorder now' },
    { key: 'soon', label: 'Reorder soon' },
    { key: 'healthy', label: 'Healthy' },
    { key: 'idle', label: 'No sales' },
  ];

  readonly sorts: { key: Sort; label: string }[] = [
    { key: 'urgency', label: 'Most urgent' },
    { key: 'days', label: 'Days left' },
    { key: 'onhand', label: 'On hand' },
    { key: 'sold', label: 'Most sold' },
    { key: 'name', label: 'Name' },
  ];

  private matches(i: InventoryItem, f: Filter): boolean {
    switch (f) {
      case 'reorder': return i.urgency === 'out' || i.urgency === 'critical';
      case 'soon': return i.urgency === 'warning';
      case 'healthy': return i.urgency === 'healthy';
      case 'idle': return i.urgency === 'idle';
      default: return true;
    }
  }

  readonly counts = computed(() => {
    const items = this.svc.items();
    const c = {} as Record<Filter, number>;
    for (const f of this.filters) c[f.key] = items.filter((i) => this.matches(i, f.key)).length;
    return c;
  });

  readonly kpis = computed(() => {
    const items = this.svc.items();
    let units = 0;
    let sold = 0;
    let inU = 0;
    let outU = 0;
    for (const i of items) {
      units += i.quantity;
      sold += i.sold30;
      inU += i.in30;
      outU += i.out30;
    }
    return {
      units,
      products: items.length,
      sold,
      inU,
      outU,
      net: inU - outU,
      rate: sold / INSIGHT_DAYS,
      reorder: this.counts()['reorder'],
      soon: this.counts()['soon'],
    };
  });

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const f = this.filter();
    const list = this.svc.items().filter((i) =>
      this.matches(i, f) &&
      (!q ||
        (i.product?.name ?? '').toLowerCase().includes(q) ||
        (i.product?.sku ?? '').toLowerCase().includes(q) ||
        (i.product?.category ?? '').toLowerCase().includes(q)));

    const name = (i: InventoryItem) => i.product?.name ?? '';
    const days = (i: InventoryItem) => (i.quantity <= 0 ? -1 : i.daysLeft ?? Infinity);

    return [...list].sort((a, b) => {
      switch (this.sort()) {
        case 'days': return days(a) - days(b);
        case 'onhand': return b.quantity - a.quantity;
        case 'sold': return b.sold30 - a.sold30;
        case 'name': return name(a).localeCompare(name(b));
        default:
          return RANK[a.urgency] - RANK[b.urgency] || days(a) - days(b) || name(a).localeCompare(name(b));
      }
    });
  });

  // ---------- record-movement drawer ----------
  readonly drawerOpen = signal(false);
  readonly assignableProducts = signal<Product[]>([]);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);
  readonly manualEvents = MANUAL_EVENTS;

  readonly form = this.fb.nonNullable.group({
    product_id: ['', [Validators.required]],
    event: ['SALE' as MovementEvent, [Validators.required]],
    quantity: [1, [Validators.required, Validators.min(1)]],
    note: [''],
  });

  private readonly formValue = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });

  /** Live "25 → 22" preview before anything is written. */
  readonly preview = computed(() => {
    const v = this.formValue() as { product_id?: string; event?: MovementEvent; quantity?: number };
    if (!v.product_id) return null;
    const onHand = this.svc.rows().find((r) => r.product_id === v.product_id)?.quantity ?? 0;
    const delta = this.signedQty(v.event ?? 'SALE', Number(v.quantity) || 0);
    return { onHand, delta, after: onHand + delta };
  });

  // ---------- history drawer ----------
  readonly historyOpen = signal(false);
  readonly historyItem = signal<InventoryItem | null>(null);
  readonly movementSearch = signal('');
  readonly movementEventFilter = signal<MovementEvent | ''>('');
  readonly movementEvents: MovementEvent[] = [
    'DELIVERY', 'SALE', 'STOCK_COUNT', 'ADJUSTMENT', 'TRANSFER', 'RETURN', 'WRITE_OFF',
  ];
  private movementSearchTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------- trend dialog ----------
  readonly chartOpen = signal(false);
  readonly chartProductId = signal<string | null>(null);
  readonly chartProductName = signal('');
  readonly chartSku = signal('');

  constructor() {
    this.form.controls.event.valueChanges.pipe(takeUntilDestroyed()).subscribe((ev) => {
      const qty = this.form.controls.quantity;
      qty.setValidators(ev === 'ADJUSTMENT'
        ? [Validators.required, notZero]
        : [Validators.required, Validators.min(1)]);
      qty.updateValueAndValidity();
    });
  }

  async ngOnInit(): Promise<void> {
    const fromLink = this.route.snapshot.queryParamMap.get('object');

    if (this.isAdmin()) {
      const { data } = await supabase.from('objects').select('*').eq('active', true).order('name');
      this.objects.set((data ?? []) as BusinessObject[]);
      // Never an empty screen: the dashboard link wins, otherwise the first store.
      const chosen = this.objects().find((o) => o.id === fromLink)?.id ?? this.objects()[0]?.id ?? null;
      if (chosen) await this.selectObject(chosen, false);
    } else {
      const own = this.auth.profile()?.object_id ?? null;
      if (own) await this.selectObject(own, false);
    }
  }

  async selectObject(objectId: string, updateUrl = true): Promise<void> {
    if (!objectId) return;
    this.selectedObjectId.set(objectId);
    this.filter.set('all');
    if (updateUrl) {
      this.router.navigate([], { queryParams: { object: objectId }, replaceUrl: true });
    }
    await this.svc.loadInventory(objectId);
  }

  // ---------- presentation helpers ----------
  /**
   * hex   = urgency colour (left accent, runway bar)
   * spark = sparkline colour (indigo for normal stock, red/amber only when it burns)
   */
  tone(u: Urgency): { hex: string; spark: string; text: string; chip: string; label: string } {
    return {
      out:      { hex: '#ef4444', spark: '#ef4444', text: 'text-red-600',   chip: 'bg-red-50 text-red-700 ring-red-200',         label: 'Out of stock' },
      critical: { hex: '#ef4444', spark: '#ef4444', text: 'text-red-600',   chip: 'bg-red-50 text-red-700 ring-red-200',         label: 'Reorder now' },
      warning:  { hex: '#f59e0b', spark: '#f59e0b', text: 'text-amber-600', chip: 'bg-amber-50 text-amber-700 ring-amber-200',   label: 'Reorder soon' },
      healthy:  { hex: '#22c55e', spark: '#4f46e5', text: 'text-slate-900', chip: 'bg-green-50 text-green-700 ring-green-200',   label: 'Healthy' },
      idle:     { hex: '#cbd5e1', spark: '#94a3b8', text: 'text-slate-900', chip: 'bg-slate-100 text-slate-600 ring-slate-200', label: 'No sales' },
    }[u];
  }

  readonly eventMeta: Record<MovementEvent, { label: string; chip: string; dot: string }> = {
    DELIVERY:    { label: 'Delivery',    chip: 'bg-blue-50 text-blue-700',     dot: 'bg-blue-500' },
    SALE:        { label: 'Sale',        chip: 'bg-red-50 text-red-700',       dot: 'bg-red-500' },
    STOCK_COUNT: { label: 'Stock count', chip: 'bg-amber-50 text-amber-700',   dot: 'bg-amber-500' },
    ADJUSTMENT:  { label: 'Adjustment',  chip: 'bg-violet-50 text-violet-700', dot: 'bg-violet-500' },
    TRANSFER:    { label: 'Transfer',    chip: 'bg-sky-50 text-sky-700',       dot: 'bg-sky-500' },
    RETURN:      { label: 'Return',      chip: 'bg-green-50 text-green-700',   dot: 'bg-green-500' },
    WRITE_OFF:   { label: 'Write-off',   chip: 'bg-rose-50 text-rose-700',     dot: 'bg-rose-500' },
  };

  /** Bar fill on a 30-day scale (markers at 7 and 14). */
  runwayPct(i: InventoryItem): number {
    if (i.quantity <= 0) return 0;
    if (i.daysLeft === null) return 100;
    return Math.max(3, Math.min(100, (i.daysLeft / INSIGHT_DAYS) * 100));
  }

  runwayText(i: InventoryItem): string {
    const l = runwayLabel(i.quantity, i.daysLeft, i.lowData);
    return /\d/.test(l) ? `${l} left` : l;
  }

  /** "0.3/day", or the raw count when there are too few sales to trust a rate. */
  rateText(i: InventoryItem): string {
    if (i.sold30 === 0) return '';
    if (i.lowData) return `only ${i.sold30} sold / ${INSIGHT_DAYS}d`;
    return `${i.dailyRate.toFixed(1)}/day`;
  }

  signed(n: number): string {
    return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
  }

  /** "delivery:742aca49-c6a8-…" → "Delivery #742aca49" */
  refLabel(ref: string): string {
    const [kind, id] = ref.split(':');
    if (!id) return ref;
    return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} #${id.slice(0, 8)}`;
  }

  /** Hide notes that only repeat the event name ("Delivery" on a delivery). */
  showNote(m: StockMovement): boolean {
    return !!m.note && m.note.trim().toLowerCase() !== this.eventMeta[m.event].label.toLowerCase();
  }

  dayKey(iso: string): string {
    return new Date(iso).toDateString();
  }

  dayLabel(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  ago(iso: string): string {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  /** Stagger rows in, capped so long lists don't wait. */
  delay(i: number): number {
    return Math.min(i, 12) * 35;
  }

  eventLabel(ev: MovementEvent): string {
    return {
      SALE: 'Sale — sold, stock out',
      ADJUSTMENT: 'Adjustment — signed correction',
      RETURN: 'Return — back into stock',
      WRITE_OFF: 'Write-off — damage / loss',
      DELIVERY: 'Delivery',
      STOCK_COUNT: 'Stock count',
      TRANSFER: 'Transfer',
    }[ev];
  }

  private signedQty(event: MovementEvent, qty: number): number {
    if (event === 'RETURN') return Math.abs(qty);
    if (event === 'SALE' || event === 'WRITE_OFF') return -Math.abs(qty);
    return qty;
  }

  // ---------- record movement ----------
  async openRecord(productId = ''): Promise<void> {
    const objectId = this.selectedObjectId();
    if (!objectId) return;
    this.formError.set(null);
    this.form.reset({ product_id: productId, event: 'SALE', quantity: 1, note: '' });

    const { data } = await supabase
      .from('object_products')
      .select('product:products ( id, sku, name, category, active, created_at )')
      .eq('object_id', objectId);

    const prods = (data ?? []).map((r: any) => r.product).filter((p: Product) => p && p.active);
    this.assignableProducts.set(prods as Product[]);
    this.drawerOpen.set(true);
  }

  closeDrawer(): void {
    this.drawerOpen.set(false);
  }

  async save(): Promise<void> {
    const objectId = this.selectedObjectId();
    const profile = this.auth.profile();
    if (!objectId || !profile) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const v = this.form.getRawValue();
    const signed = this.signedQty(v.event, v.quantity);
    if (signed === 0) {
      this.formError.set('Quantity cannot be zero.');
      return;
    }

    if (v.event === 'WRITE_OFF' || v.event === 'SALE') {
      const onHand = this.svc.rows().find((r) => r.product_id === v.product_id)?.quantity ?? 0;
      if (Math.abs(v.quantity) > onHand) {
        const noun = v.event === 'SALE' ? 'sale' : 'write-off';
        this.formError.set(`Only ${onHand} on hand — reduce the ${noun} quantity.`);
        return;
      }
    }

    this.saving.set(true);
    this.formError.set(null);
    const err = await this.svc.recordMovement(
      objectId, v.product_id, v.event, signed, profile.id, v.note.trim() || null);
    this.saving.set(false);

    if (err) {
      this.formError.set(err);
      return;
    }

    this.drawerOpen.set(false);
    const name = this.svc.items().find((i) => i.product_id === v.product_id)?.product?.name ?? 'Product';
    this.toast.success(`${this.eventMeta[v.event].label} recorded · ${name} ${this.signed(signed)}`);
    this.flashId.set(v.product_id);
    setTimeout(() => this.flashId.set(null), 2300);
  }

  // ---------- trend dialog ----------
  openChart(i: InventoryItem): void {
    this.chartProductId.set(i.product_id);
    this.chartProductName.set(i.product?.name ?? 'Product');
    this.chartSku.set(i.product?.sku ?? '');
    this.chartOpen.set(true);
  }

  closeChart(): void {
    this.chartOpen.set(false);
    this.chartProductId.set(null);
  }

  // ---------- history drawer ----------
  async openHistory(i: InventoryItem): Promise<void> {
    const objectId = this.selectedObjectId();
    if (!objectId) return;
    this.historyItem.set(i);
    this.movementSearch.set('');
    this.movementEventFilter.set('');
    this.historyOpen.set(true);
    await Promise.all([
      this.svc.loadMovements(objectId, i.product_id, { page: 1 }),
      this.svc.loadBalances(objectId, i.product_id),
    ]);
  }

  closeHistory(): void {
    this.historyOpen.set(false);
  }

  private historyParams() {
    return { event: this.movementEventFilter(), search: this.movementSearch() };
  }

  reloadMovements(page = 1): void {
    const objectId = this.selectedObjectId();
    const productId = this.historyItem()?.product_id;
    if (!objectId || !productId) return;
    void this.svc.loadMovements(objectId, productId, { page, ...this.historyParams() });
  }

  onMovementEventChange(event: MovementEvent | ''): void {
    this.movementEventFilter.set(event);
    this.reloadMovements(1);
  }

  onMovementSearch(value: string): void {
    this.movementSearch.set(value);
    if (this.movementSearchTimer) clearTimeout(this.movementSearchTimer);
    this.movementSearchTimer = setTimeout(() => this.reloadMovements(1), 250);
  }

  previousMovements(): void {
    const objectId = this.selectedObjectId();
    const productId = this.historyItem()?.product_id;
    if (objectId && productId) void this.svc.previousMovements(objectId, productId, this.historyParams());
  }

  nextMovements(): void {
    const objectId = this.selectedObjectId();
    const productId = this.historyItem()?.product_id;
    if (objectId && productId) void this.svc.nextMovements(objectId, productId, this.historyParams());
  }
}
