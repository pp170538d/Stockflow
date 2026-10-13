import {
  Component, OnDestroy, OnInit, computed, effect, inject, signal, untracked,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import {
  ReportsService, RunwayRow, MixSlice, MovementEvent, Urgency, ReportKpis, TARGET_DAYS,
} from './reports.service';
import { BusinessObject } from '../objects/object.model';
import { runwayLabel } from '../../core/stock/runway';

export interface RangeOption {
  label: string;
  days: number;
}

interface Delta {
  up: boolean | null;
  text: string;
  cls: string;
}

type Shown = Pick<ReportKpis, 'onHand' | 'sold' | 'movements' | 'orders' | 'reorder'>;

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [DecimalPipe, RouterLink],
  templateUrl: './reports.component.html',
  styles: [`
    @keyframes rowIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .row-in { animation: rowIn .45s cubic-bezier(.2,.8,.2,1) backwards; }

    @keyframes growUp { from { transform: scaleY(0); } to { transform: scaleY(1); } }
    .bar-up   { transform-origin: bottom; animation: growUp .6s cubic-bezier(.2,.8,.2,1) backwards; }
    .bar-down { transform-origin: top;    animation: growUp .6s cubic-bezier(.2,.8,.2,1) backwards; }

    @keyframes fill { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    .fill { transform-origin: left; animation: fill .7s cubic-bezier(.2,.8,.2,1) backwards; }

    /* lines reveal left → right and stay solid */
    .reveal { animation: reveal 1s cubic-bezier(.2,.8,.2,1) .2s backwards; }
    @keyframes reveal {
      from { clip-path: inset(-4px 100% -4px -4px); }
      to   { clip-path: inset(-4px -4px -4px -4px); }
    }

    @keyframes donutIn { from { opacity: 0; transform: rotate(-180deg) scale(.85); } to { opacity: 1; transform: rotate(-90deg) scale(1); } }
    .donut { transform: rotate(-90deg); animation: donutIn .8s cubic-bezier(.2,.8,.2,1) backwards; }

    .sk { position: relative; overflow: hidden; background: #f1f5f9; border-radius: .5rem; }
    .sk::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.7), transparent);
      animation: shimmer 1.3s infinite; }
    @keyframes shimmer { 100% { transform: translateX(100%); } }

    @media (prefers-reduced-motion: reduce) {
      .row-in, .bar-up, .bar-down, .fill, .reveal, .sk::after { animation: none; }
      .donut { animation: none; }
    }
  `],
})
export class ReportsComponent implements OnInit, OnDestroy {
  readonly svc = inject(ReportsService);

  readonly objects = signal<BusinessObject[]>([]);
  readonly selectedObjectId = signal<string>(''); // '' = all stores

  readonly ranges: RangeOption[] = [
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
  ];
  readonly rangeDays = signal<number>(30);
  readonly hovered = signal<number | null>(null);
  readonly targetDays = TARGET_DAYS;

  // ---------- animated KPI numbers ----------
  readonly shown = signal<Shown>({ onHand: 0, sold: 0, movements: 0, orders: 0, reorder: 0 });
  private raf = 0;
  private readonly reduced =
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  constructor() {
    effect(() => {
      const k = this.svc.kpis();
      untracked(() =>
        this.animateTo({ onHand: k.onHand, sold: k.sold, movements: k.movements, orders: k.orders, reorder: k.reorder })
      );
    });
  }

  async ngOnInit(): Promise<void> {
    const { data } = await supabase.from('objects').select('*').eq('active', true).order('name');
    this.objects.set((data ?? []) as BusinessObject[]);
    this.reload();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
  }

  private reload(): void {
    this.hovered.set(null);
    void this.svc.load(this.selectedObjectId() || null, this.rangeDays());
  }

  onObjectChange(id: string): void {
    this.selectedObjectId.set(id);
    this.reload();
  }

  onRangeChange(days: number): void {
    this.rangeDays.set(days);
    this.reload();
  }

  private animateTo(to: Shown): void {
    cancelAnimationFrame(this.raf);
    const from = this.shown();
    if (this.reduced) { this.shown.set(to); return; }
    const t0 = performance.now();
    const dur = 700;
    const keys = Object.keys(to) as (keyof Shown)[];
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      const next = {} as Shown;
      for (const k of keys) next[k] = Math.round(from[k] + (to[k] - from[k]) * e);
      this.shown.set(next);
      if (t < 1) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // ---------- labels ----------
  readonly scopeLabel = computed(() => {
    const id = this.selectedObjectId();
    if (!id) return 'All stores';
    return this.objects().find((o) => o.id === id)?.name ?? 'Store';
  });

  readonly rangeLabel = computed(() => `last ${this.rangeDays()} days`);

  /** "▲ 40%" vs the previous window. goodWhenUp=false flips the colours. */
  delta(cur: number, prev: number, goodWhenUp = true): Delta {
    if (prev === 0 && cur === 0) return { up: null, text: 'no activity', cls: 'bg-slate-100 text-slate-500' };
    if (prev === 0) return { up: null, text: 'no prior data', cls: 'bg-slate-100 text-slate-500' };
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct === 0) return { up: null, text: 'flat', cls: 'bg-slate-100 text-slate-500' };
    const up = pct > 0;
    const good = up === goodWhenUp;
    return { up, text: `${Math.abs(pct)}%`, cls: good ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700' };
  }

  signed(n: number): string {
    return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
  }

  // ---------- sparklines ----------
  readonly sparks = computed(() => {
    const b = this.svc.buckets();
    return {
      balance: spark(b.map((x) => x.balance)),
      sold: spark(b.map((x) => x.sold)),
      events: spark(b.map((x) => x.events)),
    };
  });

  // ---------- stock-flow chart ----------
  readonly maxAbs = computed(() =>
    Math.max(1, ...this.svc.buckets().map((b) => Math.max(b.inU, b.outU))));

  readonly hasFlow = computed(() => this.svc.buckets().some((b) => b.inU || b.outU));

  flowPct(units: number): number {
    return units ? Math.max(3, (units / this.maxAbs()) * 100) : 0;
  }

  readonly maxBalance = computed(() =>
    Math.max(1, ...this.svc.buckets().map((b) => b.balance)));

  /** Stock on hand at the end of each bucket — stepped, own scale (0 = bottom). */
  readonly balancePath = computed(() => {
    const b = this.svc.buckets();
    if (!b.length) return '';
    const n = b.length;
    const max = this.maxBalance();
    let d = '';
    b.forEach((x, i) => {
      const px = ((i + 0.5) / n) * 100;
      const py = 96 - (Math.max(0, x.balance) / max) * 92;
      d += i === 0 ? `M${px.toFixed(2)} ${py.toFixed(2)}` : ` H${px.toFixed(2)} V${py.toFixed(2)}`;
    });
    return d;
  });

  barDelay(i: number): number {
    return Math.min(i * (300 / Math.max(1, this.svc.buckets().length)), 300);
  }

  isTick(i: number): boolean {
    const n = this.svc.buckets().length;
    return i === 0 || i === n - 1 || i === Math.floor((n - 1) / 2);
  }

  // ---------- movement mix ----------
  readonly eventMeta: Record<MovementEvent, { label: string; hex: string }> = {
    SALE:        { label: 'Sale',        hex: '#ef4444' },
    DELIVERY:    { label: 'Delivery',    hex: '#3b82f6' },
    STOCK_COUNT: { label: 'Stock count', hex: '#f59e0b' },
    ADJUSTMENT:  { label: 'Adjustment',  hex: '#8b5cf6' },
    RETURN:      { label: 'Return',      hex: '#22c55e' },
    WRITE_OFF:   { label: 'Write-off',   hex: '#f43f5e' },
    TRANSFER:    { label: 'Transfer',    hex: '#0ea5e9' },
  };

  private gap(): number {
    return this.svc.mix().length > 1 ? 0.8 : 0;
  }

  dash(s: MixSlice): string {
    const len = Math.max(0, s.pct - this.gap());
    return `${len} ${100 - len}`;
  }

  dashOffset(s: MixSlice): string {
    return String(-s.offset);
  }

  // ---------- runway ----------
  tone(u: Urgency): { hex: string; text: string; chip: string; label: string } {
    return {
      out:      { hex: '#ef4444', text: 'text-red-600',   chip: 'bg-red-50 text-red-700 ring-red-200',         label: 'Out of stock' },
      critical: { hex: '#ef4444', text: 'text-red-600',   chip: 'bg-red-50 text-red-700 ring-red-200',         label: 'Reorder now' },
      warning:  { hex: '#f59e0b', text: 'text-amber-600', chip: 'bg-amber-50 text-amber-700 ring-amber-200',   label: 'Reorder soon' },
      healthy:  { hex: '#22c55e', text: 'text-slate-900', chip: 'bg-green-50 text-green-700 ring-green-200',   label: 'Healthy' },
      idle:     { hex: '#cbd5e1', text: 'text-slate-900', chip: 'bg-slate-100 text-slate-600 ring-slate-200', label: 'No recent sales' },
    }[u];
  }

  runwayPct(r: RunwayRow): number {
    if (r.onHand <= 0) return 0;
    if (r.daysLeft === null) return 100;
    return Math.max(3, Math.min(100, (r.daysLeft / 30) * 100));
  }

  runwayText(r: RunwayRow): string {
    const l = runwayLabel(r.onHand, r.daysLeft, r.lowData);
    return /\d/.test(l) ? `${l} left` : l;
  }

  reorderParams(r: RunwayRow): Record<string, string | number> {
    const p: Record<string, string | number> = { product: r.productId, qty: r.suggestQty };
    if (r.objectId) p['object'] = r.objectId;
    return p;
  }

  readonly urgentNames = computed(() =>
    this.svc.runway()
      .filter((r) => r.urgency === 'out' || r.urgency === 'critical')
      .map((r) => r.name));

  scrollToRunway(): void {
    document.getElementById('runway')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  delay(i: number): number {
    return Math.min(i, 12) * 35;
  }
}

// ---------------------------------------------------------------------

/** Small area sparkline in a 100 × 28 box. */
function spark(values: number[]): { line: string; area: string } {
  const n = values.length;
  if (!n) return { line: '', area: '' };
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const range = max - min || 1;
  const x = (i: number) => (n === 1 ? 100 : (i / (n - 1)) * 100);
  const y = (v: number) => 26 - ((v - min) / range) * 22;
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ');
  return { line, area: `${line} L100 28 L0 28 Z` };
}
