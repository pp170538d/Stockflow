import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ProductsService } from './products.service';
import { Product } from './product.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { DrawerComponent } from '../../shared/ui/drawer.component';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';

@Component({
  selector: 'app-products',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, BadgeComponent, EmptyStateComponent, DrawerComponent],
  templateUrl: './products.component.html',
})
export class ProductsComponent implements OnInit {
  readonly svc = inject(ProductsService);
  private fb = inject(FormBuilder);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly search = signal('');
  readonly categoryFilter = signal<string>('');
  readonly drawerOpen = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);

  readonly drawerTitle = computed(() => (this.editingId() ? 'Edit product' : 'New product'));

  readonly form = this.fb.nonNullable.group({
    sku: ['', [Validators.required]],
    name: ['', [Validators.required]],
    category: [''],
    active: [true],
  });

  // Unique category list for the filter dropdown
  readonly categories = computed(() => {
    const set = new Set<string>();
    for (const p of this.svc.products()) {
      if (p.category) set.add(p.category);
    }
    return Array.from(set).sort();
  });

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const cat = this.categoryFilter();
    return this.svc.products().filter((p) => {
      const matchesText =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.category ?? '').toLowerCase().includes(q);
      const matchesCat = !cat || p.category === cat;
      return matchesText && matchesCat;
    });
  });

  ngOnInit(): void {
    this.svc.load();
  }

  openCreate(): void {
    this.editingId.set(null);
    this.formError.set(null);
    this.form.reset({ sku: '', name: '', category: '', active: true });
    this.drawerOpen.set(true);
  }

  openEdit(p: Product): void {
    this.editingId.set(p.id);
    this.formError.set(null);
    this.form.reset({
      sku: p.sku,
      name: p.name,
      category: p.category ?? '',
      active: p.active,
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
    const input = {
      sku: v.sku.trim(),
      name: v.name.trim(),
      category: v.category.trim() || null,
      active: v.active,
    };
    const editing = !!this.editingId();
    // Service maps the duplicate-SKU Postgres error to a friendly message,
    // so it surfaces cleanly in both the inline banner and the toast.
    const err = editing
      ? await this.svc.update(this.editingId()!, input)
      : await this.svc.create(input);
    this.saving.set(false);
    if (err) {
      this.formError.set(err);
      this.toast.error(err);
    } else {
      this.drawerOpen.set(false);
      this.toast.success(editing ? 'Product updated.' : 'Product created.');
    }
  }

  async toggleActive(p: Product): Promise<void> {
    if (p.active) {
      const ok = await this.confirm.ask({
        title: 'Deactivate this product?',
        message: `${p.name} will be hidden from new orders and assignments. You can reactivate it anytime.`,
        confirmLabel: 'Deactivate',
        tone: 'danger',
      });
      if (!ok) return;
      const err = await this.svc.deactivate(p.id);
      if (err) { this.toast.error(err); return; }
      this.toast.success(`${p.name} deactivated.`, {
        action: {
          label: 'Undo',
          run: async () => {
            const e = await this.svc.activate(p.id);
            if (e) this.toast.error(e);
            else this.toast.info(`${p.name} reactivated.`);
          },
        },
      });
    } else {
      const err = await this.svc.activate(p.id);
      if (err) { this.toast.error(err); return; }
      this.toast.success(`${p.name} activated.`);
    }
  }
}
