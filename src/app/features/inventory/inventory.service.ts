import { Injectable, computed, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { InventoryRow, StockMovement, MovementEvent } from './inventory.model';

export interface MovementsQuery {
  page: number;
  pageSize: number;
  event: MovementEvent | '';
  search: string;
}

@Injectable({ providedIn: 'root' })
export class InventoryService {
  readonly rows = signal<InventoryRow[]>([]);
  readonly movements = signal<StockMovement[]>([]);

  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  readonly movementsLoading = signal<boolean>(false);
  readonly movementsError = signal<string | null>(null);
  readonly movementsPage = signal(1);
  readonly movementsPageSize = signal(20);
  readonly movementsTotal = signal(0);

  readonly movementsTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.movementsTotal() / this.movementsPageSize()))
  );

  /** Current stock for one object, joined with product info. */
  async loadInventory(objectId: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const { data, error } = await supabase
      .from('inventory')
      .select('*, product:products ( name, sku, category )')
      .eq('object_id', objectId)
      .order('quantity', { ascending: true });

    if (error) {
      this.error.set(this.friendly(error.message));
    } else {
      this.rows.set((data ?? []) as unknown as InventoryRow[]);
    }

    this.loading.set(false);
  }

  /**
   * Paginated movement history for one object + product.
   * This keeps the history drawer fast even when the stock ledger grows.
   */
  async loadMovements(
    objectId: string,
    productId: string,
    params: Partial<MovementsQuery> = {}
  ): Promise<void> {
    const page = params.page ?? this.movementsPage();
    const pageSize = params.pageSize ?? this.movementsPageSize();
    const event = params.event ?? '';
    const search = (params.search ?? '').trim();

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    this.movementsLoading.set(true);
    this.movementsError.set(null);

    let query = supabase
      .from('stock_movements')
      .select('*, product:products ( name, sku )', { count: 'exact' })
      .eq('object_id', objectId)
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (event) {
      query = query.eq('event', event);
    }

    if (search) {
      const safe = search.replace(/,/g, ' ');
      query = query.or(`note.ilike.%${safe}%,reference.ilike.%${safe}%`);
    }

    const { data, error, count } = await query;

    if (error) {
      this.movementsError.set(this.friendly(error.message));
      this.movements.set([]);
      this.movementsTotal.set(0);
      this.movementsLoading.set(false);
      return;
    }

    this.movements.set((data ?? []) as unknown as StockMovement[]);
    this.movementsPage.set(page);
    this.movementsPageSize.set(pageSize);
    this.movementsTotal.set(count ?? 0);
    this.movementsLoading.set(false);
  }

  async nextMovements(
    objectId: string,
    productId: string,
    params: Omit<Partial<MovementsQuery>, 'page'> = {}
  ): Promise<void> {
    if (this.movementsPage() >= this.movementsTotalPages()) {
      return;
    }

    await this.loadMovements(objectId, productId, {
      ...params,
      page: this.movementsPage() + 1,
    });
  }

  async previousMovements(
    objectId: string,
    productId: string,
    params: Omit<Partial<MovementsQuery>, 'page'> = {}
  ): Promise<void> {
    if (this.movementsPage() <= 1) {
      return;
    }

    await this.loadMovements(objectId, productId, {
      ...params,
      page: this.movementsPage() - 1,
    });
  }

  /**
   * Record a movement. `quantity` should already be signed:
   * RETURN/DELIVERY positive, WRITE_OFF/SALE negative, ADJUSTMENT either.
   * The DB trigger updates inventory automatically and enforces oversell rules.
   */
  async recordMovement(
    objectId: string,
    productId: string,
    event: MovementEvent,
    signedQty: number,
    createdBy: string,
    note: string | null
  ): Promise<string | null> {
    if (signedQty === 0) {
      return 'Quantity cannot be zero.';
    }

    const { error } = await supabase.from('stock_movements').insert({
      object_id: objectId,
      product_id: productId,
      event,
      quantity: signedQty,
      reference: 'manual',
      note,
      created_by: createdBy,
    });

    if (error) {
      return this.friendly(error.message);
    }

    await this.loadInventory(objectId);
    return null;
  }

  /** Turn raw Postgres / trigger errors into human-readable messages. */
  private friendly(msg: string): string {
    if (msg.includes('Insufficient stock')) return msg;
    if (msg.includes('violates row-level security')) {
      return "You don't have permission to record a movement for this object.";
    }
    if (msg.includes('violates foreign key')) {
      return 'That product or object no longer exists. Please refresh and try again.';
    }
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      return 'Network issue - check your connection and try again.';
    }
    return 'Could not record the movement. Please try again.';
  }
}
