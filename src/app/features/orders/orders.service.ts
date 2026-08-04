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

  /** Create an order header + its line items. */
  async create(
    objectId: string,
    createdBy: string,
    comment: string | null,
    lines: NewOrderLine[]
  ): Promise<string | null> {
    // 1. Insert the header, get its id back
    const { data: header, error: headerErr } = await supabase
      .from('orders')
      .insert({ object_id: objectId, created_by: createdBy, comment })
      .select('id')
      .single();

    if (headerErr) return headerErr.message;

    // 2. Insert the line items pointing at that header
    const rows = lines.map((l) => ({
      order_id: header.id,
      product_id: l.product_id,
      quantity: l.quantity,
    }));

    const { error: itemsErr } = await supabase.from('order_items').insert(rows);
    if (itemsErr) return itemsErr.message;

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