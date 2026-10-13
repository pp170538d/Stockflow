import { Component, HostListener, computed, inject, signal, OnInit } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { OrdersService } from './orders.service';
import { BusinessObject } from '../objects/object.model';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import {
  Urgency, runway, runwayLabel, WINDOW_DAYS, CRITICAL_DAYS, WARNING_DAYS, TARGET_DAYS, MIN_SALES,
} from '../../core/stock/runway';


/** One orderable product with everything needed to decide how much to order. */
interface Orderable {
  id: string;
  name: string;
  sku: string;
  category: string | null;
  onHand: number;
  incoming: number;      // already on PENDING / APPROVED orders
  sold30: number;
  dailyRate: number;
  daysLeft: number | null;
  urgency: Urgency;
  lowData: boolean;
  suggest: number;       // units to reach TARGET_DAYS (after incoming)
}

interface BasketLine extends Orderable {
  qty: number;
  after: number;
  daysAfter: number | null;
}

interface Placed {
  objectName: string;
  units: number;
  lines: BasketLine[];
}

/** Thresholds come from core/stock/runway.ts — one truth everywhere. */
/** Above this, the basket warns about over-ordering. */
const OVERSTOCK_DAYS = TARGET_DAYS * 2;
const RANK: Record<Urgency, number> = { out: 0, critical: 1, warning: 2, healthy: 3, idle: 4 };

@Component({
  selector: 'app-order-create',
  standalone: true,
  imports: [DecimalPipe, RouterLink, EmptyStateComponent],
  templateUrl: './order-create.component.html',
  styles: [`
    @keyframes rowIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .row-in { animation: rowIn .45s cubic-bezier(.2,.8,.2,1) backwards; }

    @keyframes pop { 0% { transform: scale(.6); opacity: 0; } 60% { transform: scale(1.08); } 100% { transform: scale(1); opacity: 1; } }
    .pop { animation: pop .35s cubic-bezier(.2,.8,.2,1) backwards; }

    @keyframes bump { 0% { transform: scale(1); } 40% { transform: scale(1.25); } 100% { transform: scale(1); } }
    .bump { animation: bump .25s ease-out; }

    .check path { stroke-dasharray: 24; stroke-dashoffset: 24; animation: dash .45s ease-out .2s forwards; }
    @keyframes dash { to { stroke-dashoffset: 0; } }

    @keyframes ping { 0% { transform: scale(1); opacity: .55; } 100% { transform: scale(2.4); opacity: 0; } }
    .step-ping { animation: ping 1.6s cubic-bezier(0,0,.2,1) infinite; }

    input[type=number]::-webkit-outer-spin-button,
    input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    input[type=number] { -moz-appearance: textfield; }

    .sk { position: relative; overflow: hidden; background: #f1f5f9; border-radius: .5rem; }
    .sk::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.7), transparent);
      animation: shimmer 1.3s infinite; }
    @keyframes shimmer { 100% { transform: translateX(100%); } }

    @media (prefers-reduced-motion: reduce) {
      .row-in, .pop, .bump, .step-ping, .sk::after { animation: none; }
      .check path { animation: none; stroke-dashoffset: 0; }
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
  readonly products = signal<Orderable[]>([]);
  readonly search = signal('');
  readonly onlyNeeded = signal(false);
  readonly comment = signal('');

  /** product_id → qty */
  readonly cart = signal<Record<string, number>>({});
  readonly bumpId = signal<string | null>(null);
  readonly placed = signal<Placed | null>(null);

  readonly isAdmin = computed(() => this.auth.isAdmin());

  readonly objectName = computed(() =>
    this.objects().find((o) => o.id === this.selectedObjectId())?.name ?? 'Your store');

  readonly shortcut =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ Enter' : 'Ctrl Enter';

  // ---------- lists ----------
  readonly needing = computed(() => this.products().filter((p) => p.suggest > 0));
  readonly suggestedUnits = computed(() => this.needing().reduce((s, p) => s + p.suggest, 0));

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.products()
      .filter((p) => !this.onlyNeeded() || p.suggest > 0)
      .filter((p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.category ?? '').toLowerCase().includes(q));
  });

  readonly lines = computed<BasketLine[]>(() => {
    const c = this.cart();
    return this.products()
      .filter((p) => (c[p.id] ?? 0) > 0)
      .map((p) => {
        const qty = c[p.id];
        const after = Math.max(0, p.onHand) + p.incoming + qty;
        return { ...p, qty, after, daysAfter: p.dailyRate > 0 ? after / p.dailyRate : null };
      });
  });

  readonly totalUnits = computed(() => this.lines().reduce((s, l) => s + l.qty, 0));

  // ---------- lifecycle ----------
  async ngOnInit(): Promise<void> {
    const qp = this.route.snapshot.queryParamMap;
    const fromObject = qp.get('object');
    const fromProduct = qp.get('product');
    const fromQty = Number(qp.get('qty')) || 0;

    if (this.isAdmin()) {
      const { data } = await supabase.from('objects').select('*').eq('active', true).order('name');
      this.objects.set((data ?? []) as BusinessObject[]);
      const chosen = this.objects().find((o) => o.id === fromObject)?.id ?? this.objects()[0]?.id ?? null;
      this.selectedObjectId.set(chosen);
    } else {
      this.selectedObjectId.set(this.auth.profile()?.object_id ?? null);
    }

    const id = this.selectedObjectId();
    if (id) await this.loadProducts(id);

    // Reorder link from Reports / Inventory: put that product in the basket.
    if (fromProduct) {
      const p = this.products().find((x) => x.id === fromProduct);
      if (p) this.cart.set({ [p.id]: fromQty > 0 ? fromQty : Math.max(1, p.suggest) });
    }

    this.loading.set(false);
  }

  async onObjectChange(objectId: string): Promise<void> {
    if (!objectId) return;
    this.selectedObjectId.set(objectId);
    this.cart.set({});
    this.error.set(null);
    this.router.navigate([], { queryParams: { object: objectId }, replaceUrl: true });
    await this.loadProducts(objectId);
  }

  /** Assigned products + stock + 30-day sales + what is already on the way. */
  private async loadProducts(objectId: string): Promise<void> {
    this.productsLoading.set(true);
    this.error.set(null);

    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (WINDOW_DAYS - 1));

    const [assigned, inv, sales, open] = await Promise.all([
      supabase
        .from('object_products')
        .select('product:products ( id, sku, name, category, active )')
        .eq('object_id', objectId),
      supabase.from('inventory').select('product_id, quantity').eq('object_id', objectId),
      supabase
        .from('stock_movements')
        .select('product_id, quantity')
        .eq('object_id', objectId)
        .eq('event', 'SALE')
        .gte('created_at', since.toISOString())
        .limit(5000),
      supabase
        .from('orders')
        .select('status, order_items ( product_id, quantity )')
        .eq('object_id', objectId)
        .in('status', ['PENDING', 'APPROVED']),
    ]);

    if (assigned.error) {
      this.error.set(assigned.error.message);
      this.products.set([]);
      this.productsLoading.set(false);
      return;
    }

    const onHand = new Map<string, number>();
    for (const r of (inv.data ?? []) as { product_id: string; quantity: number }[]) {
      onHand.set(r.product_id, Number(r.quantity) || 0);
    }

    const sold = new Map<string, number>();
    for (const m of (sales.data ?? []) as { product_id: string; quantity: number }[]) {
      sold.set(m.product_id, (sold.get(m.product_id) ?? 0) + Math.abs(Number(m.quantity) || 0));
    }

    const incoming = new Map<string, number>();
    for (const o of (open.data ?? []) as any[]) {
      for (const it of (o.order_items ?? []) as { product_id: string; quantity: number }[]) {
        incoming.set(it.product_id, (incoming.get(it.product_id) ?? 0) + (Number(it.quantity) || 0));
      }
    }

    const list: Orderable[] = ((assigned.data ?? []) as any[])
      .map((r) => r.product)
      .filter((p: any) => p && p.active)
      .map((p: any) => {
        const have = onHand.get(p.id) ?? 0;
        const inc = incoming.get(p.id) ?? 0;
        const sold30 = sold.get(p.id) ?? 0;
        const rw = runway(have, sold30, WINDOW_DAYS, inc);

        return {
          id: p.id, name: p.name, sku: p.sku, category: p.category ?? null,
          onHand: have, incoming: inc, sold30,
          dailyRate: rw.dailyRate, daysLeft: rw.daysLeft, urgency: rw.urgency,
          lowData: rw.lowData, suggest: rw.suggest,
        };
      })
      .sort((a: Orderable, b: Orderable) =>
        Number(b.suggest > 0) - Number(a.suggest > 0) ||
        RANK[a.urgency] - RANK[b.urgency] ||
        (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) ||
        a.name.localeCompare(b.name));

    this.products.set(list);
    this.productsLoading.set(false);
  }

  // ---------- presentation ----------
  tone(u: Urgency): { hex: string; text: string; chip: string; label: string } {
    return {
      out:      { hex: '#ef4444', text: 'text-red-600',   chip: 'bg-red-50 text-red-700 ring-red-200',         label: 'Out of stock' },
      critical: { hex: '#ef4444', text: 'text-red-600',   chip: 'bg-red-50 text-red-700 ring-red-200',         label: 'Reorder now' },
      warning:  { hex: '#f59e0b', text: 'text-amber-600', chip: 'bg-amber-50 text-amber-700 ring-amber-200',   label: 'Reorder soon' },
      healthy:  { hex: '#22c55e', text: 'text-slate-900', chip: 'bg-green-50 text-green-700 ring-green-200',   label: 'Healthy' },
      idle:     { hex: '#cbd5e1', text: 'text-slate-900', chip: 'bg-slate-100 text-slate-600 ring-slate-200', label: 'No recent sales' },
    }[u];
  }

  daysText(onHand: number, days: number | null, sold = MIN_SALES): string {
    return runwayLabel(onHand, days, sold > 0 && sold < MIN_SALES);
  }

  afterTone(days: number | null): string {
    if (days === null) return 'bg-slate-100 text-slate-600 ring-slate-200';
    if (days <= CRITICAL_DAYS) return 'bg-red-50 text-red-700 ring-red-200';
    if (days <= WARNING_DAYS) return 'bg-amber-50 text-amber-700 ring-amber-200';
    if (days > OVERSTOCK_DAYS) return 'bg-amber-50 text-amber-700 ring-amber-200';
    return 'bg-green-50 text-green-700 ring-green-200';
  }

  /** More than twice the target — probably ordering too much. */
  isOverstock(days: number | null): boolean {
    return days !== null && days > OVERSTOCK_DAYS;
  }

  /** Shelf is low, but orders already on the way cover the target. */
  coveredByIncoming(p: Orderable): boolean {
    return p.incoming > 0 && p.suggest === 0 &&
      (p.urgency === 'out' || p.urgency === 'critical' || p.urgency === 'warning');
  }

  /** Units that would bring this product exactly to the target. */
  targetQty(l: BasketLine): number {
    return Math.max(0, Math.ceil(l.dailyRate * TARGET_DAYS - Math.max(0, l.onHand) - l.incoming));
  }

  delay(i: number): number {
    return Math.min(i, 12) * 30;
  }

  // ---------- basket ----------
  qty(id: string): number {
    return this.cart()[id] ?? 0;
  }

  private setQty(id: string, qty: number): void {
    const next = Math.max(0, Math.min(9999, Math.floor(qty) || 0));
    this.cart.update((c) => ({ ...c, [id]: next }));
    this.error.set(null);
    this.bumpId.set(null);
    setTimeout(() => this.bumpId.set(id));
  }

  add(p: Orderable, delta = 1): void {
    this.setQty(p.id, this.qty(p.id) + delta);
  }

  addSuggested(p: Orderable): void {
    if (p.suggest > 0) this.setQty(p.id, p.suggest);
  }

  addAllSuggested(): void {
    const next = { ...this.cart() };
    for (const p of this.needing()) next[p.id] = Math.max(next[p.id] ?? 0, p.suggest);
    this.cart.set(next);
    this.error.set(null);
  }

  onQtyInput(id: string, value: string): void {
    this.setQty(id, Number(value));
  }

  remove(id: string): void {
    this.cart.update((c) => ({ ...c, [id]: 0 }));
  }

  clear(): void {
    this.cart.set({});
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !this.placed()) {
      e.preventDefault();
      void this.submit();
    }
  }

  // ---------- submit ----------
  async submit(): Promise<void> {
    const objectId = this.selectedObjectId();
    const profile = this.auth.profile();
    const snapshot = this.lines();
    if (!objectId || !profile || snapshot.length === 0 || this.saving()) return;

    this.saving.set(true);
    this.error.set(null);

    const err = await this.orders.create(
      objectId,
      profile.id,
      this.comment().trim() || null,
      snapshot.map((l) => ({ product_id: l.id, quantity: l.qty }))
    );

    this.saving.set(false);
    if (err) {
      this.error.set(err);
      return;
    }

    this.placed.set({
      objectName: this.objectName(),
      units: snapshot.reduce((s, l) => s + l.qty, 0),
      lines: snapshot,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async newOrder(): Promise<void> {
    this.placed.set(null);
    this.cart.set({});
    this.comment.set('');
    this.search.set('');
    const id = this.selectedObjectId();
    if (id) await this.loadProducts(id);
  }
}
