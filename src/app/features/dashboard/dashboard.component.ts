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

/** Chart geometry (SVG units — the SVG scales to the card width). */
const W = 600;
const H = 180;
const PAD_T = 12;
const PAD_B = 8;

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
    @keyframes draw { from { stroke-dashoffset: 2000; } to { stroke-dashoffset: 0; } }
    .draw { stroke-dasharray: 2000; animation: draw 1.1s ease-out both; }
    @keyframes shimmer { 100% { transform: translateX(100%); } }
    .skeleton { position: relative; overflow: hidden; background: #f1f5f9; border-radius: .5rem; }
    .skeleton::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.7), transparent);
      animation: shimmer 1.3s infinite; }
    @media (prefers-reduced-motion: reduce) { .row-in, .card-in, .draw, .skeleton::after { animation: none; } }
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

  /** Index of the hovered day in the chart (null = show totals). */
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

  // ---------- chart ----------
  /** Rounded-up axis max so gridlines land on friendly numbers (0 / 15 / 30). */
  private readonly maxClosing = computed(() => {
    const raw = Math.max(1, ...this.svc.flow().map((d) => d.closing));
    const step = raw <= 10 ? 2 : raw <= 50 ? 5 : raw <= 200 ? 25 : raw <= 1000 ? 100 : 500;
    return Math.ceil((raw * 1.1) / (step * 2)) * step * 2;
  });

  /** 3 gridlines: 0, half, max — positioned in % of the chart height. */
  readonly yTicks = computed(() => {
    const m = this.maxClosing();
    return [m, m / 2, 0].map((v) => ({ v, top: (this.y(v) / H) * 100 }));
  });
  private readonly maxBar = computed(() =>
    Math.max(1, ...this.svc.flow().map((d) => Math.max(d.in, d.out))));

  private x(i: number): number {
    const n = this.svc.flow().length;
    return n <= 1 ? W / 2 : (i / (n - 1)) * W;
  }
  private y(v: number): number {
    return PAD_T + (1 - v / this.maxClosing()) * (H - PAD_T - PAD_B);
  }

  /** Closing balance as a stepped line (stock changes at events, not gradually). */
  readonly linePath = computed(() => {
    const f = this.svc.flow();
    if (!f.length) return '';
    let d = `M0 ${this.y(f[0].closing)}`;
    f.forEach((p, i) => {
      if (i === 0) return;
      d += ` H${this.x(i)} V${this.y(p.closing)}`;
    });
    return d;
  });
  readonly areaPath = computed(() => {
    const line = this.linePath();
    return line ? `${line} V${H} H0 Z` : '';
  });

  /** In/out bars per day, as % of the chart height (rendered in HTML for crisp edges). */
  readonly bars = computed(() => {
    const m = this.maxBar();
    return this.svc.flow().map((d) => ({ inPct: (d.in / m) * 100, outPct: (d.out / m) * 100 }));
  });

  /**
   * One dot per event type on days that had activity, placed on the
   * closing-balance line. Stacked upward when a day has several types.
   */
  readonly dots = computed(() => {
    const out: { left: number; top: number; cls: string; key: string }[] = [];
    this.svc.flow().forEach((d, i) => {
      const e = d.events;
      const types: { on: boolean; cls: string }[] = e
        ? [
            { on: e.delivery > 0, cls: 'bg-blue-500' },
            { on: e.count > 0,    cls: 'bg-amber-500' },
            { on: e.sale > 0,     cls: 'bg-red-500' },
            { on: e.other > 0,    cls: 'bg-violet-500' },
          ]
        : [{ on: d.in > 0 || d.out > 0, cls: 'bg-brand-600' }];
      let k = 0;
      for (const t of types) {
        if (!t.on) continue;
        out.push({
          left: (this.x(i) / W) * 100,
          top: (this.y(d.closing) / H) * 100,
          cls: t.cls,
          key: `${d.day}-${k}`,
        });
        k++;
      }
    });
    // offset stacked dots on the same day
    const seen = new Map<number, number>();
    return out.map((dot) => {
      const n = seen.get(dot.left) ?? 0;
      seen.set(dot.left, n + 1);
      return { ...dot, shift: n * 11 };
    });
  });

  /** Human summary of a day's events for the hover readout. */
  dayEvents(d: FlowDay): string {
    const e = d.events;
    if (!e) return '';
    const parts: string[] = [];
    if (e.delivery) parts.push(`${e.delivery} ${e.delivery === 1 ? 'delivery' : 'deliveries'}`);
    if (e.sale) parts.push(`${e.sale} ${e.sale === 1 ? 'sale' : 'sales'}`);
    if (e.count) parts.push(`${e.count} counted`);
    if (e.other) parts.push(`${e.other} other`);
    return parts.join(' · ');
  }

  readonly hoverDay = computed<FlowDay | null>(() => {
    const i = this.hover();
    return i === null ? null : this.svc.flow()[i] ?? null;
  });
  readonly hoverX = computed(() => {
    const i = this.hover();
    return i === null ? 0 : (this.x(i) / W) * 100;
  });

  onChartMove(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const n = this.svc.flow().length;
    if (!n) return;
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
    this.hover.set(Math.min(n - 1, Math.max(0, i)));
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
  readonly eventMeta: Record<MovementEvent, { label: string; cls: string }> = {
    DELIVERY:    { label: 'Delivery',    cls: 'bg-blue-50 text-blue-700' },
    SALE:        { label: 'Sale',        cls: 'bg-slate-100 text-slate-700' },
    STOCK_COUNT: { label: 'Stock count', cls: 'bg-amber-50 text-amber-700' },
    ADJUSTMENT:  { label: 'Adjustment',  cls: 'bg-violet-50 text-violet-700' },
    TRANSFER:    { label: 'Transfer',    cls: 'bg-sky-50 text-sky-700' },
    RETURN:      { label: 'Return',      cls: 'bg-green-50 text-green-700' },
    WRITE_OFF:   { label: 'Write-off',   cls: 'bg-red-50 text-red-700' },
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
