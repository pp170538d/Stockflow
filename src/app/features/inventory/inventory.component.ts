import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { InventoryService } from './inventory.service';
import { InventoryRow, MovementType } from './inventory.model';
import { BusinessObject } from '../objects/object.model';
import { Product } from '../products/product.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { DrawerComponent } from '../../shared/ui/drawer.component';

const LOW_STOCK_THRESHOLD = 10;

/** A signed correction can be + or −, but never 0. */
function notZero(control: AbstractControl): ValidationErrors | null {
  const v = control.value;
  return v === 0 || v === null || v === '' ? { zero: true } : null;
}

@Component({
  selector: 'app-inventory',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, BadgeComponent, EmptyStateComponent, DrawerComponent],
  templateUrl: './inventory.component.html',
})
export class InventoryComponent implements OnInit {
  readonly svc = inject(InventoryService);
  readonly auth = inject(AuthService);
  private fb = inject(FormBuilder);

  readonly objects = signal<BusinessObject[]>([]);
  readonly selectedObjectId = signal<string | null>(null);
  readonly search = signal('');

  // Record-movement drawer
  readonly drawerOpen = signal(false);
  readonly assignableProducts = signal<Product[]>([]);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);

  // Movement-history drawer
  readonly historyOpen = signal(false);
  readonly historyProductName = signal('');

  readonly isAdmin = computed(() => this.auth.isAdmin());

  readonly form = this.fb.nonNullable.group({
    product_id: ['', [Validators.required]],
    movement_type: ['INBOUND' as MovementType, [Validators.required]],
    quantity: [1, [Validators.required, Validators.min(1)]],
    note: [''],
  });

  constructor() {
    // ADJUSTMENT may go either way (the DB guard exempts it); INBOUND / OUTBOUND
    // are always a positive magnitude — the type decides the direction.
    this.form.controls.movement_type.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((type) => {
        const qty = this.form.controls.quantity;
        qty.setValidators(
          type === 'ADJUSTMENT'
            ? [Validators.required, notZero]
            : [Validators.required, Validators.min(1)]
        );
        qty.updateValueAndValidity();
      });
  }

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.svc.rows();
    if (!q) return list;
    return list.filter(
      (r) =>
        (r.product?.name ?? '').toLowerCase().includes(q) ||
        (r.product?.sku ?? '').toLowerCase().includes(q)
    );
  });

  /** Running-balance chart points, built from movement history (oldest→newest). */
  readonly historyChart = computed(() => {
    const moves = [...this.svc.movements()].reverse(); // service returns newest-first
    let running = 0;
    const points = moves.map((m) => {
      running += m.quantity;
      return { qty: m.quantity, balance: running, at: m.created_at };
    });
    const balances = points.map((p) => p.balance);
    const max = Math.max(1, ...balances);
    const min = Math.min(0, ...balances);
    const range = max - min || 1;
    // Map each point into an SVG coordinate (viewBox 0..100 x, 0..40 y)
    const n = points.length;
    const coords = points.map((p, i) => {
      const x = n === 1 ? 50 : (i / (n - 1)) * 100;
      const y = 40 - ((p.balance - min) / range) * 40; // invert: higher balance = higher up
      return { ...p, x, y };
    });
    // Build the SVG polyline + area-fill path strings
    const line = coords.map((c) => `${c.x},${c.y}`).join(' ');
    const area = coords.length
      ? `0,40 ${line} ${coords[coords.length - 1].x},40`
      : '';
    return { coords, line, area, max, current: running };
  });

  async ngOnInit(): Promise<void> {
    const profile = this.auth.profile();
    if (this.isAdmin()) {
      const { data } = await supabase.from('objects').select('*').eq('active', true).order('name');
      this.objects.set((data ?? []) as BusinessObject[]);
    } else {
      this.selectedObjectId.set(profile?.object_id ?? null);
      if (this.selectedObjectId()) this.svc.loadInventory(this.selectedObjectId()!);
    }
  }

  async onObjectChange(objectId: string): Promise<void> {
    this.selectedObjectId.set(objectId);
    if (objectId) await this.svc.loadInventory(objectId);
  }

  isLow(r: InventoryRow): boolean {
    return r.quantity <= LOW_STOCK_THRESHOLD;
  }

  async openRecord(): Promise<void> {
    const objectId = this.selectedObjectId();
    if (!objectId) return;
    this.formError.set(null);
    this.form.reset({ product_id: '', movement_type: 'INBOUND', quantity: 1, note: '' });
    // Products assigned to this object are the ones you can move stock for
    const { data } = await supabase
      .from('object_products')
      .select('product:products ( id, sku, name, category, active, created_at )')
      .eq('object_id', objectId);
    const prods = (data ?? []).map((r: any) => r.product).filter((p: Product) => p && p.active);
    this.assignableProducts.set(prods as Product[]);
    this.drawerOpen.set(true);
  }

  closeDrawer(): void {
    this.drawerOpen.set(false);
  }

  async save(): Promise<void> {
    const objectId = this.selectedObjectId();
    const profile = this.auth.profile();
    if (!objectId || !profile) return;
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    this.saving.set(true);
    this.formError.set(null);
    const v = this.form.getRawValue();

    // Convert the entered value into a SIGNED quantity by type.
    //  INBOUND   → always positive magnitude
    //  OUTBOUND  → always negative magnitude
    //  ADJUSTMENT→ keep the sign the user entered (a correction may go either way)
    let signed: number;
    if (v.movement_type === 'INBOUND')       signed =  Math.abs(v.quantity);
    else if (v.movement_type === 'OUTBOUND') signed = -Math.abs(v.quantity);
    else                                     signed =  v.quantity; // ADJUSTMENT

    if (signed === 0) {
      this.formError.set('Quantity cannot be zero.');
      this.saving.set(false);
      return;
    }

    // Instant client-side guard for OUTBOUND: we already hold current stock in
    // memory, so fail fast with a clear message instead of waiting for the DB
    // trigger to reject the oversell. (ADJUSTMENT is intentionally exempt.)
    if (v.movement_type === 'OUTBOUND') {
      const onHand = this.svc.rows().find((r) => r.product_id === v.product_id)?.quantity ?? 0;
      if (Math.abs(v.quantity) > onHand) {
        this.formError.set(`Only ${onHand} on hand — reduce the outbound quantity.`);
        this.saving.set(false);
        return;
      }
    }

    const err = await this.svc.recordMovement(
      objectId, v.product_id, v.movement_type, signed, profile.id, v.note.trim() || null
    );
    this.saving.set(false);
    if (err) this.formError.set(err);
    else this.drawerOpen.set(false);
  }

  async openHistory(r: InventoryRow): Promise<void> {
    const objectId = this.selectedObjectId();
    if (!objectId) return;
    this.historyProductName.set(r.product?.name ?? 'Product');
    this.historyOpen.set(true);
    await this.svc.loadMovements(objectId, r.product_id);
  }

  closeHistory(): void {
    this.historyOpen.set(false);
  }

  /** Small helper: colour the signed quantity green (in) / red (out). */
  isPositive(qty: number): boolean {
    return qty > 0;
  }
}
