import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { InventoryRow, StockMovement, MovementEvent } from './inventory.model';

@Injectable({ providedIn: 'root' })
export class InventoryService {
  readonly rows = signal<InventoryRow[]>([]);
  readonly movements = signal<StockMovement[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  /** Current stock for one object (joined with product info). */
  async loadInventory(objectId: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const { data, error } = await supabase
      .from('inventory')
      .select('*, product:products ( name, sku, category )')
      .eq('object_id', objectId)
      .order('quantity', { ascending: true });
    if (error) this.error.set(this.friendly(error.message));
    else this.rows.set((data ?? []) as unknown as InventoryRow[]);
    this.loading.set(false);
  }

  /** Movement history for one object+product (the "why did it change"). */
  async loadMovements(objectId: string, productId: string): Promise<void> {
    const { data, error } = await supabase
      .from('stock_movements')
      .select('*, product:products ( name, sku )')
      .eq('object_id', objectId)
      .eq('product_id', productId)
      .order('created_at', { ascending: false });
    if (error) this.error.set(this.friendly(error.message));
    else this.movements.set((data ?? []) as unknown as StockMovement[]);
  }

  /**
   * Record a movement. `quantity` should already be SIGNED:
   *  RETURN/DELIVERY → positive, WRITE_OFF/SALE → negative, ADJUSTMENT → either.
   * The DB trigger updates inventory automatically and enforces per-event
   * oversell rules (SALE / WRITE_OFF / TRANSFER cannot go below zero).
   */
  async recordMovement(
    objectId: string,
    productId: string,
    event: MovementEvent,
    signedQty: number,
    createdBy: string,
    note: string | null
  ): Promise<string | null> {
    if (signedQty === 0) return 'Quantity cannot be zero.';
    const { error } = await supabase.from('stock_movements').insert({
      object_id: objectId,
      product_id: productId,
      event,                       // ← semantic event (was movement_type)
      quantity: signedQty,
      reference: 'manual',
      note,
      created_by: createdBy,
    });
    if (error) return this.friendly(error.message);
    await this.loadInventory(objectId);
    return null;
  }

  /** Turn raw Postgres / trigger errors into human-readable messages. */
  private friendly(msg: string): string {
    if (msg.includes('Insufficient stock')) return msg;               // keep the numbers
    if (msg.includes('violates row-level security'))
      return 'You don’t have permission to record a movement for this object.';
    if (msg.includes('violates foreign key'))
      return 'That product or object no longer exists. Please refresh and try again.';
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError'))
      return 'Network issue — check your connection and try again.';
    return 'Could not record the movement. Please try again.';
  }
}
