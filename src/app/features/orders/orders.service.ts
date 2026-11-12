import { Injectable, computed, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { Order, OrderStatus, NewOrderLine } from './order.model';
import { demoFriendly } from '../../core/demo-error';

export interface OrdersQuery {
  page: number;
  pageSize: number;
  status: OrderStatus | '';
  objectId: string;
  search: string;
  exceptionsOnly: boolean;
}

export interface CreatedOrder {
  id: string;
  orderNumber: string;
}

const BLOCKED = 'This action is disabled in the demo account.';

@Injectable({ providedIn: 'root' })
export class OrdersService {
  readonly orders = signal<Order[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly page = signal(1);
  readonly pageSize = signal(10);
  readonly total = signal(0);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));

  async load(params: Partial<OrdersQuery> = {}): Promise<void> {
  const page = params.page ?? this.page();
  const pageSize = params.pageSize ?? this.pageSize();
  const status = params.status ?? '';
  const objectId = params.objectId ?? '';
  const search = (params.search ?? '').trim();
  const exceptionsOnly = params.exceptionsOnly ?? false;

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  this.loading.set(true);
  this.error.set(null);

  let exceptionOrderIds: string[] = [];

  if (exceptionsOnly) {
    const { data: exceptionRows, error: exceptionError } =
      await supabase
        .from('order_fulfillment')
        .select('order_id')
        .neq('variance', 0);

    if (exceptionError) {
      this.error.set(exceptionError.message);
      this.orders.set([]);
      this.total.set(0);
      this.page.set(1);
      this.loading.set(false);
      return;
    }

    exceptionOrderIds = [
      ...new Set(
        (exceptionRows ?? []).map(
          (row) => row.order_id as string
        )
      ),
    ];

    if (exceptionOrderIds.length === 0) {
      this.orders.set([]);
      this.total.set(0);
      this.page.set(1);
      this.pageSize.set(pageSize);
      this.loading.set(false);
      return;
    }
  }

  let query = supabase
    .from('orders')
    .select(`
      id,
      order_number,
      object_id,
      supplier_id,
      status,
      comment,
      created_by,
      created_at,
      approved_at,
      approved_by,
      company_snapshot,
      supplier_snapshot,
      delivery_snapshot,
      prepared_by_snapshot,
      object:objects (
        name
      ),
      supplier:suppliers (
        id,
        name,
        order_email,
        active
      ),
      order_items (
        id,
        order_id,
        product_id,
        quantity,
        product:products (
          name,
          sku
        )
      )
    `, {
      count: 'exact',
    })
    .order('created_at', {
      ascending: false,
    });

  if (exceptionsOnly) {
    query = query
      .eq('status', 'DELIVERED')
      .in('id', exceptionOrderIds);
  } else if (status) {
    query = query.eq(
      'status',
      status
    );
  }

  if (objectId) {
    query = query.eq(
      'object_id',
      objectId
    );
  }

  if (search) {
    const escaped = search.replace(
      /[%_,()]/g,
      ''
    );

    query = query.or(
      `order_number.ilike.%${escaped}%,comment.ilike.%${escaped}%`
    );
  }

  query = query.range(from, to);

  const {
    data,
    error,
    count,
  } = await query;

  if (error) {
    this.error.set(error.message);
    this.orders.set([]);
    this.total.set(0);
    this.loading.set(false);
    return;
  }

  this.orders.set(
    (data ?? []) as unknown as Order[]
  );

  this.page.set(page);
  this.pageSize.set(pageSize);
  this.total.set(count ?? 0);
  this.loading.set(false);
}

  async create(
    objectId: string,
    supplierId: string,
    comment: string | null,
    lines: NewOrderLine[]
  ): Promise<{ order: CreatedOrder | null; error: string | null }> {
    const { data: orderId, error } = await supabase.rpc('create_order_with_items', {
      p_object_id: objectId,
      p_comment: comment,
      p_items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
      p_supplier_id: supplierId,
    });

    if (error) return { order: null, error: friendly(error.message) };
    if (!orderId) return { order: null, error: 'The order was created but its ID was not returned.' };

    const { data: created, error: readError } = await supabase
      .from('orders')
      .select('id, order_number')
      .eq('id', orderId)
      .single();

    if (readError) return { order: null, error: friendly(readError.message) };
    return {
      order: { id: created.id, orderNumber: created.order_number },
      error: null,
    };
  }

  async setStatus(orderId: string, status: OrderStatus): Promise<string | null> {
    const { data, error } = await supabase
      .from('orders')
      .update({ status })
      .eq('id', orderId)
      .select('id');

    if (error) return friendly(error.message);
    if (!data || data.length === 0) return BLOCKED;
    return null;
  }

  async next(params: Omit<Partial<OrdersQuery>, 'page'> = {}): Promise<void> {
    if (this.page() >= this.totalPages()) return;
    await this.load({ ...params, page: this.page() + 1 });
  }

  async previous(params: Omit<Partial<OrdersQuery>, 'page'> = {}): Promise<void> {
    if (this.page() <= 1) return;
    await this.load({ ...params, page: this.page() - 1 });
  }
}

function friendly(message: string): string {
  const demo = demoFriendly(message);
  if (demo !== message) return demo;
  if (message.includes('Select a supplier')) return 'Select a supplier before approving this order.';
  if (message.includes('Inactive supplier')) return 'This supplier is inactive. Choose an active supplier.';
  if (message.includes('Complete Settings')) return 'Complete Settings → Company profile before approving purchase orders.';
  if (message.includes('Supplier does not exist')) return 'The selected supplier is no longer available.';
  return message;
}
