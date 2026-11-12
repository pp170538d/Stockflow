import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { SuppliersService } from './suppliers.service';
import { Supplier, SupplierInput } from './supplier.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { DrawerComponent } from '../../shared/ui/drawer.component';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';

@Component({
  selector: 'app-suppliers',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, BadgeComponent, EmptyStateComponent, DrawerComponent],
  templateUrl: './suppliers.component.html',
})
export class SuppliersComponent implements OnInit {
  readonly svc = inject(SuppliersService);
  private fb = inject(FormBuilder);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly search = signal('');
  readonly drawerOpen = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);

  readonly drawerTitle = computed(() => this.editingId() ? 'Edit supplier' : 'New supplier');

  readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    address: [''],
    city: [''],
    postal_code: [''],
    country: ['Serbia'],
    tax_id: [''],
    registration_number: [''],
    order_email: ['', Validators.email],
    phone: [''],
    contact_name: [''],
    active: [true],
  });

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.svc.suppliers();
    return this.svc.suppliers().filter((s) =>
      [s.name, s.city, s.tax_id, s.order_email, s.contact_name]
        .some((v) => (v ?? '').toLowerCase().includes(q))
    );
  });

  ngOnInit(): void {
    void this.svc.load();
  }

  openCreate(): void {
    this.editingId.set(null);
    this.formError.set(null);
    this.form.reset({
      name: '', address: '', city: '', postal_code: '', country: 'Serbia',
      tax_id: '', registration_number: '', order_email: '', phone: '', contact_name: '', active: true,
    });
    this.drawerOpen.set(true);
  }

  openEdit(s: Supplier): void {
    this.editingId.set(s.id);
    this.formError.set(null);
    this.form.reset({
      name: s.name,
      address: s.address ?? '',
      city: s.city ?? '',
      postal_code: s.postal_code ?? '',
      country: s.country ?? '',
      tax_id: s.tax_id ?? '',
      registration_number: s.registration_number ?? '',
      order_email: s.order_email ?? '',
      phone: s.phone ?? '',
      contact_name: s.contact_name ?? '',
      active: s.active,
    });
    this.drawerOpen.set(true);
  }

  closeDrawer(): void {
    this.drawerOpen.set(false);
  }

  async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.saving.set(true);
    this.formError.set(null);
    const v = this.form.getRawValue();
    const input: SupplierInput = {
      name: v.name.trim(),
      address: nullable(v.address),
      city: nullable(v.city),
      postal_code: nullable(v.postal_code),
      country: nullable(v.country),
      tax_id: nullable(v.tax_id),
      registration_number: nullable(v.registration_number),
      order_email: nullable(v.order_email),
      phone: nullable(v.phone),
      contact_name: nullable(v.contact_name),
      active: v.active,
    };

    const editing = !!this.editingId();
    const err = await this.svc.save(this.editingId(), input);
    this.saving.set(false);

    if (err) {
      this.formError.set(err);
      this.toast.error(err);
      return;
    }

    this.drawerOpen.set(false);
    this.toast.success(editing ? 'Supplier updated.' : 'Supplier created.');
  }

  async toggleActive(s: Supplier): Promise<void> {
    if (s.active) {
      const ok = await this.confirm.ask({
        title: 'Deactivate this supplier?',
        message: `${s.name} will no longer be available for new purchase orders. Existing orders and snapshots remain unchanged.`,
        confirmLabel: 'Deactivate',
        tone: 'danger',
      });
      if (!ok) return;
    }

    const err = await this.svc.setActive(s, !s.active);
    if (err) {
      this.toast.error(err);
      return;
    }
    this.toast.success(s.active ? `${s.name} deactivated.` : `${s.name} activated.`);
  }
}

function nullable(value: string): string | null {
  return value.trim() || null;
}
