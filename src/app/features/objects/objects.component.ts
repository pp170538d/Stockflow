import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ObjectsService } from './objects.service';
import { BusinessObject } from './object.model';
import { AssignmentsService } from './assignments.service';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { DrawerComponent } from '../../shared/ui/drawer.component';

@Component({
  selector: 'app-objects',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, BadgeComponent, EmptyStateComponent, DrawerComponent],
  templateUrl: './objects.component.html',
})
export class ObjectsComponent implements OnInit {
  readonly svc = inject(ObjectsService);
  readonly assign = inject(AssignmentsService);
  private fb = inject(FormBuilder);

  // --- List / edit state ---
  readonly search = signal('');
  readonly drawerOpen = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);

  // --- Assignment state ---
  readonly assignOpen = signal(false);
  readonly assignObjectId = signal<string | null>(null);
  readonly assignObjectName = signal<string>('');
  readonly productSearch = signal('');

  readonly drawerTitle = computed(() =>
    this.editingId() ? 'Edit object' : 'New object'
  );

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required]],
    city: [''],
    address: [''],
    active: [true],
  });

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.svc.objects();
    if (!q) return list;
    return list.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        (o.city ?? '').toLowerCase().includes(q) ||
        (o.address ?? '').toLowerCase().includes(q)
    );
  });

  readonly filteredProducts = computed(() => {
    const q = this.productSearch().trim().toLowerCase();
    const list = this.assign.allProducts();
    if (!q) return list;
    return list.filter(
      (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
    );
  });

  readonly assignedCount = computed(() => this.assign.assignedIds().size);

  ngOnInit(): void {
    this.svc.load();
  }

  // --- Create / edit ---
  openCreate(): void {
    this.editingId.set(null);
    this.formError.set(null);
    this.form.reset({ name: '', city: '', address: '', active: true });
    this.drawerOpen.set(true);
  }

  openEdit(obj: BusinessObject): void {
    this.editingId.set(obj.id);
    this.formError.set(null);
    this.form.reset({
      name: obj.name,
      city: obj.city ?? '',
      address: obj.address ?? '',
      active: obj.active,
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
      name: v.name.trim(),
      city: v.city.trim() || null,
      address: v.address.trim() || null,
      active: v.active,
    };

    const err = this.editingId()
      ? await this.svc.update(this.editingId()!, input)
      : await this.svc.create(input);

    this.saving.set(false);

    if (err) {
      this.formError.set(err);
    } else {
      this.drawerOpen.set(false);
    }
  }

  async toggleActive(obj: BusinessObject): Promise<void> {
    if (obj.active) {
      await this.svc.deactivate(obj.id);
    } else {
      await this.svc.activate(obj.id);
    }
  }

  // --- Product assignment ---
  openAssign(obj: BusinessObject): void {
    this.assignObjectId.set(obj.id);
    this.assignObjectName.set(obj.name);
    this.productSearch.set('');
    this.assignOpen.set(true);
    this.assign.loadFor(obj.id);
  }

  closeAssign(): void {
    this.assignOpen.set(false);
  }

  isAssigned(productId: string): boolean {
    return this.assign.assignedIds().has(productId);
  }

  toggleAssign(productId: string): void {
    const id = this.assignObjectId();
    if (id) this.assign.toggle(id, productId);
  }
}