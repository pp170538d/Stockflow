import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators,
} from '@angular/forms';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { InventoryService } from './inventory.service';
import { InventoryRow, MovementEvent, MANUAL_EVENTS } from './inventory.model';
import { BusinessObject } from '../objects/object.model';
import { Product } from '../products/product.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { DrawerComponent } from '../../shared/ui/drawer.component';
import { StockHistoryDialogComponent } from './stock-history-dialog.component';

const LOW_STOCK_THRESHOLD = 10;

/** A signed correction can be + or -, but never 0. */
function notZero(control: AbstractControl): ValidationErrors | null {
  const v = control.value;
  return v === 0 || v === null || v === '' ? { zero: true } : null;
}

@Component({
  selector: 'app-inventory',
  standalone: true,
  imports: [
    DatePipe,
    RouterLink,
    ReactiveFormsModule,
    BadgeComponent,
    EmptyStateComponent,
    DrawerComponent,
    StockHistoryDialogComponent,
  ],
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

  // Dedicated full-history chart dialog
  readonly chartOpen = signal(false);
  readonly chartProductId = signal<string | null>(null);
  readonly chartProductName = signal('');
  readonly chartSku = signal('');
  readonly chartObjectName = computed(() => {
    const objectId = this.selectedObjectId();
    return this.objects().find((object) => object.id === objectId)?.name ?? 'Current object';
  });
  readonly historyObjectId = signal<string | null>(null);
  readonly historyProductId = signal<string | null>(null);
  readonly movementSearch = signal('');
  readonly movementEventFilter = signal<MovementEvent | ''>('');
  readonly movementEvents: MovementEvent[] = [
    'DELIVERY',
    'SALE',
    'STOCK_COUNT',
    'ADJUSTMENT',
    'TRANSFER',
    'RETURN',
    'WRITE_OFF',
  ];
  private movementSearchTimer: ReturnType<typeof setTimeout> | null = null;

  /** Events offered in the manual drawer (DELIVERY/SALE/COUNT/TRANSFER come
   *  from their own flows). */
  readonly manualEvents = MANUAL_EVENTS;

  readonly isAdmin = computed(() => this.auth.isAdmin());

  readonly form = this.fb.nonNullable.group({
    product_id: ['', [Validators.required]],
    event: ['ADJUSTMENT' as MovementEvent, [Validators.required]],
    quantity: [1, [Validators.required, notZero]],
    note: [''],
  });

  constructor() {
    // ADJUSTMENT may go either way (exempt from the guard) ? notZero.
    // RETURN (in) and WRITE_OFF (out) are positive magnitudes ? min(1).
    this.form.controls.event.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((ev) => {
        const qty = this.form.controls.quantity;
        qty.setValidators(
          ev === 'ADJUSTMENT'
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

  /** Human label for the event dropdown. */
  eventLabel(ev: MovementEvent): string {
    return {
      ADJUSTMENT: 'ADJUSTMENT (signed correction)',
      RETURN: 'RETURN (add back to stock)',
      WRITE_OFF: 'WRITE-OFF (remove � damage/loss)',
      DELIVERY: 'DELIVERY',
      SALE: 'SALE (sold � stock out)',
      STOCK_COUNT: 'STOCK COUNT',
      TRANSFER: 'TRANSFER',
    }[ev];
  }

  async openRecord(): Promise<void> {
    const objectId = this.selectedObjectId();
    if (!objectId) return;
    this.formError.set(null);
    this.form.reset({ product_id: '', event: 'ADJUSTMENT', quantity: 1, note: '' });
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

    // Convert entered value into a SIGNED quantity by event:
    //  RETURN     ? always positive magnitude (stock in)
    //  WRITE_OFF  ? always negative magnitude (stock out)
    //  ADJUSTMENT ? keep the sign the user entered (correction either way)
    let signed: number;
    if (v.event === 'RETURN') signed = Math.abs(v.quantity);
    else if (v.event === 'WRITE_OFF' || v.event === 'SALE') signed = -Math.abs(v.quantity);
    else signed = v.quantity; // ADJUSTMENT

    if (signed === 0) {
      this.formError.set('Quantity cannot be zero.');
      this.saving.set(false);
      return;
    }

    // Instant client-side guard for WRITE_OFF (an out-event that respects
    // on-hand stock). ADJUSTMENT is intentionally exempt.
    if (v.event === 'WRITE_OFF' || v.event === 'SALE') {
      const onHand = this.svc.rows().find((r) => r.product_id === v.product_id)?.quantity ?? 0;
      if (Math.abs(v.quantity) > onHand) {
        const noun = v.event === 'SALE' ? 'sale' : 'write-off';
        this.formError.set(`Only ${onHand} on hand � reduce the ${noun} quantity.`);
        this.saving.set(false);
        return;
      }
    }

    const err = await this.svc.recordMovement(
      objectId, v.product_id, v.event, signed, profile.id, v.note.trim() || null
    );
    this.saving.set(false);
    if (err) this.formError.set(err);
    else this.drawerOpen.set(false);
  }

  openChart(r: InventoryRow): void {
    if (!this.selectedObjectId()) return;

    this.chartProductId.set(r.product_id);
    this.chartProductName.set(r.product?.name ?? 'Product');
    this.chartSku.set(r.product?.sku ?? '');
    this.chartOpen.set(true);
  }

  closeChart(): void {
    this.chartOpen.set(false);
    this.chartProductId.set(null);
  }

  async openHistory(r: InventoryRow): Promise<void> {
    const objectId = this.selectedObjectId();

    if (!objectId) return;

    this.historyProductName.set(r.product?.name ?? 'Product');
    this.historyObjectId.set(objectId);
    this.historyProductId.set(r.product_id);
    this.movementSearch.set('');
    this.movementEventFilter.set('');
    this.historyOpen.set(true);

    await this.svc.loadMovements(objectId, r.product_id, { page: 1 });
  }

  closeHistory(): void {
    this.historyOpen.set(false);
  }

  reloadMovements(page = 1): void {
    const objectId = this.historyObjectId();
    const productId = this.historyProductId();

    if (!objectId || !productId) return;

    void this.svc.loadMovements(objectId, productId, {
      page,
      event: this.movementEventFilter(),
      search: this.movementSearch(),
    });
  }

  onMovementEventChange(event: MovementEvent | ''): void {
    this.movementEventFilter.set(event);
    this.reloadMovements(1);
  }

  onMovementSearch(value: string): void {
    this.movementSearch.set(value);

    if (this.movementSearchTimer) {
      clearTimeout(this.movementSearchTimer);
    }

    this.movementSearchTimer = setTimeout(() => {
      this.reloadMovements(1);
    }, 250);
  }

  previousMovements(): void {
    const objectId = this.historyObjectId();
    const productId = this.historyProductId();

    if (!objectId || !productId) return;

    void this.svc.previousMovements(objectId, productId, {
      event: this.movementEventFilter(),
      search: this.movementSearch(),
    });
  }

  nextMovements(): void {
    const objectId = this.historyObjectId();
    const productId = this.historyProductId();

    if (!objectId || !productId) return;

    void this.svc.nextMovements(objectId, productId, {
      event: this.movementEventFilter(),
      search: this.movementSearch(),
    });
  }

  /** Colour the signed quantity green (in) / red (out). */
  isPositive(qty: number): boolean {
    return qty > 0;
  }
}
