import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  FormArray, FormBuilder, FormGroup, ReactiveFormsModule, Validators,
  AbstractControl, ValidationErrors,
} from '@angular/forms';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { StockCountService } from './stock-count.service';
import { StockCountLineInput } from './stock-count.model';
import { BusinessObject } from '../objects/object.model';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';

type View = 'all' | 'todo' | 'diff';

interface LineValue {
  expected_qty: number;
  counted_qty: number | null;
}

/** A reason is required whenever counted ≠ expected (mirrors the DB rule). */
function reasonRequiredOnVariance(group: AbstractControl): ValidationErrors | null {
  const expected = group.get('expected_qty')?.value ?? 0;
  const counted = group.get('counted_qty')?.value;
  const reason = (group.get('reason')?.value ?? '').trim();
  if (counted !== null && counted !== '' && Number(counted) !== expected && !reason) {
    return { reasonRequired: true };
  }
  return null;
}

@Component({
  selector: 'app-stock-count',
  standalone: true,
  imports: [ReactiveFormsModule, EmptyStateComponent],
  templateUrl: './stock-count.component.html',
  styles: [`
    @keyframes rowIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .row-in { animation: rowIn .45s cubic-bezier(.2,.8,.2,1) backwards; }

    @keyframes pop { 0% { transform: scale(.6); opacity: 0; } 60% { transform: scale(1.12); } 100% { transform: scale(1); opacity: 1; } }
    .pop { animation: pop .3s cubic-bezier(.2,.8,.2,1); }

    /* hide native number spinners — we have real +/- buttons */
    input[type=number]::-webkit-outer-spin-button,
    input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    input[type=number] { -moz-appearance: textfield; }

    .sk { position: relative; overflow: hidden; background: #f1f5f9; border-radius: .5rem; }
    .sk::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.7), transparent);
      animation: shimmer 1.3s infinite; }
    @keyframes shimmer { 100% { transform: translateX(100%); } }

    @media (prefers-reduced-motion: reduce) {
      .row-in, .pop, .sk::after { animation: none; }
    }
  `],
})
export class StockCountComponent implements OnInit {
  private fb = inject(FormBuilder);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  readonly svc = inject(StockCountService);
  readonly auth = inject(AuthService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly objects = signal<BusinessObject[]>([]);
  readonly objectId = signal<string | null>(null);
  readonly objectName = signal<string>('');
  readonly search = signal('');
  readonly view = signal<View>('all');
  readonly building = signal(false);

  readonly isAdmin = computed(() => this.auth.isAdmin());

  readonly form: FormGroup = this.fb.group({
    counted_by: [''],
    note: [''],
    lines: this.fb.array([]),
  });

  private readonly formValue = toSignal(this.form.valueChanges, { initialValue: this.form.value });

  get lines(): FormArray {
    return this.form.get('lines') as FormArray;
  }

  /**
   * A person's display name for the audit trail. Prefer full_name; if that's
   * empty, fall back to the part of the email before "@".
   */
  private displayName(): string {
    const p = this.auth.profile();
    const full = (p?.full_name ?? '').trim();
    if (full) return full;
    const email = (p?.email ?? '').trim();
    if (email.includes('@')) return email.split('@')[0];
    return email;
  }

  async ngOnInit(): Promise<void> {
    this.form.patchValue({ counted_by: this.displayName() });

    const paramObject = this.route.snapshot.queryParamMap.get('object');

    if (this.isAdmin()) {
      const { data } = await supabase.from('objects').select('*').eq('active', true).order('name');
      this.objects.set((data ?? []) as BusinessObject[]);
      const chosen = this.objects().find((o) => o.id === paramObject)?.id ?? this.objects()[0]?.id ?? null;
      if (chosen) await this.selectObject(chosen);
    } else {
      const own = this.auth.profile()?.object_id ?? null;
      if (own) await this.selectObject(own);
    }
  }

  async selectObject(objectId: string): Promise<void> {
    this.objectId.set(objectId);
    this.objectName.set(this.objects().find((o) => o.id === objectId)?.name ?? '');
    this.view.set('all');
    await this.build(objectId);
  }

  /** Every line starts EMPTY — nothing counts until someone actually counts it. */
  private async build(objectId: string): Promise<void> {
    this.building.set(true);
    await this.svc.loadCountable(objectId);
    this.lines.clear();
    for (const r of this.svc.countable()) {
      this.lines.push(
        this.fb.group(
          {
            product_id: [r.product_id],
            product_name: [r.name],
            product_sku: [r.sku],
            category: [(r as any).category ?? ''],
            expected_qty: [r.expected_qty],
            counted_qty: [null as number | null, [Validators.required, Validators.min(0)]],
            reason: [''],
          },
          { validators: reasonRequiredOnVariance }
        )
      );
    }
    this.building.set(false);
  }

  // ---------- row helpers ----------
  isCounted(row: AbstractControl): boolean {
    const v = row.get('counted_qty')?.value;
    return v !== null && v !== '' && v !== undefined;
  }

  variance(row: AbstractControl): number {
    if (!this.isCounted(row)) return 0;
    return Number(row.get('counted_qty')?.value) - (row.get('expected_qty')?.value ?? 0);
  }

  needsReason(row: AbstractControl): boolean {
    return this.isCounted(row) && this.variance(row) !== 0;
  }

  /** 'todo' | 'match' | 'short' | 'over' — drives every colour on the row. */
  state(row: AbstractControl): 'todo' | 'match' | 'short' | 'over' {
    if (!this.isCounted(row)) return 'todo';
    const v = this.variance(row);
    return v === 0 ? 'match' : v < 0 ? 'short' : 'over';
  }

  stateLabel(row: AbstractControl): string {
    const v = this.variance(row);
    switch (this.state(row)) {
      case 'todo': return 'Not counted';
      case 'match': return 'Match';
      case 'short': return `Short ${Math.abs(v)}`;
      default: return `Over ${v}`;
    }
  }

  stateChip(row: AbstractControl): string {
    return {
      todo: 'bg-slate-100 text-slate-500 ring-slate-200',
      match: 'bg-green-50 text-green-700 ring-green-200',
      short: 'bg-amber-50 text-amber-700 ring-amber-200',
      over: 'bg-blue-50 text-blue-700 ring-blue-200',
    }[this.state(row)];
  }

  stateBar(row: AbstractControl): string {
    return {
      todo: 'bg-slate-200',
      match: 'bg-status-delivered',
      short: 'bg-status-pending',
      over: 'bg-status-approved',
    }[this.state(row)];
  }

  // ---------- counting actions ----------
  step(row: AbstractControl, delta: number): void {
    const ctrl = row.get('counted_qty');
    const current = this.isCounted(row) ? Number(ctrl?.value) : 0;
    ctrl?.setValue(Math.max(0, current + delta));
    ctrl?.markAsTouched();
  }

  /** One tap: "I counted it and it is exactly what the system says." */
  confirmExpected(row: AbstractControl): void {
    row.get('counted_qty')?.setValue(row.get('expected_qty')?.value);
    row.get('reason')?.setValue('');
    row.get('counted_qty')?.markAsTouched();
  }

  clearRow(row: AbstractControl): void {
    row.get('counted_qty')?.setValue(null);
    row.get('reason')?.setValue('');
  }

  /** Enter jumps to the next counted input — fast keyboard counting. */
  focusNext(event: Event): void {
    event.preventDefault();
    const current = event.target as HTMLElement;
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-count]'))
      .filter((el) => el.offsetParent !== null);
    const i = inputs.indexOf(current as HTMLInputElement);
    inputs[i + 1]?.focus();
    inputs[i + 1]?.select();
  }

  /** Search + view filter over the FormArray — hidden rows still submit. */
  visible(row: AbstractControl): boolean {
    const v = this.view();
    if (v === 'todo' && this.isCounted(row)) return false;
    if (v === 'diff' && !this.needsReason(row)) return false;

    const q = this.search().trim().toLowerCase();
    if (!q) return true;
    const name = (row.get('product_name')?.value ?? '').toLowerCase();
    const sku = (row.get('product_sku')?.value ?? '').toLowerCase();
    return name.includes(q) || sku.includes(q);
  }

  readonly visibleCount = computed(() => {
    this.formValue();
    this.search();
    this.view();
    return this.lines.controls.filter((r) => this.visible(r)).length;
  });

  /** Clear every count and start over. */
  async clearAll(): Promise<void> {
    if (this.summary().counted === 0) return;
    const ok = await this.confirm.ask({
      title: 'Clear all counts?',
      message: 'Every counted quantity and reason on this sheet will be removed.',
      confirmLabel: 'Clear counts',
      tone: 'danger',
    });
    if (!ok) return;
    for (const row of this.lines.controls) this.clearRow(row);
  }

  readonly summary = computed(() => {
    const v = this.formValue() as { lines?: LineValue[] };
    const rows = v?.lines ?? [];
    let counted = 0, match = 0, short = 0, over = 0, netShort = 0, netOver = 0;
    for (const r of rows) {
      if (r.counted_qty === null || (r.counted_qty as unknown) === '') continue;
      counted++;
      const diff = Number(r.counted_qty) - (r.expected_qty ?? 0);
      if (diff === 0) match++;
      else if (diff < 0) { short++; netShort += -diff; }
      else { over++; netOver += diff; }
    }
    const total = rows.length;
    return {
      total, counted, left: total - counted,
      pct: total ? Math.round((counted / total) * 100) : 0,
      match, short, over, netShort, netOver,
      discrepancies: short + over,
    };
  });

  readonly hasDiscrepancies = computed(() => this.summary().discrepancies > 0);
  readonly missingReasons = computed(() => {
    this.formValue();
    return this.lines.controls.filter((r) => r.hasError('reasonRequired')).length;
  });

  cancel(): void {
    this.router.navigate(['/inventory'], {
      queryParams: this.objectId() ? { object: this.objectId() } : {},
    });
  }

  async submit(): Promise<void> {
    const id = this.objectId();
    if (!id) return;

    if (this.summary().left > 0) {
      this.view.set('todo');
      this.toast.error(`${this.summary().left} product(s) still need to be counted.`);
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.view.set('diff');
      this.toast.error('Add a reason for every difference.');
      return;
    }

    const s = this.summary();
    const ok = await this.confirm.ask({
      title: 'Submit stock count?',
      message: s.discrepancies > 0
        ? `Stock will be corrected to the counted figures. ${s.discrepancies} product(s) differ (−${s.netShort} / +${s.netOver}). This can't be undone.`
        : 'Everything matches the system — no stock changes will be made. Log the count anyway?',
      confirmLabel: 'Submit count',
      tone: s.discrepancies > 0 ? 'danger' : 'default',
    });
    if (!ok) return;

    const v = this.form.getRawValue();
    const lines: StockCountLineInput[] = (v.lines as any[]).map((l) => ({
      product_id: l.product_id,
      counted_qty: Number(l.counted_qty),
      reason: (l.reason ?? '').trim() || null,
    }));

    const err = await this.svc.record(
      id, (v.counted_by ?? '').trim() || null, (v.note ?? '').trim() || null, lines
    );
    if (err) {
      this.toast.error(err);
      return;
    }

    this.toast.success(
      s.discrepancies > 0
        ? `Count recorded — stock corrected (${s.short} short, ${s.over} over).`
        : 'Count recorded — everything matched.'
    );
    this.cancel();
  }
}
