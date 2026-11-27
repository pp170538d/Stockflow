import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { AbstractControl, FormArray, FormBuilder, FormGroup, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { ComplianceService } from '../../core/compliance/compliance';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { ToastService } from '../../shared/ui/toast.service';
import { DeliveriesService } from './deliveries.service';
import { DeliveryLineInput, DeliveryMetaInput, DispatchDocumentType } from './delivery.model';
import { Order } from '../orders/order.model';

const REASONS = [
  { code: 'DAMAGED', label: 'Damaged' },
  { code: 'WRONG_ITEM', label: 'Wrong item' },
  { code: 'OTHER', label: 'Other' },
] as const;

type Disposition = 'HOLD' | 'RETURN_IMMEDIATE' | null;

function lineValid(g: AbstractControl): ValidationErrors | null {
  const ordered = Number(g.get('ordered_qty')?.value ?? 0);
  const physical = Number(g.get('physical_qty')?.value);
  const accepted = Number(g.get('accepted_qty')?.value);
  const qualityRejected = Math.max(Math.min(physical, ordered) - accepted, 0);
  const notAccepted = Math.max(physical - accepted, 0);
  if (!Number.isFinite(physical) || !Number.isFinite(accepted) || physical < 0 || accepted < 0 || accepted > physical) return { quantities: true };
  if (accepted > ordered) return { acceptedAboveOrder: true };
  if (qualityRejected > 0 && !g.get('rejection_reason_code')?.value) return { rejectionReasonRequired: true };
  if (notAccepted > 0 && !g.get('disposition')?.value) return { dispositionRequired: true };
  return null;
}

@Component({
  selector: 'app-receive-delivery-page',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './receive-delivery-page.component.html',
})
export class ReceiveDeliveryPageComponent implements OnInit {
  readonly svc = inject(DeliveriesService);
  private fb = inject(FormBuilder);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  readonly auth = inject(AuthService);
  readonly compliance = inject(ComplianceService);

  readonly order = signal<Order | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly reasons = REASONS;
  readonly expandedLineId = signal<string | null>(null);

  readonly form: FormGroup = this.fb.group({
    carrier_mode: ['SUPPLIER'],
    carrier: [''],
    received_by: ['', Validators.required],
    dispatch_document_type: [''],
    dispatch_document_number: [''],
    dispatch_external_id: [''],
    physical_receipt_at: ['', Validators.required],
    note: [''],
    lines: this.fb.array([]),
  });

  get lines(): FormArray { return this.form.get('lines') as FormArray; }
  private readonly formValue = toSignal(this.form.valueChanges, { initialValue: this.form.value });

  readonly totals = computed(() => {
    this.formValue();
    let ordered = 0, physical = 0, accepted = 0, held = 0, immediateReturn = 0, unresolved = 0;
    for (const c of this.lines.controls) {
      ordered += this.ordered(c);
      physical += this.physical(c);
      accepted += this.accepted(c);
      held += this.held(c);
      immediateReturn += this.immediateReturn(c);
      unresolved += this.unresolvedDispositionQty(c);
    }
    return { ordered, physical, accepted, held, immediateReturn, unresolved, notAccepted: physical - accepted };
  });

  readonly issueCount = computed(() => {
    this.formValue();
    return this.lines.controls.filter(c => this.needsAttention(c)).length;
  });

  async ngOnInit(): Promise<void> {
    void this.compliance.ensureLoaded();
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) { this.error.set('Order ID is missing.'); this.loading.set(false); return; }

    const { data, error } = await supabase.from('orders').select(`
      id, order_number, object_id, supplier_id, status, comment, created_by, created_at,
      approved_at, approved_by, company_snapshot, supplier_snapshot, delivery_snapshot,
      prepared_by_snapshot, currency,
      object:objects ( name ), supplier:suppliers ( id, name, order_email, active ),
      order_items ( id, order_id, product_id, quantity, unit_cost, product:products ( name, sku ) )
    `).eq('id', id).single();

    if (error || !data) { this.error.set(error?.message ?? 'Order not found.'); this.loading.set(false); return; }
    const order = data as unknown as Order;
    if (order.status !== 'APPROVED') {
      await this.router.navigate(['/orders'], { queryParams: { focus: order.id } });
      return;
    }

    this.order.set(order);
    await this.svc.loadFulfillment(order.id);

    for (const f of this.svc.fulfillment()) {
      this.lines.push(this.fb.group({
        order_item_id: [f.order_item_id],
        product_name: [f.product?.name ?? 'Product'],
        product_sku: [f.product?.sku ?? ''],
        ordered_qty: [f.ordered_qty],
        physical_qty: [f.ordered_qty, [Validators.required, Validators.min(0)]],
        accepted_qty: [f.ordered_qty, [Validators.required, Validators.min(0)]],
        disposition: [null],
        rejection_reason_code: [''],
        reason: [''],
      }, { validators: lineValid }));
    }

    const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const me = this.auth.profile();
    this.form.patchValue({
      carrier_mode: 'SUPPLIER',
      carrier: '',
      received_by: me?.full_name || me?.email || '',
      physical_receipt_at: now,
    });
    this.loading.set(false);
  }

  ordered(r: AbstractControl): number { return Number(r.get('ordered_qty')?.value ?? 0); }
  physical(r: AbstractControl): number { return Number(r.get('physical_qty')?.value ?? 0); }
  accepted(r: AbstractControl): number { return Number(r.get('accepted_qty')?.value ?? 0); }
  shortQty(r: AbstractControl): number { return Math.max(this.ordered(r) - this.physical(r), 0); }
  overQty(r: AbstractControl): number { return Math.max(this.physical(r) - this.ordered(r), 0); }
  qualityRejectedQty(r: AbstractControl): number { return Math.max(Math.min(this.physical(r), this.ordered(r)) - this.accepted(r), 0); }
  notAccepted(r: AbstractControl): number { return Math.max(this.physical(r) - this.accepted(r), 0); }
  variance(r: AbstractControl): number { return this.physical(r) - this.ordered(r); }
  disposition(r: AbstractControl): Disposition { return (r.get('disposition')?.value ?? null) as Disposition; }
  unresolvedDispositionQty(r: AbstractControl): number { return this.notAccepted(r) > 0 && !this.disposition(r) ? this.notAccepted(r) : 0; }
  held(r: AbstractControl): number { return this.notAccepted(r) > 0 && this.disposition(r) === 'HOLD' ? this.notAccepted(r) : 0; }
  immediateReturn(r: AbstractControl): number { return this.notAccepted(r) > 0 && this.disposition(r) === 'RETURN_IMMEDIATE' ? this.notAccepted(r) : 0; }
  needsAttention(r: AbstractControl): boolean { return this.shortQty(r) > 0 || this.overQty(r) > 0 || this.qualityRejectedQty(r) > 0; }
  lineId(r: AbstractControl): string { return String(r.get('order_item_id')?.value ?? ''); }
  lineNumber(index: number): string { return String(index + 1).padStart(2, '0'); }
  isExpanded(r: AbstractControl): boolean { return this.expandedLineId() === this.lineId(r); }
  toggleLine(r: AbstractControl): void { const id = this.lineId(r); this.expandedLineId.update(current => current === id ? null : id); }
  openLine(r: AbstractControl): void { this.expandedLineId.set(this.lineId(r)); }
  closeLine(r: AbstractControl): void { if (!this.lineResolved(r)) { r.markAllAsTouched(); return; } if (this.isExpanded(r)) this.expandedLineId.set(null); }
  lineResolved(r: AbstractControl): boolean { return r.valid; }
  rejectionReasonLabel(r: AbstractControl): string { const code = r.get('rejection_reason_code')?.value; return this.reasons.find(x => x.code === code)?.label ?? 'Quality reason required'; }
  compactDescription(r: AbstractControl): string {
    if (!this.needsAttention(r)) return 'Exact receipt';
    const parts: string[] = [];
    if (this.shortQty(r)) parts.push(`Short ${this.shortQty(r)}`);
    if (this.overQty(r)) parts.push(`Over ${this.overQty(r)}`);
    if (this.qualityRejectedQty(r)) parts.push(`${this.rejectionReasonLabel(r)} ${this.qualityRejectedQty(r)}`);
    if (this.notAccepted(r)) {
      if (this.disposition(r) === 'HOLD') parts.push('Hold for resolution');
      else if (this.disposition(r) === 'RETURN_IMMEDIATE') parts.push('Return with driver');
      else parts.push('Disposition required');
    }
    return parts.join(' · ');
  }
  onPhysicalQty(r: AbstractControl): void {
    const physical = this.physical(r), ordered = this.ordered(r);
    r.get('accepted_qty')?.setValue(Math.min(physical, ordered), { emitEvent: false });
    r.get('rejection_reason_code')?.setValue('', { emitEvent: false });
    r.get('disposition')?.setValue(null, { emitEvent: false });
    r.updateValueAndValidity(); this.form.updateValueAndValidity();
    if (this.needsAttention(r)) this.openLine(r);
  }
  onAcceptedQty(r: AbstractControl): void {
    const max = Math.min(this.physical(r), this.ordered(r));
    if (this.accepted(r) > max) r.get('accepted_qty')?.setValue(max, { emitEvent: false });
    if (this.notAccepted(r) === 0) { r.get('rejection_reason_code')?.setValue('', { emitEvent: false }); r.get('disposition')?.setValue(null, { emitEvent: false }); }
    r.updateValueAndValidity(); this.form.updateValueAndValidity();
    if (this.needsAttention(r)) this.openLine(r);
  }
  bump(r: AbstractControl, field: 'physical_qty' | 'accepted_qty', delta: number): void { const c = r.get(field); c?.setValue(Math.max(0, Number(c?.value ?? 0) + delta)); field === 'physical_qty' ? this.onPhysicalQty(r) : this.onAcceptedQty(r); }
  setDisposition(r: AbstractControl, value: Exclude<Disposition, null>): void { r.get('disposition')?.setValue(value); r.updateValueAndValidity(); this.form.updateValueAndValidity(); this.openLine(r); }
  setRejectionReason(r: AbstractControl, code: string): void {
    const control = r.get('rejection_reason_code');

    if (!control) {
      console.error(
        'Receiving line is missing rejection_reason_code control',
        this.lineId(r)
      );
      return;
    }

    control.setValue(code);
    control.markAsDirty();
    control.markAsTouched();

    r.updateValueAndValidity({
      emitEvent: true,
    });

    this.form.updateValueAndValidity({
      emitEvent: true,
    });

    this.openLine(r);
  }
  state(r: AbstractControl): { label: string; tone: string } {
    if (!r.valid && this.needsAttention(r)) return { label: 'Needs decision', tone: 'bg-amber-50 text-amber-700 ring-amber-200' };
    const n = this.notAccepted(r);
    if (n && this.disposition(r) === 'RETURN_IMMEDIATE') return { label: `Return ${n}`, tone: 'bg-violet-50 text-violet-700 ring-violet-200' };
    if (n && this.disposition(r) === 'HOLD') return { label: `Hold ${n}`, tone: 'bg-red-50 text-red-700 ring-red-200' };
    if (this.shortQty(r)) return { label: `Short ${this.shortQty(r)}`, tone: 'bg-amber-50 text-amber-700 ring-amber-200' };
    if (this.overQty(r)) return { label: `Over ${this.overQty(r)}`, tone: 'bg-blue-50 text-blue-700 ring-blue-200' };
    return { label: 'Exact', tone: 'bg-green-50 text-green-700 ring-green-200' };
  }
  onDispatchType(): void {
    const t = this.form.get('dispatch_document_type')?.value;
    const n = this.form.get('dispatch_document_number');
    if (t) n?.setValidators([Validators.required]);
    else {
      n?.clearValidators(); n?.setValue(''); this.form.get('dispatch_external_id')?.setValue('');
    }
    n?.updateValueAndValidity();
  }

  setCarrier(mode: 'SUPPLIER' | 'OWN' | 'OTHER'): void { this.form.get('carrier_mode')?.setValue(mode); }
  receiverRole(): string { return this.auth.isAdmin() ? 'Admin' : 'Seller'; }

  private carrierValue(_order: Order, raw: any): string | null {
    if (raw.carrier_mode === 'SUPPLIER') return 'Supplier transport';
    if (raw.carrier_mode === 'OWN') return 'Own transport';
    return raw.carrier?.trim() || null;
  }

  async submit(): Promise<void> {
    const o = this.order();
    if (!o || this.form.invalid || this.svc.saving()) { this.form.markAllAsTouched(); return; }

    const t = this.totals();
    const details = [
      `Physical ${t.physical}`,
      `stock +${t.accepted}`,
      t.held ? `held ${t.held}` : null,
      t.immediateReturn ? `return now ${t.immediateReturn}` : null,
    ].filter(Boolean).join(' · ');

    const ok = await this.confirm.ask({
      title: 'Record goods receipt?',
      message: `${details}.` + (this.issueCount() ? ` ${this.issueCount()} line(s) contain a receiving difference.` : ''),
      confirmLabel: 'Record receipt',
      tone: this.issueCount() ? 'danger' : 'default',
    });
    if (!ok) return;

    const v = this.form.getRawValue();
    const lines: DeliveryLineInput[] = v.lines.map((l: any) => {
      const physical = Number(l.physical_qty);
      const accepted = Number(l.accepted_qty);
      const notAccepted = Math.max(physical - accepted, 0);

      const disposition =
        (l.disposition ?? null) as Disposition;

      return {
        order_item_id: l.order_item_id,

        physical_qty: physical,
        accepted_qty: accepted,

        held_qty:
          disposition === 'HOLD'
            ? notAccepted
            : 0,

        immediate_return_qty:
          disposition === 'RETURN_IMMEDIATE'
            ? notAccepted
            : 0,

        rejection_reason_code:
          l.rejection_reason_code || null,

        /*
         * Kept only for compatibility.
         * SHORT / OVER are calculated by the database.
         */
        reason_code: null,

        reason:
          (l.reason ?? '').trim() || null,
      };
    });

    const meta: DeliveryMetaInput = {
      carrier: this.carrierValue(o, v),
      receivedBy: v.received_by?.trim() || null,
      note: v.note?.trim() || null,
      dispatchDocumentType: (v.dispatch_document_type || null) as DispatchDocumentType | null,
      dispatchDocumentNumber: v.dispatch_document_number?.trim() || null,
      dispatchExternalId: v.dispatch_external_id?.trim() || null,
      physicalReceiptAt: v.physical_receipt_at ? new Date(v.physical_receipt_at).toISOString() : null,
    };

    const err = await this.svc.record(o.id, meta, lines);
    if (err) { this.toast.error(err); return; }

    const result = [`${t.accepted} to stock`];
    if (t.held) result.push(`${t.held} held`);
    if (t.immediateReturn) result.push(`${t.immediateReturn} returned with driver`);
    this.toast.success(`Goods receipt recorded · ${result.join(' · ')}.`);
    await this.router.navigate(['/orders'], { queryParams: { focus: o.id, receipt: 1 } });
  }
}
