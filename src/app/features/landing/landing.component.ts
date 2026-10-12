import {
  AfterViewInit, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { RevealDirective } from '../../shared/ui/reveal.directive';
import { BadgeComponent } from '../../shared/ui/badge.component';

/** Camera keyframe on the warehouse map: focus point + zoom. */
interface Cam { x: number; y: number; s: number; }

interface Chapter {
  step: string;
  title: string;
  /** Short version shown on phones. */
  short: string;
  /** Mobile camera (tighter zoom — the stage is small). */
  mcam: Cam;
  hood: HoodStep[];
  body: string;
  cam: Cam;
}

/** One step of what the system actually does underneath a chapter. */
interface HoodStep { layer: 'UI' | 'RPC' | 'SQL' | 'RLS' | 'TRIGGER' | 'VIEW'; text: string; }

interface LedgerLine { chapter: number; event: string; qty: number; balance: number; ref: string; }

const MAP_W = 1200;
const MAP_H = 700;

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [RouterLink, RevealDirective, BadgeComponent],
  templateUrl: './landing.component.html',
  styles: [`
    @keyframes dash { to { stroke-dashoffset: -24; } }
    .flow-line { stroke-dasharray: 6 6; animation: dash 1s linear infinite; }
    @keyframes pulse-ring { 0% { r: 14; opacity: .5; } 100% { r: 40; opacity: 0; } }
    .pulse { animation: pulse-ring 1.6s ease-out infinite; }
    [appReveal] { opacity: 0; transform: translateY(16px); transition: opacity .6s ease, transform .6s ease; }
    [appReveal].is-visible { opacity: 1; transform: none; }
    .card-in  { opacity: 1; transform: none; pointer-events: auto; visibility: visible;
                transition-delay: .08s; }
    .card-out { opacity: 0; transform: translateY(8px); pointer-events: none; }
    @keyframes rowIn { from { opacity: 0; transform: translateY(-4px); background: #eef2ff; } to { opacity: 1; transform: none; } }
    .row-in { animation: rowIn .5s ease-out; }
    @media (prefers-reduced-motion: reduce) {
      .flow-line, .pulse, .row-in { animation: none; }
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
  private mapBox = viewChild<ElementRef<HTMLElement>>('mapBox');

  /** Height of the fixed nav (h-16). */
  private readonly NAV = 64;
  private readonly reduced =
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /** Map box aspect ratio + viewport width — drive the camera fit. */
  private readonly aspect = signal(1.6);
  private readonly vw = signal(typeof window !== 'undefined' ? window.innerWidth : 1280);
  readonly isMobile = computed(() => this.vw() < 1024);

  /** Raw scroll target vs. smoothed value shown on screen. */
  private target = 0;
  private current = 0;
  private raf = 0;
  private running = false;

  readonly year = new Date().getFullYear();

  /** The whole story — one order of one product, start to finish. */
  readonly chapters: Chapter[] = [
    { step: '01 · Order', title: 'The shelf runs low.',
      body: 'Corner Store has 4 bottles of Mineral water 0.5 L left. The seller orders 24. An order is only intent — no stock moves yet.',
      short: 'Only 4 bottles left. The shop orders 24 more in Stockflow.',
      mcam: { x: 760, y: 290, s: 2.6 },
      cam: { x: 840, y: 320, s: 2.1 },
      hood: [
        { layer: 'UI', text: 'New order → 24 × SKU-1001' },
        { layer: 'RPC', text: 'create_order_with_items()' },
        { layer: 'SQL', text: 'orders · status = PENDING' },
        { layer: 'RLS', text: 'seller may only order for own store' },
      ] },
    { step: '02 · Approval', title: 'HQ signs it off.',
      body: 'The admin sees the order arrive as PENDING and approves it. Permission is enforced in the database, not by hiding a button.',
      short: 'Head office checks the order and approves it.',
      mcam: { x: 640, y: 210, s: 2.8 },
      cam: { x: 600, y: 150, s: 2.3 },
      hood: [
        { layer: 'UI', text: 'Approve' },
        { layer: 'SQL', text: 'UPDATE orders SET status = APPROVED' },
        { layer: 'RLS', text: 'only ADMIN passes the policy' },
        { layer: 'SQL', text: '.select() proves the row was written' },
      ] },
    { step: '03 · Delivery', title: 'The truck brings reality.',
      body: 'The supplier delivers 22, not 24. Every line is counted at the dock and the difference needs a reason. What was ordered is never overwritten.',
      short: 'The supplier brings 22 instead of 24. The shop records exactly what arrived.',
      mcam: { x: 380, y: 450, s: 2.6 },
      cam: { x: 380, y: 450, s: 1.45 },
      hood: [
        { layer: 'UI', text: 'Confirm delivery · 22 of 24' },
        { layer: 'RPC', text: 'record_delivery() — one per order' },
        { layer: 'SQL', text: 'stock_movements · DELIVERY +22' },
        { layer: 'TRIGGER', text: 'inventory 4 → 26' },
        { layer: 'VIEW', text: 'order_fulfillment · variance −2' },
      ] },
    { step: '04 · Stock count', title: 'The shelf is the truth.',
      body: 'A physical count finds 25 where the system expects 26. The gap becomes its own signed event — corrected, never hidden.',
      short: 'Someone counts the shelf: 25, not 26. Stockflow records the difference.',
      mcam: { x: 822, y: 345, s: 3.3 },
      cam: { x: 840, y: 320, s: 2.5 },
      hood: [
        { layer: 'UI', text: 'Stock count · counted 25' },
        { layer: 'RPC', text: 'record_stock_count() re-reads expected' },
        { layer: 'SQL', text: 'stock_movements · STOCK_COUNT −1' },
        { layer: 'TRIGGER', text: 'inventory 26 → 25' },
      ] },
    { step: '05 · Sale', title: 'A customer buys 3 bottles.',
      body: 'A customer buys three bottles at the checkout. The database refuses to sell what is not there, and the balance updates itself.',
      short: 'A customer buys 3 bottles at the checkout. The shelf drops to 22.',
      mcam: { x: 1060, y: 450, s: 3.1 },
      cam: { x: 1060, y: 460, s: 2.3 },
      hood: [
        { layer: 'UI', text: 'Record movement · SALE 3' },
        { layer: 'SQL', text: 'stock_movements · SALE −3' },
        { layer: 'TRIGGER', text: 'oversell check 3 ≤ 25 ✓' },
        { layer: 'TRIGGER', text: 'inventory 25 → 22' },
      ] },
    { step: '06 · Runway', title: 'And it knows what comes next.',
      body: 'From real sales over the last 30 days Stockflow calculates how many days the shelf will last — and flags it before it is empty again.',
      short: 'Based on sales, the water lasts about 12 more days. Time to reorder.',
      mcam: { x: 830, y: 390, s: 1.75 },
      cam: { x: 600, y: 350, s: 1 },
      hood: [
        { layer: 'SQL', text: 'SALE movements · last 30 days' },
        { layer: 'VIEW', text: 'rate = 54 sold / 30 d = 1.8 / day' },
        { layer: 'VIEW', text: 'days left = 22 / 1.8 ≈ 12' },
        { layer: 'UI', text: 'Reorder soon (≤ 14 days)' },
      ] },
  ];

  /** Ledger rows written by the story, in order. */
  readonly ledger: LedgerLine[] = [
    { chapter: 2, event: 'DELIVERY',    qty: +22, balance: 26, ref: 'delivery · short 2, reason given' },
    { chapter: 3, event: 'STOCK_COUNT', qty: -1,  balance: 25, ref: 'count · 1 bottle broken' },
    { chapter: 4, event: 'SALE',        qty: -3,  balance: 22, ref: 'checkout · 3 sold' },
  ];

  // ---------- scroll state ----------
  /** 0 → 1 across the whole sticky story section. */
  readonly progress = signal(0);

  readonly chapter = computed(() =>
    Math.min(this.chapters.length - 1, Math.floor(this.progress() * this.chapters.length))
  );
  /** 0 → 1 inside the current chapter. */
  readonly local = computed(() => {
    const n = this.chapters.length;
    return Math.min(1, Math.max(0, this.progress() * n - this.chapter()));
  });

  /** Camera for a chapter. On phones the delivery shot follows the truck. */
  private camFor(i: number): Cam {
    const c = this.chapters[i];
    if (!this.isMobile()) return c.cam;
    if (i === 2) return { x: this.truckX() + 40, y: 445, s: c.mcam.s };
    return c.mcam;
  }

  /**
   * The "camera" is an animated SVG viewBox. The focus area (MAP / s) is
   * always fully visible: we expand it to the box's aspect ratio ("contain"),
   * so nothing important is ever cropped on a tall or narrow screen.
   * The move to the next shot happens in the last 35% of each chapter, so
   * the camera is already there when the next chapter's text appears.
   */
  readonly viewBox = computed(() => {
    const i = this.chapter();
    const a = this.camFor(i);
    const b = this.camFor(Math.min(i + 1, this.chapters.length - 1));
    const k = ease(clamp((this.local() - 0.65) / 0.35));
    const x = lerp(a.x, b.x, k), y = lerp(a.y, b.y, k), s = lerp(a.s, b.s, k);
    const fw = MAP_W / s, fh = MAP_H / s, ar = this.aspect();
    let w = fw, h = fh;
    if (fw / fh > ar) h = fw / ar; else w = fh * ar;
    return `${(x - w / 2).toFixed(1)} ${(y - h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`;
  });

  /** Truck drives supplier → dock during chapter 3. */
  readonly truckX = computed(() => {
    const c = this.chapter();
    if (c < 2) return 170;
    if (c > 2) return 470;
    return lerp(170, 470, ease(clamp(this.local() / 0.6)));
  });

  /** Order packet flies store → HQ in ch.1, approval flies back in ch.2. */
  readonly packet = computed(() => {
    const c = this.chapter(), t = this.local();
    const store = { x: 800, y: 270 }, hq = { x: 600, y: 150 };
    if (c === 0) { const k = ease(clamp((t - 0.3) / 0.6)); return { x: lerp(store.x, hq.x, k), y: lerp(store.y, hq.y, k), show: t > 0.3 }; }
    if (c === 1) { const k = ease(clamp((t - 0.5) / 0.45)); return { x: lerp(hq.x, store.x, k), y: lerp(hq.y, store.y, k), show: t > 0.5 }; }
    return { x: 0, y: 0, show: false };
  });

  readonly approved = computed(() => this.chapter() > 1 || (this.chapter() === 1 && this.local() > 0.45));

  /** Units on the shelf at this point of the story. */
  readonly balance = computed(() => {
    const c = this.chapter();
    if (c < 2) return 4;
    if (c === 2) return this.local() > 0.6 ? 26 : 4;
    if (c === 3) return this.local() > 0.5 ? 25 : 26;
    if (c === 4) return this.local() > 0.4 ? 22 : 25;
    return 22;
  });

  /** One box glyph per 2 units, laid out on a 3-shelf rack. */
  readonly boxes = computed(() => {
    const n = Math.ceil(this.balance() / 2);
    return Array.from({ length: n }, (_, i) => ({
      x: 772 + (i % 5) * 20,
      y: 352 - Math.floor(i / 5) * 34,
    }));
  });

  readonly visibleLedger = computed(() =>
    this.ledger.filter((l) => this.chapter() > l.chapter || (this.chapter() === l.chapter && this.local() > 0.5))
  );

  /** Change shown next to the shelf counter — only during the chapter that caused it. */
  readonly stockDelta = computed(() => {
    const l = this.visibleLedger().at(-1);
    return l && l.chapter === this.chapter() ? l.qty : 0;
  });

  readonly lastLedger = computed(() => this.visibleLedger().slice(-1));

  readonly hood = computed(() => this.chapters[this.chapter()].hood);
  /** Last lit step — the one line shown on phones. */
  readonly currentHood = computed(() => {
    const steps = this.hood();
    let idx = 0;
    steps.forEach((_, j) => { if (this.stepLit(j)) idx = j; });
    return steps[idx];
  });

  readonly lowStock = computed(() => this.balance() <= 10);

  ngOnInit(): void {
    if (this.auth.isLoggedIn()) this.router.navigateByUrl('/dashboard');
  }

  ngAfterViewInit(): void {
    if (typeof window === 'undefined') return;

    // Fit the camera to the real size of the map box.
    const box = this.mapBox()?.nativeElement;
    if (box && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(([e]) => {
        const { width, height } = e.contentRect;
        if (width > 0 && height > 0) this.aspect.set(width / height);
        this.vw.set(window.innerWidth);
      });
      ro.observe(box);
      this.destroyRef.onDestroy(() => ro.disconnect());
    }

    // Only animate while the story is on screen.
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

    const onScroll = () => { this.target = this.readProgress(); this.start(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      this.stop();
    });

    this.target = this.current = this.readProgress();
    this.progress.set(this.current);
  }

  /** 0 → 1 based on how far the sticky stage has travelled through the section. */
  private readProgress(): number {
    const section = this.story()?.nativeElement;
    const sticky = this.stickyEl()?.nativeElement;
    if (!section || !sticky) return 0;
    const travel = section.offsetHeight - sticky.offsetHeight;
    if (travel <= 0) return 0;
    return clamp((this.NAV - section.getBoundingClientRect().top) / travel);
  }

  /**
   * rAF loop that eases the displayed progress toward the scroll position.
   * Absorbs iOS momentum / address-bar jumps → no stutter, no skipped frames.
   */
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

  /** Tap a rail segment / table-of-contents entry → scroll to that chapter. */
  goTo(i: number): void {
    const section = this.story()?.nativeElement;
    const sticky = this.stickyEl()?.nativeElement;
    if (!section || !sticky) return;
    const travel = section.offsetHeight - sticky.offsetHeight;
    const sectionTop = section.getBoundingClientRect().top + window.scrollY;
    const top = sectionTop - this.NAV + travel * ((i + 0.3) / this.chapters.length);
    window.scrollTo({ top, behavior: this.reduced ? 'auto' : 'smooth' });
  }

  /** Hood steps light up one after another while scrolling a chapter. */
  stepLit(j: number): boolean {
    // spread steps over 5%–60% of the chapter, before the camera starts moving
    const n = this.hood().length;
    const at = n <= 1 ? 0.05 : 0.05 + (j * 0.55) / (n - 1);
    return this.local() >= at;
  }

  layerClass(l: HoodStep['layer']): string {
    return {
      UI: 'bg-slate-100 text-slate-700',
      RPC: 'bg-indigo-50 text-indigo-700',
      SQL: 'bg-sky-50 text-sky-700',
      RLS: 'bg-rose-50 text-rose-700',
      TRIGGER: 'bg-amber-50 text-amber-700',
      VIEW: 'bg-emerald-50 text-emerald-700',
    }[l];
  }

  on(i: number): boolean { return this.chapter() === i; }

  scrollTo(event: Event, id: string): void {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  readonly features = [
    { title: 'Semantic immutable ledger', icon: 'M4 7h16M4 12h16M4 17h10',
      body: 'Every change is an append-only event with meaning — DELIVERY, SALE, COUNT, ADJUSTMENT. The stock number always has a why.' },
    { title: 'Delivery reconciliation', icon: 'M3 7h13l3 3v7h-2M3 7v10h2M8 17h6M5 17a2 2 0 1 0 4 0M14 17a2 2 0 1 0 4 0',
      body: 'Orders record intent, deliveries record reality. Short and over surface as chips, with the reason attached.' },
    { title: 'Physical stock count', icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
      body: 'Reconcile the shelf against the system. A server-side re-read at submit protects against mid-count deliveries.' },
    { title: 'Smart stock runway', icon: 'M3 3v18h18M7 15l4-4 3 3 5-6',
      body: 'Days-of-stock from real sales velocity, most-at-risk first — and an honest "no recent sales" instead of a made-up number.' },
  ];

  readonly stack = ['Angular 20', 'TypeScript', 'Tailwind CSS v4', 'Supabase', 'PostgreSQL', 'Row Level Security', 'Vercel'];
}

function clamp(v: number, lo = 0, hi = 1): number { return Math.min(hi, Math.max(lo, v)); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function ease(t: number): number { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
