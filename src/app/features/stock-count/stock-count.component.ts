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
import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';

/** A reason is required whenever counted ≠ expected (mirrors the DB rule). */
function reasonRequiredOnVariance(group: AbstractControl): ValidationErrors | null {
  const expected = group.get('expected_qty')?.value ?? 0;
  const counted = group.get('counted_qty')?.value;
  const reason = (group.get('reason')?.value ?? '').trim();
  if (counted !== null && counted !== expected && !reason) return { reasonRequired: true };
  return null;
}

@Component({
  selector: 'app-stock-count',
  standalone: true,
  imports: [ReactiveFormsModule, BadgeComponent, EmptyStateComponent],
  templateUrl: './stock-count.component.html',
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
   * empty, fall back to the part of the email before "@" (e.g. "petar");
   * only use the whole email as a last resort.
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
      const chosen = paramObject ?? this.objects()[0]?.id ?? null;
      if (chosen) await this.selectObject(chosen);
    } else {
      const own = this.auth.profile()?.object_id ?? null;
      if (own) await this.selectObject(own);
    }
  }

  async selectObject(objectId: string): Promise<void> {
    this.objectId.set(objectId);
    this.objectName.set(this.objects().find((o) => o.id === objectId)?.name ?? '');
    await this.build(objectId);
  }

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
            counted_qty: [r.expected_qty, [Validators.required, Validators.min(0)]],
            reason: [''],
          },
          { validators: reasonRequiredOnVariance }
        )
      );
    }
    this.building.set(false);
  }

  // --- Row helpers ---
  variance(row: AbstractControl): number {
    return (row.get('counted_qty')?.value ?? 0) - (row.get('expected_qty')?.value ?? 0);
  }
  varianceTone(row: AbstractControl): 'success' | 'warning' | 'info' {
    const v = this.variance(row);
    return v === 0 ? 'success' : v < 0 ? 'warning' : 'info';
  }
  varianceLabel(row: AbstractControl): string {
    const v = this.variance(row);
    return v === 0 ? 'Match' : v < 0 ? `Short ${Math.abs(v)}` : `Over ${v}`;
  }
  needsReason(row: AbstractControl): boolean {
    return this.variance(row) !== 0;
  }

  /** Search filter over the (kept) FormArray — hidden rows still submit. */
  matchesSearch(row: AbstractControl): boolean {
    const q = this.search().trim().toLowerCase();
    if (!q) return true;
    const name = (row.get('product_name')?.value ?? '').toLowerCase();
    const sku = (row.get('product_sku')?.value ?? '').toLowerCase();
    return name.includes(q) || sku.includes(q);
  }

  /** Reset every counted back to its expected value (undo all edits). */
  resetAll(): void {
    for (const row of this.lines.controls) {
      row.get('counted_qty')?.setValue(row.get('expected_qty')?.value);
      row.get('reason')?.setValue('');
    }
  }

  readonly summary = computed(() => {
    const v = this.formValue() as { lines?: Array<{ expected_qty: number; counted_qty: number }> };
    const rows = v?.lines ?? [];
    let match = 0, short = 0, over = 0, netShort = 0, netOver = 0;
    for (const r of rows) {
      const diff = (r.counted_qty ?? 0) - (r.expected_qty ?? 0);
      if (diff === 0) match++;
      else if (diff < 0) { short++; netShort += -diff; }
      else { over++; netOver += diff; }
    }
    return { match, short, over, netShort, netOver, total: rows.length, discrepancies: short + over };
  });

  /** True when at least one line differs from expected — drives the footer tint. */
  readonly hasDiscrepancies = computed(() => this.summary().discrepancies > 0);

  cancel(): void {
    this.router.navigate(['/inventory']);
  }

  async submit(): Promise<void> {
    const id = this.objectId();
    if (!id) return;
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }

    const s = this.summary();

    const ok = await this.confirm.ask({
      title: 'Submit stock count?',
      message: s.discrepancies > 0
        ? `This will correct stock to the counted figures. ${s.discrepancies} product(s) differ (−${s.netShort} / +${s.netOver}). This can’t be undone.`
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
    if (err) { this.toast.error(err); return; }

    this.toast.success(
      s.discrepancies > 0
        ? `Count recorded — stock corrected (${s.short} short, ${s.over} over).`
        : 'Count recorded — everything matched. ✓'
    );
    this.router.navigate(['/inventory']);
  }
}
