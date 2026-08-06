import { Component, computed, inject, input, output, effect } from '@angular/core';
import { DatePipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  FormArray, FormBuilder, FormGroup, ReactiveFormsModule, Validators,
  AbstractControl, ValidationErrors,
} from '@angular/forms';
import { DeliveriesService } from './deliveries.service';
import { DeliveryLineInput } from './delivery.model';
import { Order } from '../orders/order.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { DrawerComponent } from '../../shared/ui/drawer.component';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';

/**
 * Cross-field validator: a reason is REQUIRED whenever the delivered
 * quantity differs from the ordered quantity (short OR over). This mirrors
 * the DB rule exactly, so the user never hits a raw Postgres exception.
 */
function reasonRequiredOnVariance(group: AbstractControl): ValidationErrors | null {
  const ordered = group.get('ordered_qty')?.value ?? 0;
  const delivered = group.get('delivered_qty')?.value;
  const reason = (group.get('reason')?.value ?? '').trim();
  if (delivered !== null && delivered !== ordered && !reason) {
    return { reasonRequired: true };
  }
  return null;
}

@Component({
  selector: 'app-confirm-delivery',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, BadgeComponent, DrawerComponent],
  templateUrl: './confirm-delivery.component.html',
})
export class ConfirmDeliveryComponent {
  private fb = inject(FormBuilder);
  readonly svc = inject(DeliveriesService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  /** The APPROVED order to deliver (passed in by the Orders page). */
  readonly order = input<Order | null>(null);
  readonly open = input<boolean>(false);
  readonly close = output<void>();
  readonly delivered = output<string>();   // emits a summary message on success

  readonly form: FormGroup = this.fb.group({
    carrier: ['NELT'],
    received_by: [''],
    note: [''],
    lines: this.fb.array([]),
  });

  /**
   * Mirror of the form's value as a signal. This is the fix for the footer
   * summary bug: a `computed` can't see mutations inside a FormArray on its
   * own, but subscribing to valueChanges (via toSignal) gives it a reactive
   * dependency that fires on every edit.
   */
  private readonly formValue = toSignal(this.form.valueChanges, { initialValue: this.form.value });

  get lines(): FormArray {
    return this.form.get('lines') as FormArray;
  }

  constructor() {
    // Rebuild the line rows whenever the drawer opens for an order.
    effect(() => {
      const o = this.order();
      if (this.open() && o) {
        void this.build(o.id);
      }
    });
  }

  /** Load the fulfillment view and seed one row per order line (pre-filled). */
  private async build(orderId: string): Promise<void> {
    await this.svc.loadFulfillment(orderId);
    this.lines.clear();
    for (const f of this.svc.fulfillment()) {
      this.lines.push(
        this.fb.group(
          {
            order_item_id: [f.order_item_id],
            product_name: [f.product?.name ?? 'Product'],
            product_sku: [f.product?.sku ?? ''],
            ordered_qty: [f.ordered_qty],
            // Pre-fill with the ordered qty — the common case is an exact match.
            delivered_qty: [f.ordered_qty, [Validators.required, Validators.min(0)]],
            reason: [''],
          },
          { validators: reasonRequiredOnVariance }
        )
      );
    }
    this.form.patchValue({ carrier: 'NELT', received_by: '', note: '' });
  }

  /** Live variance for a row: delivered − ordered. */
  variance(row: AbstractControl): number {
    const ordered = row.get('ordered_qty')?.value ?? 0;
    const delivered = row.get('delivered_qty')?.value ?? 0;
    return delivered - ordered;
  }

  varianceTone(row: AbstractControl): 'success' | 'warning' | 'info' {
    const v = this.variance(row);
    if (v === 0) return 'success';   // exact
    if (v < 0) return 'warning';     // short
    return 'info';                   // over
  }

  varianceLabel(row: AbstractControl): string {
    const v = this.variance(row);
    if (v === 0) return 'Exact';
    if (v < 0) return `Short ${Math.abs(v)}`;
    return `Over ${v}`;
  }

  /** Whether this row currently needs a reason (drives the field showing). */
  needsReason(row: AbstractControl): boolean {
    return this.variance(row) !== 0;
  }

  /**
   * Summary counts for the footer. Now reads `formValue()` first so the
   * computed re-runs on every quantity edit (fixes "0 lines: 0 exact").
   */
  readonly summary = computed(() => {
    const v = this.formValue() as { lines?: Array<{ ordered_qty: number; delivered_qty: number }> };
    const rows = v?.lines ?? [];
    let exact = 0, short = 0, over = 0;
    for (const r of rows) {
      const diff = (r.delivered_qty ?? 0) - (r.ordered_qty ?? 0);
      if (diff === 0) exact++; else if (diff < 0) short++; else over++;
    }
    return { exact, short, over, total: rows.length };
  });

  async submit(): Promise<void> {
    const o = this.order();
    if (!o) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const s = this.summary();
    const hasVariance = s.short > 0 || s.over > 0;

    // Confirm before recording — extra-clear when there's a discrepancy,
    // since a delivery is final and updates stock.
    const ok = await this.confirm.ask({
      title: 'Confirm delivery?',
      message: hasVariance
        ? `This records the delivery and updates stock. ${s.short} line(s) short, ${s.over} over — this can’t be undone.`
        : 'This records the delivery and updates stock. It can’t be undone.',
      confirmLabel: 'Confirm delivery',
      tone: hasVariance ? 'danger' : 'default',
    });
    if (!ok) return;

    const v = this.form.getRawValue();
    const lines: DeliveryLineInput[] = (v.lines as any[]).map((l) => ({
      order_item_id: l.order_item_id,
      delivered_qty: Number(l.delivered_qty),
      reason: (l.reason ?? '').trim() || null,
    }));

    const err = await this.svc.record(
      o.id,
      (v.carrier ?? '').trim() || null,
      (v.received_by ?? '').trim() || null,
      (v.note ?? '').trim() || null,
      lines
    );

    if (err) {
      // Service already set svc.error() for the inline banner; also toast it.
      this.toast.error(err);
      return;
    }

    // Build a human summary for the success toast.
    const msg = hasVariance
      ? `Delivery recorded — stock updated (${s.short} short, ${s.over} over).`
      : 'Delivery recorded — stock updated.';
    this.delivered.emit(msg);
    this.close.emit();
  }
}
