import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';
import {
  DashboardService, FlowDay, LedgerRow, MovementEvent, PendingOrder, RangeDays, StoreHealth, Urgency,
} from './dashboard.service';

/**
 * Stock flow chart geometry (SVG units - the SVG stretches to the card width).
 * Every day is one column. The balance line, the in/out bars and the hover band
 * all use the same columns, so they always line up.
 */
const W = 600;
const H = 150;
const PAD_T = 14;
const PAD_B = 6;

/** Flat stretches at least this long get a "quiet days" label. */
const QUIET_MIN = 5;

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink, BadgeComponent],
  templateUrl: './dashboard.component.html',
  styles: [`
    @keyframes rowIn { from { opacity: 0; transform: translateY(-6px); background: #eef2ff; }
                       to   { opacity: 1; transform: none; background: transparent; } }
    .row-in { animation: rowIn .8s ease-out; }
    @keyframes cardIn { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
    .card-in { animation: cardIn .35s ease-out; }

    /* the balance line is revealed left -> right on load and on range change */
    @keyframes reveal { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
    .reveal { animation: reveal 1s cubic-bezier(.4,0,.2,1) both; }

    @keyframes ping { 0% { transform: scale(1); opacity: .5; } 100% { transform: scale(2.6); opacity: 0; } }
    .live-ping { animation: ping 1.6s ease-out infinite; }

    @keyframes swap { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
    .swap { animation: swap .2s ease-out; }

    @keyframes shimmer { 100% { transform: translateX(100%); } }
    .skeleton { position: relative; overflow: hidden; background: #f1f5f9; border-radius: .5rem; }
    .skeleton::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.7), transparent);
      animation: shimmer 1.3s infinite; }
    @media (prefers-reduced-motion: reduce) {
      .row-in, .card-in, .reveal, .live-ping, .swap, .skeleton::after { animation: none; }
    }
  `],
})
export class DashboardComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  readonly svc = inject(DashboardService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly ranges: RangeDays[] = [7, 30, 90];

  readonly isAdmin = computed(() => this.auth.isAdmin());
  readonly W = W;
  readonly H = H;

  /** Index of the hovered day (null = show the whole period). */
  readonly hover = signal<number | null>(null);

  ngOnInit(): void {
    // Seller: RLS already limits to own store; passing it keeps the RPC explicit.
    const own = this.isAdmin() ? null : this.auth.profile()?.object_id ?? null;
    this.svc.load(own, this.svc.days());
    this.svc.connect();
  }

  ngOnDestroy(): void {
    this.svc.disconnect();
  }

  // ---------- header ----------
  readonly greeting = computed(() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  });

  readonly firstName = computed(() => {
    const p = this.auth.profile();
    const name = p?.full_name?.trim() || p?.email?.split('@')[0] || '';
    return name.split(' ')[0];
  });

  readonly briefing = computed(() => this.svc.briefing(this.isAdmin()));

  // =====================================================================
  // STOCK FLOW CHART
  // top:    what is on the shelf (stepped line)
  // bottom: what moved that day - in grows up (green), out grows down (red)
  // =====================================================================

  private readonly n = computed(() => this.svc.flow().length);

  /** Balance before the first visible day. */
  private readonly opening0 = computed(() => {
    const f = this.svc.flow()[0];
    return f ? f.closing - f.in + f.out : 0;
  });

  /** Rounded-up axis max so gridlines land on friendly numbers. */
  private readonly maxClosing = computed(() => {
    const raw = Math.max(1, this.opening0(), ...this.svc.flow().map((d) => d.closing));
    const step = raw <= 10 ? 2 : raw <= 50 ? 5 : raw <= 200 ? 25 : raw <= 1000 ? 100 : 500;
    return Math.ceil((raw * 1.1) / (step * 2)) * step * 2;
  });

  /** 3 gridlines: max, half, 0 - in % of the line area height. */
  readonly yTicks = computed(() => {
    const m = this.maxClosing();
    return [m, m / 2, 0].map((v) => ({ v, top: (this.y(v) / H) * 100 }));
  });

  private readonly maxBar = computed(() =>
    Math.max(1, ...this.svc.flow().map((d) => Math.max(d.in, d.out))));

  /** Left edge of a day column, in SVG units. */
  private colX(i: number): number {
    return (i / Math.max(1, this.n())) * W;
  }

  private y(v: number): number {
    return PAD_T + (1 - v / this.maxClosing()) * (H - PAD_T - PAD_B);
  }

  /** Column centre in % - for HTML overlays. */
  centerPct(i: number): number {
    return ((i + 0.5) / Math.max(1, this.n())) * 100;
  }

  readonly colWidthPct = computed(() => 100 / Math.max(1, this.n()));

  /** Stock changes at the start of a day column and stays flat across it. */
  readonly linePath = computed(() => {
    const f = this.svc.flow();
    if (!f.length) return '';
    let d = `M0 ${this.y(this.opening0())}`;
    f.forEach((p, i) => { d += ` H${this.colX(i)} V${this.y(p.closing)}`; });
    return d + ` H${W}`;
  });

  readonly areaPath = computed(() => {
    const line = this.linePath();
    return line ? `${line} V${H} H0 Z` : '';
  });

  /** In/out bars as % of their half of the band. */
  readonly bars = computed(() => {
    const m = this.maxBar();
    return this.svc.flow().map((d) => ({
      inPct: d.in ? Math.max(6, (d.in / m) * 100) : 0,
      outPct: d.out ? Math.max(6, (d.out / m) * 100) : 0,
    }));
  });

  /** "Today" marker at the end of the line. */
  readonly endDot = computed(() => {
    const f = this.svc.flow();
    if (!f.length) return null;
    return { left: this.centerPct(f.length - 1), top: (this.y(f[f.length - 1].closing) / H) * 100 };
  });

  /** Long flat stretches are labelled instead of looking like a broken chart. */
  readonly quietRuns = computed(() => {
    const f = this.svc.flow();
    const n = f.length;
    const out: { left: number; width: number; days: number }[] = [];
    if (n < 14) return out;
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const idle = i < n && f[i].in === 0 && f[i].out === 0;
      if (idle && start < 0) start = i;
      if (!idle && start >= 0) {
        const len = i - start;
        if (len >= QUIET_MIN) out.push({ left: (start / n) * 100, width: (len / n) * 100, days: len });
        start = -1;
      }
    }
    return out;
  });

  /** Middle date label - only when there is room for three. */
  readonly midDay = computed(() => {
    const f = this.svc.flow();
    return f.length >= 14 ? f[Math.floor(f.length / 2)].day : null;
  });

  // ---------- hover ----------
  readonly hoverDay = computed<FlowDay | null>(() => {
    const i = this.hover();
    return i === null ? null : this.svc.flow()[i] ?? null;
  });

  /**
   * The equation under the chart: the whole period, or the hovered day.
   * opening + in - out = closing
   */
  readonly equation = computed(() => {
    const d = this.hoverDay();
    if (d) {
      return { key: d.day, day: d.day, opening: d.closing - d.in + d.out, in: d.in, out: d.out, closing: d.closing };
    }
    const t = this.svc.flowTotals();
    if (!t) return null;
    return { key: 'all', day: null, opening: t.opening, in: t.units_in, out: t.units_out, closing: t.closing };
  });

  /** Net change over the visible period - chip next to "On shelf now". */
  readonly periodNet = computed(() => {
    const t = this.svc.flowTotals();
    return t ? t.units_in - t.units_out : 0;
  });

  onChartMove(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const n = this.n();
    if (!n || !r.width) return;
    const i = Math.floor(((e.clientX - r.left) / r.width) * n);
    this.hover.set(Math.min(n - 1, Math.max(0, i)));
  }

  /** Human summary of a day's events for the readout. */
  dayEvents(d: FlowDay): string {
    const e = d.events;
    if (!e) return '';
    const parts: string[] = [];
    if (e.delivery) parts.push(`${e.delivery} ${e.delivery === 1 ? 'delivery' : 'deliveries'}`);
    if (e.sale) parts.push(`${e.sale} ${e.sale === 1 ? 'sale' : 'sales'}`);
    if (e.count) parts.push(`${e.count} ${e.count === 1 ? 'count' : 'counts'}`);
    if (e.other) parts.push(`${e.other} other`);
    return parts.join(' · ');
  }

  signed(n: number): string {
    return n > 0 ? `+${n}` : n < 0 ? `\u2212${Math.abs(n)}` : '0';
  }

  // ---------- approve / reject ----------
  readonly busy = signal<string | null>(null);

  linesLabel(o: PendingOrder): string {
    const l = o.lines ?? [];
    if (!l.length) return `${o.units} units`;
    const head = l.slice(0, 2).map((x) => `${x.qty}× ${x.name}`).join(', ');
    return l.length > 2 ? `${head} +${l.length - 2} more` : head;
  }

  async approve(o: PendingOrder): Promise<void> {
    this.busy.set(o.id);
    const err = await this.svc.decide(o.id, 'APPROVED');
    this.busy.set(null);
    if (err) { this.toast.error('Could not approve the order — try again.'); return; }

    this.toast.success(`Order approved for ${o.store}`, {
      action: {
        label: 'Undo',
        run: async () => {
          const undoErr = await this.svc.decide(o.id, 'PENDING');
          if (undoErr) this.toast.error('Could not undo approval — try again.');
          else this.toast.info('Approval undone — back to Pending.');
        },
      },
    });
  }

  async reject(o: PendingOrder): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Reject this order?',
      message: `The order for ${o.store} will be marked REJECTED. This can't be undone.`,
      confirmLabel: 'Reject order',
      tone: 'danger',
    });
    if (!ok) return;

    this.busy.set(o.id);
    const err = await this.svc.decide(o.id, 'REJECTED');
    this.busy.set(null);
    if (err) this.toast.error('Could not reject the order — try again.');
    else this.toast.info('Order rejected.');
  }

  // ---------- running out ----------
  /** Bar fill: 14+ days = full. */
  runwayPct(days: number | null, onHand: number): number {
    if (onHand <= 0) return 0;
    if (days === null) return 100;
    return Math.max(4, Math.min(100, (days / 14) * 100));
  }
  urgencyTone(u: Urgency): 'error' | 'warning' | 'success' | 'neutral' {
    return ({ out: 'error', critical: 'error', warning: 'warning', healthy: 'success', idle: 'neutral' } as const)[u];
  }
  urgencyLabel(u: Urgency, days: number | null): string {
    if (u === 'out') return 'Out of stock';
    if (days === null) return 'No sales';
    return `${Math.round(days)}d left`;
  }
  /** Reports is admin-only → sellers go to their inventory. */
  readonly runwayLink = computed(() => (this.isAdmin() ? '/reports' : '/inventory'));

  // ---------- stores ----------
  storeTone(s: StoreHealth): string {
    if (s.rank <= 1) return 'bg-red-50 ring-red-200';
    if (s.rank === 2) return 'bg-amber-50 ring-amber-200';
    return 'bg-white ring-slate-200';
  }
  storeDot(s: StoreHealth): string {
    if (s.rank <= 1) return 'bg-red-500';
    if (s.rank === 2) return 'bg-amber-500';
    return 'bg-green-500';
  }

  // ---------- ledger ----------
  /** Same colours as the landing page: delivery green, count amber, sale red. */
  readonly eventMeta: Record<MovementEvent, { label: string; cls: string }> = {
    DELIVERY:    { label: 'Delivery',    cls: 'bg-green-50 text-green-700' },
    SALE:        { label: 'Sale',        cls: 'bg-red-50 text-red-700' },
    STOCK_COUNT: { label: 'Stock count', cls: 'bg-amber-50 text-amber-700' },
    ADJUSTMENT:  { label: 'Adjustment',  cls: 'bg-violet-50 text-violet-700' },
    TRANSFER:    { label: 'Transfer',    cls: 'bg-sky-50 text-sky-700' },
    RETURN:      { label: 'Return',      cls: 'bg-teal-50 text-teal-700' },
    WRITE_OFF:   { label: 'Write-off',   cls: 'bg-slate-100 text-slate-700' },
  };

  isFresh(l: LedgerRow): boolean {
    return this.svc.freshIds().has(l.id);
  }

  /** "2h ago" style, falls back to a date after a week. */
  ago(iso: string): string {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  abs(n: number): number { return Math.abs(n); }
}
