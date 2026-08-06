import { Component, computed, inject, input, output, signal, effect } from '@angular/core';
import {
  FormArray, FormBuilder, FormGroup, ReactiveFormsModule, Validators,
  AbstractControl, ValidationErrors,
} from '@angular/forms';
import { DeliveriesService } from './deliveries.service';
import { DeliveryLineInput } from './delivery.model';
import { Order } from '../orders/order.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { DrawerComponent } from '../../shared/ui/drawer.component';
import { DatePipe } from '@angular/common';

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

  /** The APPROVED order to deliver (passed in by the Orders page). */
  readonly order = input<Order | null>(null);
  readonly open = input<boolean>(false);
  readonly close = output<void>();
  readonly delivered = output<void>();   // emitted after a successful confirm

  readonly form: FormGroup = this.fb.group({
    carrier: ['NELT'],
    received_by: [''],
    note: [''],
    lines: this.fb.array([]),
  });

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

  /** Summary counts for the footer. */
  readonly summary = computed(() => {
    // read the raw form value so the computed re-runs on edits
    const rows = this.lines.controls;
    let exact = 0, short = 0, over = 0;
    for (const r of rows) {
      const v = (r.get('delivered_qty')?.value ?? 0) - (r.get('ordered_qty')?.value ?? 0);
      if (v === 0) exact++; else if (v < 0) short++; else over++;
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
    if (!err) {
      this.delivered.emit();
      this.close.emit();
    }
  }
}
