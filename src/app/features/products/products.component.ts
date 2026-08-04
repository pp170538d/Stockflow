import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ProductsService } from './products.service';
import { Product } from './product.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { DrawerComponent } from '../../shared/ui/drawer.component';

@Component({
  selector: 'app-products',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, BadgeComponent, EmptyStateComponent, DrawerComponent],
  templateUrl: './products.component.html',
})
export class ProductsComponent implements OnInit {
  readonly svc = inject(ProductsService);
  private fb = inject(FormBuilder);

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

    const err = this.editingId()
      ? await this.svc.update(this.editingId()!, input)
      : await this.svc.create(input);

    this.saving.set(false);
    if (err) this.formError.set(err);
    else this.drawerOpen.set(false);
  }

  async toggleActive(p: Product): Promise<void> {
    if (p.active) await this.svc.deactivate(p.id);
    else await this.svc.activate(p.id);
  }
}