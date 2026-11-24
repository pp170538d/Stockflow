import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
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
  { code: 'SUPPLIER_SHORT', label: 'Supplier short' },
  { code: 'SUPPLIER_OVER', label: 'Supplier over' },
  { code: 'DAMAGED', label: 'Damaged' },
  { code: 'WRONG_ITEM', label: 'Wrong item' },
  { code: 'OTHER', label: 'Other' },
] as const;

function lineValid(g: AbstractControl): ValidationErrors | null {
  const o = Number(g.get('ordered_qty')?.value ?? 0);
  const p = Number(g.get('physical_qty')?.value);
  const a = Number(g.get('accepted_qty')?.value);
  if (!Number.isFinite(p) || !Number.isFinite(a) || p < 0 || a < 0 || a > p) return { quantities: true };
  return (p !== o || a < p) && !g.get('reason_code')?.value ? { reasonRequired: true } : null;
}

@Component({
  selector: 'app-receive-delivery-page',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, DatePipe],
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

  readonly form: FormGroup = this.fb.group({
    carrier_mode: ['SUPPLIER'], carrier: [''], received_by: ['', Validators.required],
    dispatch_document_type: [''], dispatch_document_number: [''], dispatch_external_id: [''],
    physical_receipt_at: ['', Validators.required], note: [''], lines: this.fb.array([]),
  });
  get lines(): FormArray { return this.form.get('lines') as FormArray; }
  private readonly formValue = toSignal(this.form.valueChanges, { initialValue: this.form.value });

  readonly totals = computed(() => {
    this.formValue();
    let ordered = 0, physical = 0, accepted = 0;
    for (const c of this.lines.controls) {
      ordered += this.ordered(c); physical += this.physical(c); accepted += this.accepted(c);
    }
    return { ordered, physical, accepted, rejected: Math.max(physical - accepted, 0) };
  });
  readonly issueCount = computed(() => { this.formValue(); return this.lines.controls.filter(c => this.needsReason(c)).length; });

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
    if (order.status !== 'APPROVED') { await this.router.navigate(['/orders'], { queryParams: { focus: order.id } }); return; }
    this.order.set(order);
    await this.svc.loadFulfillment(order.id);
    for (const f of this.svc.fulfillment()) {
      this.lines.push(this.fb.group({
        order_item_id: [f.order_item_id], product_name: [f.product?.name ?? 'Product'], product_sku: [f.product?.sku ?? ''],
        ordered_qty: [f.ordered_qty], physical_qty: [f.ordered_qty, [Validators.required, Validators.min(0)]],
        accepted_qty: [f.ordered_qty, [Validators.required, Validators.min(0)]], reason_code: [''], reason: [''],
      }, { validators: lineValid }));
    }
    const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const me = this.auth.profile();
    this.form.patchValue({
      carrier_mode: 'SUPPLIER', carrier: '',
      received_by: me?.full_name || me?.email || '',
      physical_receipt_at: now,
    });
    this.loading.set(false);
  }

  ordered(r: AbstractControl) { return Number(r.get('ordered_qty')?.value ?? 0); }
  physical(r: AbstractControl) { return Number(r.get('physical_qty')?.value ?? 0); }
  accepted(r: AbstractControl) { return Number(r.get('accepted_qty')?.value ?? 0); }
  rejected(r: AbstractControl) { return Math.max(this.physical(r) - this.accepted(r), 0); }
  variance(r: AbstractControl) { return this.physical(r) - this.ordered(r); }
  needsReason(r: AbstractControl) { return this.variance(r) !== 0 || this.rejected(r) > 0; }
  onQty(r: AbstractControl) { if (this.accepted(r) > this.physical(r)) r.get('accepted_qty')?.setValue(this.physical(r)); r.updateValueAndValidity(); }
  setReason(r: AbstractControl, code: string) { r.get('reason_code')?.setValue(code); r.updateValueAndValidity(); }
  state(r: AbstractControl): { label: string; tone: string } {
    const v = this.variance(r), rej = this.rejected(r);
    if (rej) return { label: `${rej} rejected`, tone: 'bg-red-50 text-red-700 ring-red-200' };
    if (v < 0) return { label: `Short ${-v}`, tone: 'bg-amber-50 text-amber-700 ring-amber-200' };
    if (v > 0) return { label: `Over ${v}`, tone: 'bg-blue-50 text-blue-700 ring-blue-200' };
    return { label: 'Exact', tone: 'bg-green-50 text-green-700 ring-green-200' };
  }

  onDispatchType(): void {
    const t = this.form.get('dispatch_document_type')?.value;
    const n = this.form.get('dispatch_document_number');
    if (t) n?.setValidators([Validators.required]); else { n?.clearValidators(); n?.setValue(''); this.form.get('dispatch_external_id')?.setValue(''); }
    n?.updateValueAndValidity();
  }
  onCarrierMode(): void { if (this.form.get('carrier_mode')?.value !== 'OTHER') this.form.get('carrier')?.setValue(''); }
  roleLabel(): string { return this.auth.isAdmin() ? 'Admin' : 'Seller'; }
  private carrierValue(order: Order, raw: any): string | null {
    if (raw.carrier_mode === 'SUPPLIER') return 'Supplier transport';
    if (raw.carrier_mode === 'OWN') return 'Own transport';
    return raw.carrier?.trim() || null;
  }

  async submit(): Promise<void> {
    const o = this.order(); if (!o || this.form.invalid || this.svc.saving()) { this.form.markAllAsTouched(); return; }
    const t = this.totals();
    const ok = await this.confirm.ask({
      title: 'Record goods receipt?',
      message: `Physical ${t.physical} · accepted into stock ${t.accepted} · rejected ${t.rejected}.` + (this.issueCount() ? ` ${this.issueCount()} line(s) will remain open for resolution.` : ''),
      confirmLabel: 'Record receipt', tone: this.issueCount() ? 'danger' : 'default',
    });
    if (!ok) return;
    const v = this.form.getRawValue();
    const lines: DeliveryLineInput[] = v.lines.map((l: any) => ({
      order_item_id: l.order_item_id, physical_qty: +l.physical_qty, accepted_qty: +l.accepted_qty,
      reason_code: (+l.physical_qty !== +l.ordered_qty || +l.accepted_qty < +l.physical_qty) ? l.reason_code || null : null,
      reason: (l.reason ?? '').trim() || null,
    }));
    const meta: DeliveryMetaInput = {
      carrier: this.carrierValue(o, v), receivedBy: v.received_by?.trim() || null, note: v.note?.trim() || null,
      dispatchDocumentType: (v.dispatch_document_type || null) as DispatchDocumentType | null,
      dispatchDocumentNumber: v.dispatch_document_number?.trim() || null, dispatchExternalId: v.dispatch_external_id?.trim() || null,
      physicalReceiptAt: v.physical_receipt_at ? new Date(v.physical_receipt_at).toISOString() : null,
    };
    const err = await this.svc.record(o.id, meta, lines);
    if (err) { this.toast.error(err); return; }
    this.toast.success(`Goods receipt recorded · ${t.accepted} accepted into stock${t.rejected ? ` · ${t.rejected} rejected` : ''}.`);
    await this.router.navigate(['/orders'], { queryParams: { focus: o.id, receipt: 1 } });
  }
}
