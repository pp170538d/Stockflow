import {
  AfterViewInit, Component, DestroyRef, ElementRef, OnInit, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { RevealDirective } from '../../shared/ui/reveal.directive';
import { BadgeComponent } from '../../shared/ui/badge.component';

/** The four fixed places in the store scene. The scene never pans or zooms. */
type Zone = 'hq' | 'dock' | 'shelf' | 'pos';
type Layer = 'UI' | 'RPC' | 'SQL' | 'RLS' | 'TRIGGER' | 'VIEW';
type HoodState = 'done' | 'run' | 'todo';

/** One step of what the system actually does underneath a chapter. */
interface HoodStep { layer: Layer; text: string; }

interface Chapter {
  step: string;
  title: string;
  body: string;
  /** Zones lit in this chapter; everything else is dimmed. */
  focus: Zone[];
  hood: HoodStep[];
}

interface LedgerLine {
  chapter: number;
  event: string;
  qty: number;
  balance: number;
  ref: string;
  /** Local progress (0-1) where the shelf starts changing. */
  from: number;
  /** Local progress (0-1) where the ledger row is written. */
  at: number;
}

interface Pt { x: number; y: number; }
interface Paint { body: string; neck: string; }
interface SvgChip { key: string; text: string; bg: string; fg: string; }
interface HtmlChip { key: string; text: string; cls: string; }

/** Hero loop length in ms. */
const HERO_LOOP = 10_800;
/** Hero: when each ledger row is written (index 0 = opening, always shown). */
const HERO_ROW_AT = [0, 3600, 5000, 7450];
/** Hero: the shelf fades and the loop restarts after this point. */
const HERO_RESET = 10_200;

/** Order card path: shelf -> head office inbox (quadratic Bezier). */
const ORDER_PATH: [Pt, Pt, Pt] = [{ x: 262, y: 190 }, { x: 262, y: 100 }, { x: 150, y: 80 }];

const PAINT: Record<'base' | 'low' | 'fresh' | 'count' | 'sale', Paint> = {
  base:  { body: '#818cf8', neck: '#4f46e5' },
  low:   { body: '#fca5a5', neck: '#ef4444' },
  fresh: { body: '#4ade80', neck: '#16a34a' },
  count: { body: '#fbbf24', neck: '#d97706' },
  sale:  { body: '#f87171', neck: '#dc2626' },
};

/** Story shelf: 2 rows x 13 bottles. y = bottom of the bottle. */
function storySlot(i: number): Pt {
  return { x: 192 + (i % 13) * 13.6, y: i < 13 ? 280 : 338 };
}

/** Hero shelf: same layout, smaller scene. */
function heroSlot(i: number): Pt {
  return { x: 110 + (i % 13) * 11.4, y: i < 13 ? 64 : 112 };
}

/**
 * Scene geometry. The desktop scene is landscape (560x384); phones get their own
 * portrait-ish scene (360x450) where the shelf is the biggest thing on screen.
 * Timing is shared - only coordinates differ.
 */
interface Geo {
  bw: number; bh: number; neck: number;
  slot: (i: number) => Pt;
  order: [Pt, Pt, Pt];
  truckY: number; truckDock: number;
  crateFrom: Pt; crateTo: Pt;
  flightTo: (i: number) => Pt;
  arc: number;
  scan: [number, number];
}

const DESK: Geo = {
  bw: 9, bh: 30, neck: 6,
  slot: storySlot,
  order: ORDER_PATH,
  truckY: 306, truckDock: 40,
  crateFrom: { x: 96, y: 292 }, crateTo: { x: 262, y: 250 },
  flightTo: (i) => ({ x: 462 + i * 14, y: 290 }),
  arc: 46,
  scan: [236, 104],
};

const MOB: Geo = {
  bw: 14, bh: 40, neck: 7,
  slot: (i) => ({ x: 24 + (i % 13) * 24, y: i < 13 ? 220 : 294 }),
  order: [{ x: 180, y: 116 }, { x: 180, y: 80 }, { x: 94, y: 62 }],
  truckY: 390, truckDock: 22,
  crateFrom: { x: 70, y: 384 }, crateTo: { x: 180, y: 166 },
  flightTo: (i) => ({ x: 236 + i * 20, y: 424 }),
  arc: 60,
  scan: [168, 130],
};

/** Phones: the five steps use this share of the scroll, the rest is the finale. */
const MOB_END = 0.86;

/** Hood lines light up between 6% and 76% of a chapter. */
function hoodAt(j: number, n: number): number {
  return n <= 1 ? 0.06 : 0.06 + (j * 0.7) / (n - 1);
}

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [RouterLink, RevealDirective, BadgeComponent],
  templateUrl: './landing.component.html',
  styles: [`
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .lbl  { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 700; letter-spacing: .04em; }

    @keyframes dash { to { stroke-dashoffset: -24; } }
    .flow-line { animation: dash 1s linear infinite; }

    @keyframes pulse-ring { 0% { r: 5; opacity: .55; } 100% { r: 18; opacity: 0; } }
    .pulse { animation: pulse-ring 1.6s ease-out infinite; }

    /* calm direction: lit zone vs. quiet zones */
    .zone { transition: opacity .45s ease; }
    .zone-dim { opacity: .3; }
    .zone-box { transition: stroke .35s ease; }

    .btl { transition: opacity .25s ease, transform .3s cubic-bezier(.2,.8,.2,1);
           transform-box: fill-box; transform-origin: center bottom; }
    .btl rect { transition: fill .3s ease; }
    .btl-off { opacity: 0; transform: translateY(-10px) scale(.6); }

    @keyframes pop { 0% { transform: scale(.6); opacity: 0; } 60% { transform: scale(1.08); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
    .pop { animation: pop .4s cubic-bezier(.2,.8,.2,1) both; transform-box: fill-box; transform-origin: center; }

    .fade { transition: opacity .4s ease; }

    [appReveal] { opacity: 0; transform: translateY(16px); transition: opacity .6s ease, transform .6s ease; }
    [appReveal].is-visible { opacity: 1; transform: none; }

    .card-in  { opacity: 1; transform: none; pointer-events: auto; visibility: visible; transition-delay: .08s; }
    .card-out { opacity: 0; transform: translateY(8px); pointer-events: none; }

    /* ledger rows: always in the DOM, so nothing jumps when one appears */
    .lrow { transition: opacity .35s ease, transform .35s ease, background-color .3s ease; }
    .lrow-off { opacity: 0; transform: translateY(-4px); }

    @keyframes lineIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    .line-in { animation: lineIn .35s ease-out both; }

    @keyframes caret { 50% { opacity: 0; } }
    .caret { animation: caret 1s steps(1) infinite; }

    /* phones: the counter reacts to every stock change */
    @keyframes glow { 0% { opacity: .55; transform: scale(.85); } 100% { opacity: 0; transform: scale(1.25); } }
    .glow { animation: glow .9s ease-out both; transform-box: fill-box; transform-origin: center; }
    @keyframes bump { 0% { transform: scale(1); } 35% { transform: scale(1.18); } 100% { transform: scale(1); } }
    .bump { animation: bump .45s cubic-bezier(.2,.8,.2,1); transform-box: fill-box; transform-origin: left bottom; }

    /* phones: finale */
    @keyframes finIn { from { opacity: 0; } to { opacity: 1; } }
    .fin { animation: finIn .35s ease-out both; }
    @keyframes drop { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: none; } }
    .drop { animation: drop .45s cubic-bezier(.2,.8,.2,1) both; }

    @media (prefers-reduced-motion: reduce) {
      .flow-line, .pulse, .pop, .line-in, .caret, .glow, .bump, .fin, .drop { animation: none; }
      .zone, .btl, .lrow, .fade { transition: none; }
      [appReveal] { opacity: 1; transform: none; transition: none; }
    }
  `],
})
export class LandingComponent implements OnInit, AfterViewInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  private story = viewChild<ElementRef<HTMLElement>>('story');
  private stickyEl = viewChild<ElementRef<HTMLElement>>('stickyEl');
  private heroEl = viewChild<ElementRef<HTMLElement>>('heroEl');

  /** Height of the fixed nav (h-16). */
  private readonly NAV = 64;
  private readonly reduced =
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  readonly year = new Date().getFullYear();

  // =====================================================================
  // STORY CONTENT - one order of one product, five steps
  // =====================================================================

  readonly chapters: Chapter[] = [
    {
      step: '01 \u00b7 Order', title: 'The shelf runs low.',
      body: 'Corner Store is down to 4 bottles of Mineral water 0.5 L, so the seller orders 24. An order is only intent: it travels to head office, but no stock moves yet.',
      focus: ['shelf', 'hq'],
      hood: [
        { layer: 'UI', text: 'New order: 24 \u00d7 SKU-1001 for Corner Store' },
        { layer: 'RPC', text: 'create_order_with_items(p_object_id, p_items)' },
        { layer: 'SQL', text: 'INSERT INTO orders (status = PENDING) + order_items' },
        { layer: 'RLS', text: 'a seller may only order for their own store' },
      ],
    },
    {
      step: '02 \u00b7 Approval', title: 'Head office signs it off.',
      body: 'The admin sees the order as PENDING and approves it. The permission check lives in the database, not in a hidden button.',
      focus: ['hq'],
      hood: [
        { layer: 'UI', text: 'Approve order' },
        { layer: 'SQL', text: "UPDATE orders SET status = 'APPROVED'" },
        { layer: 'RLS', text: 'only role = ADMIN passes the update policy' },
        { layer: 'SQL', text: '.select() returns the row \u2014 proof it was written' },
      ],
    },
    {
      step: '03 \u00b7 Delivery', title: 'The truck brings reality.',
      body: 'The supplier delivers 22, not 24. Every line is counted at receiving and the difference needs a reason. The shelf goes from 4 to 26.',
      focus: ['dock', 'shelf'],
      hood: [
        { layer: 'UI', text: 'Confirm delivery: 22 of 24, reason given' },
        { layer: 'RPC', text: 'record_delivery(p_order_id, p_items) \u2014 one per order' },
        { layer: 'SQL', text: 'INSERT INTO stock_movements (DELIVERY, +22)' },
        { layer: 'TRIGGER', text: 'inventory.quantity 4 \u2192 26' },
        { layer: 'VIEW', text: 'order_fulfillment.variance = \u22122' },
      ],
    },
    {
      step: '04 \u00b7 Stock count', title: 'The shelf is the truth.',
      body: 'A physical count finds 25 where the system expects 26. The missing bottle becomes its own signed event, with a reason attached.',
      focus: ['shelf'],
      hood: [
        { layer: 'UI', text: 'Stock count: counted 25' },
        { layer: 'RPC', text: 'record_stock_count() re-reads expected = 26' },
        { layer: 'SQL', text: 'INSERT INTO stock_movements (STOCK_COUNT, \u22121, reason)' },
        { layer: 'TRIGGER', text: 'inventory.quantity 26 \u2192 25' },
      ],
    },
    {
      step: '05 \u00b7 Sale', title: 'A customer buys 3 bottles.',
      body: 'Three bottles leave through the checkout. The database refuses to sell what is not there, and the balance updates itself to 22.',
      focus: ['shelf', 'pos'],
      hood: [
        { layer: 'UI', text: 'Record sale: 3 \u00d7 SKU-1001' },
        { layer: 'SQL', text: 'INSERT INTO stock_movements (SALE, \u22123)' },
        { layer: 'TRIGGER', text: 'oversell check: 3 \u2264 25 on hand \u2713' },
        { layer: 'TRIGGER', text: 'inventory.quantity 25 \u2192 22' },
      ],
    },
  ];

  /** Ledger rows written by the story, in order. */
  readonly ledger: LedgerLine[] = [
    { chapter: 2, event: 'DELIVERY',    qty: 22, balance: 26, ref: 'delivery \u00b7 22 of 24, reason given', from: 0.5, at: 0.82 },
    { chapter: 3, event: 'STOCK_COUNT', qty: -1, balance: 25, ref: 'count \u00b7 1 bottle broken',           from: 0.5, at: 0.55 },
    { chapter: 4, event: 'SALE',        qty: -3, balance: 22, ref: 'checkout \u00b7 3 sold',                 from: 0.4, at: 0.74 },
  ];

  /** The closing equation - every term links back to the step that wrote it. */
  readonly recap: { value: string; label: string; note: string; cls: string; chapter: number | null }[] = [
    { value: '4',       label: 'Opening',   note: 'what was on the shelf', cls: 'text-slate-400', chapter: 0 },
    { value: '+22',     label: 'Delivered', note: '24 ordered, 2 short',   cls: 'text-green-600', chapter: 2 },
    { value: '\u22121', label: 'Counted',   note: '1 bottle broken',       cls: 'text-amber-600', chapter: 3 },
    { value: '\u22123', label: 'Sold',      note: 'at the checkout',       cls: 'text-red-600',   chapter: 4 },
    { value: '22',      label: 'On hand',   note: '~12 days left',         cls: 'text-brand-700', chapter: null },
  ];


  // =====================================================================
  // STORY STATE - driven by scroll
  // =====================================================================

  /** Raw scroll target vs. smoothed value shown on screen. */
  private target = 0;
  private current = 0;
  private raf = 0;
  private running = false;

  /** 0 -> 1 across the whole sticky story section. */
  readonly progress = signal(0);

  /** Below lg. Phones get their own scene, a merged bottom sheet and a finale. */
  readonly isMobile = signal(false);

  /** Progress through the five steps (phones keep the last stretch for the finale). */
  private readonly storyP = computed(() =>
    this.isMobile() ? clamp(this.progress() / MOB_END) : this.progress());

  /** Phones only: every row lands and the equation closes. */
  readonly finale = computed(() => this.isMobile() && this.progress() > MOB_END + 0.02);

  readonly chapter = computed(() =>
    Math.min(this.chapters.length - 1, Math.floor(this.storyP() * this.chapters.length)));

  /** 0 -> 1 inside the current chapter. */
  readonly local = computed(() => {
    const n = this.chapters.length;
    return clamp(this.storyP() * n - this.chapter());
  });

  on(i: number): boolean { return this.chapter() === i; }

  focus(z: Zone): boolean { return this.chapters[this.chapter()].focus.includes(z); }

  /** Moving pieces for one scene layout. Same timing, different coordinates. */
  private makeScene(g: Geo) {
    return {
      g,
      slots: Array.from({ length: 26 }, (_, i) => ({ i, ...g.slot(i) })),

      /** 01 order: one card travels to head office. */
      orderCard: computed<(Pt & { o: number }) | null>(() => {
        const c = this.chapter(), t = this.local();
        if (c !== 0 || t < 0.2 || t >= 0.8) return null;
        const p = quad(g.order, ease(clamp((t - 0.2) / 0.5)));
        return { ...p, o: t > 0.72 ? clamp((0.8 - t) / 0.08) : 1 };
      }),

      /** 03 delivery: truck docks, then leaves. */
      truckX: computed(() => {
        const c = this.chapter(), t = this.local();
        if (c !== 2) return -120;
        if (t < 0.86) return lerp(-110, g.truckDock, ease(clamp(t / 0.3)));
        return lerp(g.truckDock, -120, ease(clamp((t - 0.86) / 0.14)));
      }),

      /** 03 delivery: the crate goes from the dock to the shelf. */
      crate: computed<Pt | null>(() => {
        const c = this.chapter(), t = this.local();
        if (c !== 2 || t < 0.32 || t >= 0.52) return null;
        const k = ease(clamp((t - 0.32) / 0.2));
        return {
          x: lerp(g.crateFrom.x, g.crateTo.x, k),
          y: lerp(g.crateFrom.y, g.crateTo.y, k) - Math.sin(k * Math.PI) * 30,
        };
      }),

      /** 04 count: scanner sweeps the shelf. */
      scanY: computed<number | null>(() => {
        const c = this.chapter(), t = this.local();
        if (c !== 3 || t >= 0.32) return null;
        return g.scan[0] + clamp(t / 0.3) * g.scan[1];
      }),

      /** 05 sale: three bottles fly to the checkout. */
      flights: computed(() => {
        const n = this.flightsN(), t = this.local();
        const out: { i: number; x: number; y: number }[] = [];
        for (let i = 0; i < n; i++) {
          const k = ease(clamp((t - (0.4 + i * 0.07)) / 0.18));
          const from = g.slot(24 - i), to = g.flightTo(i);
          out.push({ i, x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k) - Math.sin(k * Math.PI) * g.arc });
        }
        return out;
      }),
    };
  }

  /** Bottles that have left the shelf during the sale (0-3). */
  private readonly flightsN = computed(() => {
    if (this.chapter() !== 4) return 0;
    const t = this.local();
    let n = 0;
    for (let i = 0; i < 3; i++) if (t >= 0.4 + i * 0.07) n++;
    return n;
  });

  readonly d = this.makeScene(DESK);
  readonly m = this.makeScene(MOB);

  readonly inboxFilled = computed(() => this.chapter() > 0 || this.local() >= 0.72);

  // ---------- 02 approval: status flips, confirmation appears ----------
  readonly approved = computed(() => this.chapter() > 1 || (this.chapter() === 1 && this.local() >= 0.45));

  readonly deliveryNote = computed(() => this.chapter() === 2 && this.local() >= 0.3);

  readonly reasonTag = computed(() => this.chapter() === 3 && this.local() >= 0.55);

  readonly saleTag = computed(() => this.chapter() === 4 && this.local() >= 0.74);

  // ---------- shelf, counter, ledger - always in sync ----------
  readonly balance = computed(() => {
    const c = this.chapter(), t = this.local();
    if (c < 2) return 4;
    if (c === 2) return Math.round(lerp(4, 26, clamp((t - 0.5) / 0.3)));
    if (c === 3) return t < 0.5 ? 26 : 25;
    return 25 - this.flightsN();
  });

  readonly lowStock = computed(() => this.balance() <= 10);

  bottleOn(i: number): boolean { return i < this.balance(); }

  bottleColor(i: number): Paint {
    const c = this.chapter(), t = this.local();
    if (c === 3 && t >= 0.3 && t < 0.5 && i === 25) return PAINT.count;
    if (c === 4 && t >= 0.15 && i >= 22 && i <= 24) return PAINT.sale;
    if (c === 2 && i >= 4) return PAINT.fresh;
    if (this.lowStock()) return PAINT.low;
    return PAINT.base;
  }

  /** Change chip next to the shelf counter - only while the current step changes stock. */
  readonly stockDelta = computed<SvgChip | null>(() => {
    const c = this.chapter(), t = this.local();
    const l = this.ledger.find((x) => x.chapter === c);
    if (!l || t < l.from) return null;
    const up = l.qty > 0, count = l.event === 'STOCK_COUNT';
    return {
      key: l.event,
      text: signed(l.qty),
      bg: up ? '#dcfce7' : count ? '#fef3c7' : '#fee2e2',
      fg: up ? '#15803d' : count ? '#b45309' : '#b91c1c',
    };
  }, { equal: (a, b) => a?.key === b?.key });

  readonly counterSub = computed(() => {
    const c = this.chapter(), t = this.local();
    if (c === 0 && t < 0.72) return 'Mineral water 0.5 L \u00b7 running low';
    if (c < 2) return '24 on order \u00b7 not on the shelf yet';
    return 'Mineral water 0.5 L \u00b7 SKU-1001';
  });

  /** Phones: shorter line under the counter (the box is narrower). */
  readonly counterSubM = computed(() => {
    const c = this.chapter(), t = this.local();
    if (c === 0 && t < 0.72) return 'running low';
    if (c < 2) return '24 on order';
    return 'SKU-1001';
  });

  /** Changes whenever a new stock change starts -> re-triggers the counter glow. */
  readonly deltaKey = computed(() => this.stockDelta()?.key ?? 'none');

  ledgerOn(l: LedgerLine): boolean {
    const c = this.chapter();
    return c > l.chapter || (c === l.chapter && this.local() >= l.at);
  }

  // ---------- under the hood ----------
  readonly hood = computed(() => this.chapters[this.chapter()].hood);

  /** Index of the line that is "executing" right now (-1 = none yet). */
  readonly hoodRun = computed(() => {
    const n = this.hood().length, t = this.local();
    let idx = -1;
    for (let j = 0; j < n; j++) if (t >= hoodAt(j, n)) idx = j;
    return idx;
  });

  readonly currentHood = computed(() => this.hood()[Math.max(0, this.hoodRun())]);

  /** Phones: the running hood line is typed out like a terminal. */
  readonly typed = signal(0);
  private typeRaf = 0;
  readonly typedText = computed(() => (this.currentHood()?.text ?? '').slice(0, this.typed()));
  readonly typing = computed(() => this.typed() < (this.currentHood()?.text.length ?? 0));
  private readonly hoodKey = computed(() => `${this.chapter()}:${this.hoodRun()}`);

  constructor() {
    effect(() => {
      this.hoodKey();
      const n = this.currentHood()?.text.length ?? 0;
      const mobile = this.isMobile();
      untracked(() => this.typeLine(n, mobile));
    });
  }

  private typeLine(n: number, mobile: boolean): void {
    if (typeof window === 'undefined') { this.typed.set(n); return; }
    cancelAnimationFrame(this.typeRaf);
    if (!mobile || this.reduced || !n) { this.typed.set(n); return; }
    this.typed.set(0);
    const t0 = performance.now();
    const dur = Math.min(900, 22 * n);
    const loop = (now: number) => {
      const k = Math.min(n, Math.ceil(((now - t0) / dur) * n));
      this.typed.set(k);
      if (k < n) this.typeRaf = requestAnimationFrame(loop);
    };
    this.typeRaf = requestAnimationFrame(loop);
  }

  hoodState(j: number): HoodState {
    const r = this.hoodRun();
    return j < r ? 'done' : j === r ? 'run' : 'todo';
  }

  hoodRow(s: HoodState): string {
    return s === 'run' ? 'bg-slate-800 ring-1 ring-white/10' : '';
  }

  hoodText(s: HoodState): string {
    return { run: 'text-white', done: 'text-slate-300', todo: 'text-slate-400' }[s];
  }

  layerClass(l: Layer): string {
    return {
      UI: 'bg-slate-700 text-slate-100',
      RPC: 'bg-indigo-500/20 text-indigo-300',
      SQL: 'bg-sky-500/20 text-sky-300',
      RLS: 'bg-rose-500/20 text-rose-300',
      TRIGGER: 'bg-amber-500/20 text-amber-300',
      VIEW: 'bg-emerald-500/20 text-emerald-300',
    }[l];
  }

  signed(n: number): string { return signed(n); }

  /** Same colour for an event everywhere: delivery green, count amber, sale red. */
  qtyClass(l: LedgerLine): string {
    return l.qty > 0 ? 'text-green-600' : l.event === 'STOCK_COUNT' ? 'text-amber-600' : 'text-red-600';
  }

  // =====================================================================
  // HERO - a small store that runs on its own, on a loop
  // =====================================================================

  /** ms inside the hero loop. */
  readonly heroT = signal(0);
  private heroRaf = 0;
  private heroRunning = false;
  private heroVisible = false;

  readonly heroSlots = Array.from({ length: 26 }, (_, i) => ({ i, ...heroSlot(i) }));

  readonly heroRows = [
    { event: 'OPENING',     qty: '\u2014',  balance: 4,  cls: 'text-slate-400' },
    { event: 'DELIVERY',    qty: '+22',     balance: 26, cls: 'text-green-600' },
    { event: 'STOCK_COUNT', qty: '\u22121', balance: 25, cls: 'text-amber-600' },
    { event: 'SALE',        qty: '\u22123', balance: 22, cls: 'text-red-600' },
  ];

  readonly hTruckX = computed(() => {
    const t = this.heroT();
    if (t < 700) return -80;
    if (t < 1900) return lerp(-80, 18, ease(span(t, 700, 1900)));
    if (t < 4000) return 18;
    if (t < 4800) return lerp(18, -80, ease(span(t, 4000, 4800)));
    return -80;
  });

  readonly hCrate = computed<Pt | null>(() => {
    const t = this.heroT();
    if (t < 1900 || t >= 2600) return null;
    const k = ease(span(t, 1900, 2600));
    return { x: lerp(46, 172, k), y: lerp(70, 50, k) - Math.sin(k * Math.PI) * 16 };
  });

  readonly hScan = computed<number | null>(() => {
    const t = this.heroT();
    if (t < 4400 || t >= 4900) return null;
    return 30 + span(t, 4400, 4900) * 86;
  });

  readonly hFlights = computed(() => {
    const t = this.heroT();
    if (t >= HERO_RESET) return [];
    const out: { i: number; x: number; y: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const start = 6500 + i * 220;
      if (t < start) continue;
      const k = ease(span(t, start, start + 500));
      const from = heroSlot(24 - i);
      const to = { x: 284 + i * 11, y: 96 };
      out.push({ i, x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k) - Math.sin(k * Math.PI) * 24 });
    }
    return out;
  });

  readonly hBalance = computed(() => {
    const t = this.heroT();
    if (t >= HERO_RESET) return 22;
    if (t < 2600) return 4;
    if (t < 3600) return Math.round(lerp(4, 26, span(t, 2600, 3600)));
    if (t < 5000) return 26;
    if (t < 6500) return 25;
    return 25 - this.hFlights().length;
  });

  readonly hLow = computed(() => this.hBalance() <= 10);
  readonly hFade = computed(() => this.heroT() >= HERO_RESET);

  heroBottleOn(i: number): boolean { return i < this.hBalance(); }

  heroBottleColor(i: number): Paint {
    const t = this.heroT();
    if (t >= 4600 && t < 5000 && i === 25) return PAINT.count;
    if (t >= 6000 && t < 7500 && i >= 22 && i <= 24) return PAINT.sale;
    if (t >= 2600 && t < 4400 && i >= 4) return PAINT.fresh;
    if (this.hLow()) return PAINT.low;
    return PAINT.base;
  }

  readonly hPhase = computed<HtmlChip>(() => {
    const t = this.heroT();
    if (t < 700 || t >= HERO_RESET) return { key: 'open', text: 'OPENING \u00b7 4', cls: 'bg-slate-100 text-slate-600' };
    if (t < 4400) return { key: 'del', text: 'DELIVERY +22', cls: 'bg-green-50 text-green-700 ring-1 ring-green-200' };
    if (t < 5900) return { key: 'cnt', text: 'STOCK_COUNT \u22121', cls: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200' };
    if (t < 7600) return { key: 'sale', text: 'SALE \u22123', cls: 'bg-red-50 text-red-700 ring-1 ring-red-200' };
    return { key: 'ok', text: 'RECONCILED \u00b7 22', cls: 'bg-brand-50 text-brand-700 ring-1 ring-brand-200' };
  }, { equal: (a, b) => a.key === b.key });

  readonly hDelta = computed<HtmlChip | null>(() => {
    const t = this.heroT();
    if (t >= 2600 && t < 4400) return { key: 'd', text: '+22', cls: 'bg-green-50 text-green-700' };
    if (t >= 5000 && t < 5900) return { key: 'c', text: '\u22121', cls: 'bg-amber-50 text-amber-700' };
    if (t >= 6500 && t < 7600) return { key: 's', text: '\u22123', cls: 'bg-red-50 text-red-700' };
    return null;
  }, { equal: (a, b) => a?.key === b?.key });

  hRowOn(k: number): boolean {
    const t = this.heroT();
    return k === 0 || (t >= HERO_ROW_AT[k] && t < HERO_RESET);
  }

  private readonly hLastRow = computed(() => {
    let r = 0;
    for (let k = 1; k < HERO_ROW_AT.length; k++) if (this.hRowOn(k)) r = k;
    return r;
  });

  hRowActive(k: number): boolean { return k > 0 && k === this.hLastRow(); }

  // =====================================================================
  // LIFECYCLE
  // =====================================================================

  ngOnInit(): void {
    if (this.auth.isLoggedIn()) this.router.navigateByUrl('/dashboard');
  }

  ngAfterViewInit(): void {
    if (typeof window === 'undefined') return;

    // ---------- story: only animate while it is on screen ----------
    const section = this.story()?.nativeElement;
    if (section && typeof IntersectionObserver !== 'undefined') {
      const io = new IntersectionObserver(([e]) => {
        if (e.isIntersecting) this.start(); else this.stop();
      });
      io.observe(section);
      this.destroyRef.onDestroy(() => io.disconnect());
    } else {
      this.start();
    }

    // ---------- phone vs. desktop layout ----------
    const mq = window.matchMedia?.('(max-width: 1023.98px)');
    if (mq) {
      const onMq = () => this.isMobile.set(mq.matches);
      onMq();
      mq.addEventListener('change', onMq);
      this.destroyRef.onDestroy(() => mq.removeEventListener('change', onMq));
    }

    const onScroll = () => { this.target = this.readProgress(); this.start(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    // ---------- hero: loop only while visible and the tab is active ----------
    if (this.reduced) {
      this.heroT.set(9000);   // static final frame: 22 on the shelf, every row written
    } else {
      const hero = this.heroEl()?.nativeElement;
      if (hero && typeof IntersectionObserver !== 'undefined') {
        const hio = new IntersectionObserver(([e]) => { this.heroVisible = e.isIntersecting; this.syncHero(); });
        hio.observe(hero);
        this.destroyRef.onDestroy(() => hio.disconnect());
      } else {
        this.heroVisible = true;
        this.syncHero();
      }
      document.addEventListener('visibilitychange', this.onVisibility);
    }

    this.destroyRef.onDestroy(() => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.stop();
      this.stopHero();
      cancelAnimationFrame(this.typeRaf);
    });

    this.target = this.current = this.readProgress();
    this.progress.set(this.current);
  }

  // ---------- story scroll loop ----------

  /** 0 -> 1 based on how far the sticky stage has travelled through the section. */
  private readProgress(): number {
    const section = this.story()?.nativeElement;
    const sticky = this.stickyEl()?.nativeElement;
    if (!section || !sticky) return 0;
    const travel = section.offsetHeight - sticky.offsetHeight;
    if (travel <= 0) return 0;
    return clamp((this.NAV - section.getBoundingClientRect().top) / travel);
  }

  /** Eases the displayed progress toward the scroll position (absorbs iOS momentum jumps). */
  private start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      const diff = this.target - this.current;
      this.current = this.reduced || Math.abs(diff) < 0.0004 ? this.target : this.current + diff * 0.14;
      this.progress.set(this.current);
      if (this.current === this.target) { this.running = false; return; }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    this.running = false;
  }

  // ---------- hero loop ----------

  private onVisibility = () => this.syncHero();

  private syncHero(): void {
    if (this.heroVisible && !document.hidden) this.startHero();
    else this.stopHero();
  }

  private startHero(): void {
    if (this.heroRunning) return;
    this.heroRunning = true;
    const base = performance.now() - this.heroT();   // resume where it paused
    const loop = (now: number) => {
      this.heroT.set((now - base) % HERO_LOOP);
      this.heroRaf = requestAnimationFrame(loop);
    };
    this.heroRaf = requestAnimationFrame(loop);
  }

  private stopHero(): void {
    cancelAnimationFrame(this.heroRaf);
    this.heroRunning = false;
  }

  // ---------- navigation ----------

  /** Rail segment / recap term -> scroll to that step. */
  goTo(i: number): void {
    const section = this.story()?.nativeElement;
    const sticky = this.stickyEl()?.nativeElement;
    if (!section || !sticky) return;
    const travel = section.offsetHeight - sticky.offsetHeight;
    const sectionTop = section.getBoundingClientRect().top + window.scrollY;
    const share = this.isMobile() ? MOB_END : 1;
    const top = sectionTop - this.NAV + travel * share * ((i + 0.3) / this.chapters.length);
    window.scrollTo({ top, behavior: this.reduced ? 'auto' : 'smooth' });
  }

  scrollTo(event: Event, id: string): void {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: this.reduced ? 'auto' : 'smooth', block: 'start' });
  }
}

function clamp(v: number, lo = 0, hi = 1): number { return Math.min(hi, Math.max(lo, v)); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function ease(t: number): number { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function span(t: number, a: number, b: number): number { return clamp((t - a) / (b - a)); }
function signed(n: number): string { return n > 0 ? `+${n}` : n < 0 ? `\u2212${Math.abs(n)}` : '0'; }
function quad([a, b, c]: [Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * b.x + t * t * c.x, y: u * u * a.y + 2 * u * t * b.y + t * t * c.y };
}
