import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { Order, OrderStatus, NewOrderLine } from './order.model';

@Injectable({ providedIn: 'root' })
export class OrdersService {
  readonly orders = signal<Order[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  /** Load orders with their object + line items joined. RLS scopes admin vs seller. */
  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const { data, error } = await supabase
      .from('orders')
      .select(`
        *,
        object:objects ( name ),
        order_items ( id, order_id, product_id, quantity, product:products ( name, sku ) )
      `)
      .order('created_at', { ascending: false });

    if (error) this.error.set(error.message);
    else this.orders.set((data ?? []) as unknown as Order[]);
    this.loading.set(false);
  }

  /** Create an order header + its line items — atomically via RPC. */
  async create(
    objectId: string,
    createdBy: string,          // kept for signature compatibility; server uses auth.uid()
    comment: string | null,
    lines: NewOrderLine[]
  ): Promise<string | null> {
    const { error } = await supabase.rpc('create_order_with_items', {
      p_object_id: objectId,
      p_comment: comment,
      p_items: lines.map((l) => ({
        product_id: l.product_id,
        quantity: l.quantity,
      })),
    });

    if (error) return error.message;
    await this.load();
    return null;
  }

  /** Admin: change an order's status. */
  async setStatus(orderId: string, status: OrderStatus): Promise<string | null> {
    const { error } = await supabase.from('orders').update({ status }).eq('id', orderId);
    if (error) return error.message;
    await this.load();
    return null;
  }
}