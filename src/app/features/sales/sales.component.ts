import { Component, HostListener, computed, inject, signal, OnInit } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { SalesService, SaleRow, SellableProduct } from './sales.service';
import { BusinessObject } from '../objects/object.model';
import { ToastService } from '../../shared/ui/toast.service';
import { CRITICAL_DAYS, WARNING_DAYS, MIN_SALES, runwayLabel } from '../../core/stock/runway';

interface RangeOption {
  label: string;
  days: number | null;
}

interface DayBucket {
  date: Date;
  units: number;
  sales: number;
}

/** One sale as a customer sees it: one or more lines under one reference. */
interface SaleGroup {
  key: string;
  ref: string | null;
  objectName: string;
  createdAt: string;
  note: string | null;
  lines: SaleRow[];
  units: number;
}

/** Shelf health after a sale — same thresholds as Inventory. */
type Tone = 'out' | 'critical' | 'warning' | 'ok' | 'idle';
const TONE_RANK: Record<Tone, number> = { out: 0, critical: 1, warning: 2, ok: 3, idle: 4 };

interface CartLine extends SellableProduct {
  qty: number;
  after: number;
  daysAfter: number | null;
  tone: Tone;
  /** This sale pushes the product into a worse zone (soon / now / empty). */
  crosses: boolean;
}

interface LastSale {
  ref: string | null;
  objectId: string;
  objectName: string;
  units: number;
  lines: CartLine[];
}

const DAY = 86_400_000;

@Component({
  selector: 'app-sales',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink],
  templateUrl: './sales.component.html',
  styles: [`
    @keyframes rowIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .row-in { animation: rowIn .45s cubic-bezier(.2,.8,.2,1) backwards; }

    @keyframes grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
    .bar { transform-origin: bottom; animation: grow .6s cubic-bezier(.2,.8,.2,1) backwards; }

    @keyframes fill { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    .fill { transform-origin: left; animation: fill .7s cubic-bezier(.2,.8,.2,1) backwards; }

    @keyframes flash { 0%, 40% { background: #eef2ff; } 100% { background: transparent; } }
    .row-flash { animation: flash 2.2s ease-out; }

    .sk { position: relative; overflow: hidden; background: #f1f5f9; border-radius: .5rem; }
    .sk::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.7), transparent);
      animation: shimmer 1.3s infinite; }
    @keyframes shimmer { 100% { transform: translateX(100%); } }

    @keyframes pop { 0% { transform: scale(.6); opacity: 0; } 60% { transform: scale(1.08); } 100% { transform: scale(1); opacity: 1; } }
    .pop { animation: pop .35s cubic-bezier(.2,.8,.2,1) backwards; }

    @keyframes bump { 0% { transform: scale(1); } 40% { transform: scale(1.25); } 100% { transform: scale(1); } }
    .bump { animation: bump .25s ease-out; }

    .check path { stroke-dasharray: 24; stroke-dashoffset: 24; animation: dash .45s ease-out .2s forwards; }
    @keyframes dash { to { stroke-dashoffset: 0; } }

    @media (prefers-reduced-motion: reduce) {
      .row-in, .bar, .fill, .row-flash, .sk::after, .pop, .bump { animation: none; }
      .check path { animation: none; stroke-dashoffset: 0; }
    }
  `],
})
export class SalesComponent implements OnInit {
  readonly svc = inject(SalesService);
  readonly auth = inject(AuthService);
  private toast = inject(ToastService);

  readonly isAdmin = computed(() => this.auth.isAdmin());

  readonly objects = signal<BusinessObject[]>([]);
  readonly selectedObjectId = signal<string>('');
  readonly rangeDays = signal<number | null>(30);
  readonly search = signal<string>('');
  readonly hovered = signal<number | null>(null);
  readonly flashRef = signal<string | null>(null);

  readonly ranges: RangeOption[] = [
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
    { label: 'All', days: null },
  ];

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  async ngOnInit(): Promise<void> {
    if (this.isAdmin()) {
      const { data } = await supabase.from('objects').select('*').eq('active', true).order('name');
      this.objects.set((data ?? []) as BusinessObject[]);
    }
    await this.reload(1);
  }

  async reload(page = 1): Promise<void> {
    await Promise.all([
      this.svc.load({
        page,
        objectId: this.selectedObjectId(),
        rangeDays: this.rangeDays(),
        search: this.search(),
      }),
      this.svc.loadInsights(this.selectedObjectId(), this.rangeDays()),
    ]);
  }

  onObjectChange(objectId: string): void {
    this.selectedObjectId.set(objectId);
    void this.reload(1);
  }

  onRangeChange(days: number | null): void {
    this.rangeDays.set(days);
    void this.reload(1);
  }

  onSearch(value: string): void {
    this.search.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.reload(1), 250);
  }

  previous(): void {
    void this.svc.previous({
      objectId: this.selectedObjectId(),
      rangeDays: this.rangeDays(),
      search: this.search(),
    });
  }

  next(): void {
    void this.svc.next({
      objectId: this.selectedObjectId(),
      rangeDays: this.rangeDays(),
      search: this.search(),
    });
  }

  // =====================================================================
  // Insights — chart, top products, KPIs (client-side over sale lines)
  // =====================================================================

  /** Sale lines in the range, narrowed by the search box. */
  private readonly lines = computed(() => {
    const q = this.search().trim().toLowerCase();
    const all = this.svc.insights();
    if (!q) return all;
    return all.filter((l) =>
      l.name.toLowerCase().includes(q) ||
      l.sku.toLowerCase().includes(q) ||
      (l.note ?? '').toLowerCase().includes(q));
  });

  /** Days on the chart: the range, or (for "All") back to the first sale, 7–180. */
  readonly chartDays = computed(() => {
    const r = this.rangeDays();
    if (r !== null) return r;
    const lines = this.lines();
    if (!lines.length) return 30;
    const first = new Date(lines[lines.length - 1].createdAt);
    first.setHours(0, 0, 0, 0);
    const span = Math.round((startOfToday().getTime() - first.getTime()) / DAY) + 1;
    return Math.max(7, Math.min(180, span));
  });

  readonly buckets = computed<DayBucket[]>(() => {
    const n = this.chartDays();
    const today = startOfToday();
    const start = new Date(today);
    start.setDate(start.getDate() - (n - 1));

    const out: DayBucket[] = Array.from({ length: n }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return { date: d, units: 0, sales: 0 };
    });

    const seen = new Set<string>();
    for (const l of this.lines()) {
      const d = new Date(l.createdAt);
      d.setHours(0, 0, 0, 0);
      const i = Math.round((d.getTime() - start.getTime()) / DAY);
      if (i < 0 || i >= n) continue;
      out[i].units += l.units;
      const key = this.saleKey(l.reference, l.id);
      if (!seen.has(key)) {
        seen.add(key);
        out[i].sales += 1;
      }
    }
    return out;
  });

  readonly maxBucket = computed(() => Math.max(1, ...this.buckets().map((b) => b.units)));

  readonly kpis = computed(() => {
    const lines = this.lines();
    const units = lines.reduce((s, l) => s + l.units, 0);
    const sales = new Set(lines.map((l) => this.saleKey(l.reference, l.id))).size;
    const best = this.buckets().reduce<DayBucket | null>((b, x) => (!b || x.units > b.units ? x : b), null);
    return {
      units,
      sales,
      perSale: sales ? units / sales : 0,
      perDay: units / this.chartDays(),
      best: best && best.units > 0 ? best : null,
    };
  });

  readonly topProducts = computed(() => {
    const map = new Map<string, { name: string; sku: string; units: number }>();
    for (const l of this.lines()) {
      const e = map.get(l.productId);
      if (e) e.units += l.units;
      else map.set(l.productId, { name: l.name, sku: l.sku, units: l.units });
    }
    const list = [...map.values()].sort((a, b) => b.units - a.units).slice(0, 5);
    const max = Math.max(1, ...list.map((p) => p.units));
    const total = list.reduce((s, p) => s + p.units, 0) || 1;
    return list.map((p) => ({ ...p, pct: (p.units / max) * 100, share: (p.units / total) * 100 }));
  });

  /** Lines from one "Record sale" share a sale:<uuid> reference; others stand alone. */
  private saleKey(ref: string | null, id: string): string {
    return ref && ref.startsWith('sale:') ? ref : id;
  }

  barHeight(b: DayBucket): number {
    return b.units ? Math.max(4, (b.units / this.maxBucket()) * 100) : 0;
  }

  barDelay(i: number): number {
    return Math.min(i * (300 / this.chartDays()), 300);
  }

  isTick(i: number): boolean {
    const n = this.chartDays();
    return i === 0 || i === n - 1 || i === Math.floor((n - 1) / 2);
  }

  // =====================================================================
  // Table — consecutive lines of the same sale become one row
  // =====================================================================

  readonly groups = computed<SaleGroup[]>(() => {
    const out: SaleGroup[] = [];
    for (const r of this.svc.rows()) {
      const ref = r.reference && r.reference.startsWith('sale:') ? r.reference : null;
      const last = out[out.length - 1];
      if (ref && last && last.ref === ref) {
        last.lines.push(r);
        last.units += r.units;
        continue;
      }
      out.push({
        key: r.id,
        ref,
        objectName: r.objectName,
        createdAt: r.createdAt,
        note: r.note,
        lines: [r],
        units: r.units,
      });
    }
    return out;
  });

  shortRef(ref: string | null): string {
    return ref ? ref.slice(5, 13) : '';
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

  rangeLabel(): string {
    const r = this.rangeDays();
    return r === null ? `last ${this.chartDays()} days` : `last ${r} days`;
  }

  // =====================================================================
  // Record sale drawer — fast basket with live shelf impact
  // =====================================================================

  readonly saleOpen = signal(false);
  readonly saleStep = signal<'basket' | 'done'>('basket');
  readonly saleObjectId = signal<string>('');
  readonly cart = signal<Record<string, number>>({});
  readonly saleNote = signal('');
  readonly saleError = signal<string | null>(null);
  readonly productSearch = signal('');
  readonly bumpId = signal<string | null>(null);
  readonly lastSale = signal<LastSale | null>(null);

  readonly shortcut =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ Enter' : 'Ctrl Enter';

  readonly saleObjectName = computed(() =>
    this.objects().find((o) => o.id === this.saleObjectId())?.name ?? 'Your store');

  /** In stock first, best sellers on top, then A–Z. */
  readonly sellableFiltered = computed(() => {
    const q = this.productSearch().trim().toLowerCase();
    const list = this.svc.sellable().filter((p) =>
      !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    return [...list].sort((a, b) =>
      Number(b.onHand > 0) - Number(a.onHand > 0) ||
      b.sold30 - a.sold30 ||
      a.name.localeCompare(b.name));
  });

  readonly cartLines = computed<CartLine[]>(() => {
    const c = this.cart();
    return this.svc.sellable()
      .filter((p) => (c[p.productId] ?? 0) > 0)
      .map((p) => {
        const qty = c[p.productId];
        const after = p.onHand - qty;
        const before = this.toneFor(p.onHand, this.daysLeft(p.onHand, p.dailyRate));
        const daysAfter = this.daysLeft(after, p.dailyRate);
        const tone = this.toneFor(after, daysAfter);
        const crosses = TONE_RANK[tone] < TONE_RANK[before] && TONE_RANK[tone] <= 2;
        return { ...p, qty, after, daysAfter, tone, crosses };
      });
  });

  readonly cartUnits = computed(() => this.cartLines().reduce((s, l) => s + l.qty, 0));
  readonly warnings = computed(() => this.cartLines().filter((l) => l.crosses).length);

  reorderCount(lines: CartLine[]): number {
    return lines.filter((l) => l.tone === 'out' || l.tone === 'critical').length;
  }

  // ---------- shelf maths (same rules as Inventory) ----------
  daysLeft(onHand: number, rate: number): number | null {
    return rate > 0 ? Math.max(0, onHand) / rate : null;
  }

  toneFor(onHand: number, days: number | null): Tone {
    if (onHand <= 0) return 'out';
    if (days === null) return 'idle';
    if (days <= CRITICAL_DAYS) return 'critical';
    if (days <= WARNING_DAYS) return 'warning';
    return 'ok';
  }

  daysText(onHand: number, days: number | null, sold = MIN_SALES): string {
    const l = runwayLabel(onHand, days, sold > 0 && sold < MIN_SALES);
    return /\d/.test(l) ? `${l} left` : l;
  }

  toneChip(t: Tone): string {
    return {
      out: 'bg-red-50 text-red-700 ring-red-200',
      critical: 'bg-red-50 text-red-700 ring-red-200',
      warning: 'bg-amber-50 text-amber-700 ring-amber-200',
      ok: 'bg-green-50 text-green-700 ring-green-200',
      idle: 'bg-slate-100 text-slate-600 ring-slate-200',
    }[t];
  }

  toneNote(t: Tone): string {
    return { out: 'shelf empty', critical: 'reorder now', warning: 'reorder soon', ok: '', idle: '' }[t];
  }

  // ---------- open / close ----------
  async openSale(): Promise<void> {
    const objectId =
      this.selectedObjectId() ||
      (this.isAdmin() ? this.objects()[0]?.id : this.auth.profile()?.object_id) ||
      '';
    if (!objectId) {
      this.toast.error('No store available to sell from.');
      return;
    }
    this.saleObjectId.set(objectId);
    this.resetBasket();
    this.saleOpen.set(true);
    await this.svc.loadSellable(objectId);
    this.focusSearch();
  }

  async changeSaleObject(objectId: string): Promise<void> {
    this.saleObjectId.set(objectId);
    this.resetBasket();
    await this.svc.loadSellable(objectId);
    this.focusSearch();
  }

  closeSale(): void {
    this.saleOpen.set(false);
  }

  async newSale(): Promise<void> {
    this.resetBasket();
    await this.svc.loadSellable(this.saleObjectId());
    this.focusSearch();
  }

  private resetBasket(): void {
    this.cart.set({});
    this.saleNote.set('');
    this.saleError.set(null);
    this.productSearch.set('');
    this.lastSale.set(null);
    this.saleStep.set('basket');
  }

  private focusSearch(): void {
    setTimeout(() => document.getElementById('sale-search')?.focus(), 60);
  }

  // ---------- basket ----------
  qty(p: SellableProduct): number {
    return this.cart()[p.productId] ?? 0;
  }

  addToCart(p: SellableProduct, delta: number): void {
    const next = Math.max(0, Math.min(p.onHand, this.qty(p) + delta));
    if (next === this.qty(p)) return;
    this.cart.update((c) => ({ ...c, [p.productId]: next }));
    this.saleError.set(null);
    this.bumpId.set(null);
    setTimeout(() => this.bumpId.set(p.productId));
  }

  removeFromCart(productId: string): void {
    this.cart.update((c) => ({ ...c, [productId]: 0 }));
  }

  addToCartById(productId: string, delta: number): void {
    const p = this.svc.sellable().find((x) => x.productId === productId);
    if (p) this.addToCart(p, delta);
  }

  clearCart(): void {
    this.cart.set({});
    this.saleError.set(null);
  }

  /** Tile stock bar, relative to the fullest shelf in this store. */
  readonly maxOnHand = computed(() => Math.max(1, ...this.svc.sellable().map((p) => p.onHand)));

  shelfPct(left: number): number {
    return Math.max(0, Math.min(100, (left / this.maxOnHand()) * 100));
  }

  /** N opens checkout · Esc closes · Ctrl/⌘ + Enter records. */
  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (this.saleOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeSale();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void this.submitSale();
      }
      return;
    }
    const tag = (e.target as HTMLElement | null)?.tagName ?? '';
    if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
      e.preventDefault();
      void this.openSale();
    }
  }

  /** Enter in the search box: exact SKU wins (scanner-friendly), else first product in stock. */
  onSearchEnter(event: Event): void {
    event.preventDefault();
    const q = this.productSearch().trim().toLowerCase();
    if (!q) return;
    const list = this.sellableFiltered();
    const target =
      list.find((p) => p.sku.toLowerCase() === q && this.qty(p) < p.onHand) ??
      list.find((p) => this.qty(p) < p.onHand);
    if (!target) {
      this.saleError.set(`Nothing left to sell for "${this.productSearch().trim()}".`);
      return;
    }
    this.addToCart(target, 1);
    this.productSearch.set('');
  }

  // ---------- submit ----------
  async submitSale(): Promise<void> {
    if (this.saleStep() !== 'basket' || this.svc.saving() || this.cartUnits() === 0) return;
    const profile = this.auth.profile();
    const objectId = this.saleObjectId();
    if (!profile || !objectId) return;

    const snapshot = this.cartLines();
    const lines = snapshot.map((l) => ({ productId: l.productId, qty: l.qty }));
    const { reference, error } = await this.svc.recordSale(
      objectId, lines, this.saleNote().trim() || null, profile.id);

    if (error) {
      this.saleError.set(error);
      return;
    }

    this.lastSale.set({
      ref: reference,
      objectId,
      objectName: this.saleObjectName(),
      units: snapshot.reduce((s, l) => s + l.qty, 0),
      lines: snapshot,
    });
    this.saleStep.set('done');

    await this.reload(1);
    this.flashRef.set(reference);
    setTimeout(() => this.flashRef.set(null), 2300);
  }
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
