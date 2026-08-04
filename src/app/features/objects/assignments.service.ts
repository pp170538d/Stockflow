import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { Product } from '../products/product.model';

@Injectable({ providedIn: 'root' })
export class AssignmentsService {
  /** All active products (the full pick-list). */
  readonly allProducts = signal<Product[]>([]);
  /** Set of product IDs currently assigned to the open object. */
  readonly assignedIds = signal<Set<string>>(new Set());
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  /** Load the pick-list + current assignments for one object. */
  async loadFor(objectId: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const [productsRes, assignedRes] = await Promise.all([
      supabase.from('products').select('*').eq('active', true).order('name'),
      supabase.from('object_products').select('product_id').eq('object_id', objectId),
    ]);

    if (productsRes.error) this.error.set(productsRes.error.message);
    else this.allProducts.set((productsRes.data ?? []) as Product[]);

    if (assignedRes.error) this.error.set(assignedRes.error.message);
    else this.assignedIds.set(new Set((assignedRes.data ?? []).map((r) => r.product_id)));

    this.loading.set(false);
  }

  /** Toggle a single product on/off for an object (optimistic UI). */
  async toggle(objectId: string, productId: string): Promise<void> {
    const current = new Set(this.assignedIds());
    const isAssigned = current.has(productId);

    // Optimistic update
    if (isAssigned) current.delete(productId);
    else current.add(productId);
    this.assignedIds.set(current);

    if (isAssigned) {
      const { error } = await supabase
        .from('object_products')
        .delete()
        .eq('object_id', objectId)
        .eq('product_id', productId);
      if (error) this.revert(productId, true);
    } else {
      const { error } = await supabase
        .from('object_products')
        .insert({ object_id: objectId, product_id: productId });
      if (error) this.revert(productId, false);
    }
  }

  /** Roll back optimistic change if the DB call failed. */
  private revert(productId: string, wasAssigned: boolean): void {
    const s = new Set(this.assignedIds());
    if (wasAssigned) s.add(productId);
    else s.delete(productId);
    this.assignedIds.set(s);
    this.error.set('Could not save the change. Please try again.');
  }
}