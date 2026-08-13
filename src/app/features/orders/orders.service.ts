import { Injectable, computed, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { Order, OrderStatus, NewOrderLine } from './order.model';

export interface OrdersQuery {
  page: number;
  pageSize: number;
  status: OrderStatus | '';
  objectId: string;
  search: string;
}

@Injectable({ providedIn: 'root' })
export class OrdersService {
  readonly orders = signal<Order[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  readonly page = signal(1);
  readonly pageSize = signal(10);
  readonly total = signal(0);

  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.total() / this.pageSize()))
  );

  /**
   * Loads paginated orders from Supabase.
   *
   * Server-side filters:
   * - status
   * - object_id
   * - comment search
   *
   * RLS still decides whether the current user can see all orders
   * or only their own scoped orders.
   */
  async load(params: Partial<OrdersQuery> = {}): Promise<void> {
    const page = params.page ?? this.page();
    const pageSize = params.pageSize ?? this.pageSize();
    const status = params.status ?? '';
    const objectId = params.objectId ?? '';
    const search = (params.search ?? '').trim();

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    this.loading.set(true);
    this.error.set(null);

    let query = supabase
      .from('orders')
      .select(
        `
          *,
          object:objects ( name ),
          order_items (
            id,
            order_id,
            product_id,
            quantity,
            product:products ( name, sku )
          )
        `,
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(from, to);

    if (status) {
      query = query.eq('status', status);
    }

    if (objectId) {
      query = query.eq('object_id', objectId);
    }

    if (search) {
      query = query.ilike('comment', `%${search}%`);
    }

    const { data, error, count } = await query;

    if (error) {
      this.error.set(error.message);
      this.orders.set([]);
      this.total.set(0);
      this.loading.set(false);
      return;
    }

    this.orders.set((data ?? []) as unknown as Order[]);
    this.page.set(page);
    this.pageSize.set(pageSize);
    this.total.set(count ?? 0);
    this.loading.set(false);
  }

  /**
   * Create an order header + line items atomically via RPC.
   *
   * The service does not force-refresh the orders list because the create page
   * navigates back to /orders, where OrdersComponent will load the list.
   */
  async create(
    objectId: string,
    createdBy: string,
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

    if (error) {
      return error.message;
    }

    return null;
  }

  /**
   * Admin: change order status.
   *
   * Caller decides how to reload, so active filters/page are preserved.
   */
  async setStatus(orderId: string, status: OrderStatus): Promise<string | null> {
    const { error } = await supabase
      .from('orders')
      .update({ status })
      .eq('id', orderId);

    if (error) {
      return error.message;
    }

    return null;
  }

  async next(params: Omit<Partial<OrdersQuery>, 'page'> = {}): Promise<void> {
    if (this.page() >= this.totalPages()) {
      return;
    }

    await this.load({
      ...params,
      page: this.page() + 1,
    });
  }

  async previous(params: Omit<Partial<OrdersQuery>, 'page'> = {}): Promise<void> {
    if (this.page() <= 1) {
      return;
    }

    await this.load({
      ...params,
      page: this.page() - 1,
    });
  }
}