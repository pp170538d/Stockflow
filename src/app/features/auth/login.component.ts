import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

/** One beat of the looping story. Step 0 is the opening balance. */
interface Beat {
  event: string;
  label: string;
  qty: number;        // signed change
  balance: number;    // balance after the beat
  note: string;
  tone: 'slate' | 'green' | 'amber' | 'red';
}

const BEATS: Beat[] = [
  { event: 'OPENING',     label: 'Opening',   qty: 0,   balance: 4,  note: 'shelf runs low',      tone: 'slate' },
  { event: 'DELIVERY',    label: 'Delivered', qty: 22,  balance: 26, note: '24 ordered, 2 short', tone: 'green' },
  { event: 'STOCK_COUNT', label: 'Counted',   qty: -1,  balance: 25, note: '1 bottle broken',     tone: 'amber' },
  { event: 'SALE',        label: 'Sold',      qty: -3,  balance: 22, note: 'at the checkout',     tone: 'red' },
];
const BEAT_MS = 2200;   // time per beat
const HOLD_MS = 2600;   // pause on the final "= 22" before the loop restarts
const SLOTS = 26;       // 1 bottle = 1 unit; max balance in the story is 26
const MARK_MS = 650;    // how long leaving bottles stay highlighted before they go
const UNIT_MS = 55;     // one bottle per tick when stock changes

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, NgTemplateOutlet],
  templateUrl: './login.component.html',
  styles: [`
    .bottle { transition: transform .3s cubic-bezier(.2,.8,.2,1), opacity .25s ease; }
    .bottle > div { transition: background-color .35s ease; }
    .bottle-off { transform: translateY(-12px) scale(.5); opacity: 0; }
    @keyframes pop { 0% { transform: scale(.85); opacity: 0; } 60% { transform: scale(1.06); opacity: 1; } 100% { transform: scale(1); } }
    .pop { animation: pop .45s ease-out both; }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .rise { animation: rise .5s ease-out both; }
    @keyframes scan { 0% { top: 6%; opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { top: 88%; opacity: 0; } }
    .scan { animation: scan 1.4s ease-in-out both; }
    .term { transition: opacity .35s ease, transform .35s ease, background-color .35s ease, color .35s ease; }
    @media (prefers-reduced-motion: reduce) {
      .bottle, .term { transition: none; }
      .pop, .rise, .scan { animation: none; }
    }
  `],
})
export class LoginComponent implements OnInit, OnDestroy {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);

  readonly loading = signal(false);
  readonly demoLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly showPassword = signal(false);
  /** Phones: sign-in form collapsed until asked for. */
  readonly showForm = signal(false);

  readonly demoEmail = 'demo@stockflow.com';
  readonly demoPassword = 'demo1234';

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  // ---------- looping story ----------
  readonly beats = BEATS;
  readonly slots = Array.from({ length: SLOTS }, (_, i) => i);
  /** Index of the current beat (0..3). */
  readonly step = signal(0);
  /** Bumps on every beat → re-triggers one-shot animations via @for track. */
  readonly tick = signal(0);
  /** Displayed (tweened) number on the shelf. */
  readonly shown = signal(BEATS[0].balance);
  /** True while holding on the final result. */
  readonly done = signal(false);

  readonly beat = computed(() => BEATS[this.step()]);
  /** Bottles about to leave (count / sale) are highlighted first. */
  readonly marked = signal<{ from: number; to: number; tone: 'amber' | 'red' } | null>(null);
  /** Bottles that just arrived (delivery) glow green for the beat. */
  readonly arrivedFrom = signal<number | null>(null);
  readonly low = computed(() => this.shown() <= 10);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private reduced = false;

  ngOnInit(): void {
    this.reduced = typeof window !== 'undefined'
      && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (this.reduced) {
      this.step.set(BEATS.length - 1);
      this.shown.set(BEATS.at(-1)!.balance);
      this.done.set(true);
      return;
    }
    this.schedule(1100);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVis);
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVis);
  }

  /** Pause the loop in a background tab, resume when visible. */
  private onVis = () => {
    if (document.hidden) { if (this.timer) clearTimeout(this.timer); this.timer = null; }
    else if (!this.timer) this.schedule(600);
  };

  private schedule(ms: number): void {
    this.timer = setTimeout(() => this.advance(), ms);
  }

  private advance(): void {
    if (this.done()) {
      // restart the loop
      this.done.set(false);
      this.step.set(0);
      this.tick.update((t) => t + 1);
      cancelAnimationFrame(this.raf);
      this.marked.set(null);
      this.arrivedFrom.set(null);
      this.shown.set(BEATS[0].balance);
      this.schedule(BEAT_MS);
      return;
    }
    const next = this.step() + 1;
    if (next >= BEATS.length) {
      this.done.set(true);
      this.tick.update((t) => t + 1);
      this.schedule(HOLD_MS);
      return;
    }
    const prev = BEATS[next - 1].balance;
    const b = BEATS[next];
    this.step.set(next);
    this.tick.update((t) => t + 1);
    this.arrivedFrom.set(null);
    if (b.qty > 0) {
      // delivery: bottles arrive one by one, in green
      this.marked.set(null);
      this.arrivedFrom.set(prev);
      this.tween(b.balance);
    } else {
      // count / sale: highlight exactly the bottles that leave, then take them off one by one
      this.marked.set({ from: b.balance, to: prev, tone: b.tone === 'amber' ? 'amber' : 'red' });
      this.timer = setTimeout(() => {
        this.tween(b.balance);
        this.schedule(BEAT_MS);
      }, MARK_MS);
      return;
    }
    this.schedule(next === BEATS.length - 1 ? BEAT_MS * 0.9 : BEAT_MS);
  }

  /** Count the shelf number up/down instead of jumping. */
  private tween(to: number): void {
    cancelAnimationFrame(this.raf);
    const from = this.shown();
    const start = performance.now();
    const steps = Math.abs(to - from);
    const dir = Math.sign(to - from);
    const loop = (now: number) => {
      const n = Math.min(steps, Math.floor((now - start) / UNIT_MS) + 1);
      this.shown.set(from + dir * n);
      if (n < steps) this.raf = requestAnimationFrame(loop);
      else if (dir < 0) this.marked.set(null);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Colour of bottle s: green = just delivered, amber/red = about to leave. */
  bottleColor(s: number): { body: string; neck: string } {
    const m = this.marked();
    if (m && s >= m.from && s < m.to) {
      return m.tone === 'amber' ? { body: '#fbbf24', neck: '#d97706' } : { body: '#f87171', neck: '#dc2626' };
    }
    const a = this.arrivedFrom();
    if (a !== null && s >= a && !this.done()) return { body: '#4ade80', neck: '#16a34a' };
    if (this.low()) return { body: '#fca5a5', neck: '#ef4444' };
    return { body: '#818cf8', neck: '#4f46e5' };
  }

  /** Equation term i is visible once its beat has happened. */
  termOn(i: number): boolean { return this.done() || i <= this.step(); }
  termActive(i: number): boolean { return !this.done() && i === this.step(); }

  signed(n: number): string {
    return n > 0 ? `+${n}` : n < 0 ? `\u2212${Math.abs(n)}` : '';
  }

  toneText(t: Beat['tone']): string {
    return { slate: 'text-slate-500', green: 'text-green-600', amber: 'text-amber-600', red: 'text-red-600' }[t];
  }
  toneChip(t: Beat['tone']): string {
    return {
      slate: 'bg-slate-100 text-slate-600',
      green: 'bg-green-50 text-green-700 ring-1 ring-green-200',
      amber: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
      red: 'bg-red-50 text-red-700 ring-1 ring-red-200',
    }[t];
  }

  // ---------- auth ----------
  async submit(): Promise<void> {
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    this.loading.set(true);
    this.error.set(null);
    const { email, password } = this.form.getRawValue();
    const err = await this.auth.login(email, password);
    this.loading.set(false);
    if (err) this.error.set(err);
    else this.router.navigateByUrl('/dashboard');
  }

  async useDemo(): Promise<void> {
    this.demoLoading.set(true);
    this.error.set(null);
    const err = await this.auth.login(this.demoEmail, this.demoPassword);
    this.demoLoading.set(false);
    if (err) this.error.set('The demo is unavailable right now. Please try again in a minute.');
    else this.router.navigateByUrl('/dashboard');
  }
}
