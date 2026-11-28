import { Injectable, computed, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { Order, OrderStatus, NewOrderLine } from './order.model';
import { demoFriendly } from '../../core/demo-error';
import { IdempotencyKey } from '../../core/idempotency';
export interface OrdersQuery {
    page: number;
    pageSize: number;
    status: OrderStatus | '';
    objectId: string;
    search: string;
    exceptionsOnly: boolean;
    workQueue: boolean;
    receivedThisMonth: boolean;
}
export interface CreatedOrder { id: string; orderNumber: string; }
const BLOCKED = 'This action is disabled in the demo account.';
const SELECT = `id,order_number,object_id,supplier_id,status,comment,created_by,created_at,approved_at,approved_by,cancel_reason_code,cancel_note,cancelled_at,cancelled_by,company_snapshot,supplier_snapshot,delivery_snapshot,prepared_by_snapshot,object:objects(name),supplier:suppliers(id,name,order_email,active),order_items(id,order_id,product_id,quantity,unit_cost,product:products(name,sku))`;
@Injectable({ providedIn: 'root' })
export class OrdersService {
    private readonly createKey = new IdempotencyKey(); private readonly cancelKey = new IdempotencyKey(); readonly orders = signal<Order[]>([]); readonly loading = signal(false); readonly error = signal<string | null>(null); readonly page = signal(1); readonly pageSize = signal(10); readonly total = signal(0); readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
    async load(params: Partial<OrdersQuery> = {}): Promise<void> {
        const page = params.page ?? this.page(), pageSize = params.pageSize ?? this.pageSize(), status = params.status ?? '', objectId = params.objectId ?? '', search = (params.search ?? '').trim(), exceptionsOnly = params.exceptionsOnly ?? false, workQueue = params.workQueue ?? false;
        const receivedThisMonth =
            params.receivedThisMonth ?? false;
        const from = (page - 1) * pageSize; this.loading.set(true); this.error.set(null);
        if (workQueue) {
            const { data: queue, error: qError } = await supabase.rpc('orders_work_queue', { p_object_id: objectId || null, p_search: search || null, p_offset: from, p_limit: pageSize });
            if (qError) { this.fail(qError.message); return; } const rows = (queue ?? []) as { order_id: string; total_count: number }[]; const ids = rows.map(r => r.order_id);
            if (!ids.length) { this.orders.set([]); this.total.set(0); this.page.set(page); this.pageSize.set(pageSize); this.loading.set(false); return; }
            const { data, error } = await supabase.from('orders').select(SELECT).in('id', ids);
            if (error) { this.fail(error.message); return; } const byId = new Map(((data ?? []) as any[]).map(o => [o.id, o])); this.orders.set(ids.map(id => byId.get(id)).filter(Boolean) as unknown as Order[]); this.total.set(Number(rows[0]?.total_count ?? 0)); this.page.set(page); this.pageSize.set(pageSize); this.loading.set(false); return;
        }
        let actionOrderIds: string[] = [];
        if (exceptionsOnly) { const [{ data: ex, error: ee }, { data: held, error: he }] = await Promise.all([supabase.rpc('delivery_exceptions', { p_status: 'open', p_object_id: objectId || null, p_delivery_id: null }), (() => { let q = supabase.from('held_stock_overview').select('delivery_id,object_id,remaining_qty').gt('remaining_qty', 0); if (objectId) q = q.eq('object_id', objectId); return q; })()]); if (ee || he) { this.fail((ee ?? he)!.message); return; } const ids = new Set<string>(((ex ?? []) as any[]).map(r => r.order_id).filter(Boolean)); const deliveryIds = [...new Set(((held ?? []) as any[]).map(r => r.delivery_id).filter(Boolean))]; if (deliveryIds.length) { const { data } = await supabase.from('deliveries').select('order_id').in('id', deliveryIds); for (const r of (data ?? []) as any[]) if (r.order_id) ids.add(r.order_id); } actionOrderIds = [...ids]; if (!actionOrderIds.length) { this.orders.set([]); this.total.set(0); this.page.set(1); this.pageSize.set(pageSize); this.loading.set(false); return; } }
        if (receivedThisMonth) {
            const monthStart =
                new Date(
                    new Date().getFullYear(),
                    new Date().getMonth(),
                    1
                ).toISOString();

            let deliveryQuery = supabase
                .from('deliveries')
                .select(
                    'order_id',
                    {
                        count: 'exact',
                    }
                )
                .gte(
                    'delivered_at',
                    monthStart
                )
                .order(
                    'delivered_at',
                    {
                        ascending: false,
                    }
                );

            if (objectId) {
                deliveryQuery =
                    deliveryQuery.eq(
                        'object_id',
                        objectId
                    );
            }

            const {
                data: deliveryRows,
                error: deliveryError,
            } = await deliveryQuery;

            if (deliveryError) {
                this.fail(
                    deliveryError.message
                );

                return;
            }

            const deliveredOrderIds = [
                ...new Set(
                    (
                        deliveryRows ?? []
                    )
                        .map(
                            (row: any) =>
                                row.order_id as string
                        )
                        .filter(Boolean)
                ),
            ];

            if (
                !deliveredOrderIds.length
            ) {
                this.orders.set([]);
                this.total.set(0);
                this.page.set(1);
                this.pageSize.set(pageSize);
                this.loading.set(false);

                return;
            }

            let monthlyQuery = supabase
                .from('orders')
                .select(
                    SELECT,
                    {
                        count: 'exact',
                    }
                )
                .eq(
                    'status',
                    'DELIVERED'
                )
                .in(
                    'id',
                    deliveredOrderIds
                )
                .order(
                    'created_at',
                    {
                        ascending: false,
                    }
                );

            if (objectId) {
                monthlyQuery =
                    monthlyQuery.eq(
                        'object_id',
                        objectId
                    );
            }

            if (search) {
                const escaped =
                    search.replace(
                        /[%_,()]/g,
                        ''
                    );

                monthlyQuery =
                    monthlyQuery.or(
                        `order_number.ilike.%${escaped}%,comment.ilike.%${escaped}%`
                    );
            }

            const {
                data,
                error,
                count,
            } = await monthlyQuery.range(
                from,
                from + pageSize - 1
            );

            if (error) {
                this.fail(error.message);
                return;
            }

            this.orders.set(
                (
                    data ?? []
                ) as unknown as Order[]
            );

            this.page.set(page);
            this.pageSize.set(pageSize);
            this.total.set(
                count ?? 0
            );

            this.loading.set(false);

            return;
        }
        let query = supabase.from('orders').select(SELECT, { count: 'exact' }).order('created_at', { ascending: false }); if (exceptionsOnly) query = query.eq('status', 'DELIVERED').in('id', actionOrderIds); else if (status) query = query.eq('status', status); if (objectId) query = query.eq('object_id', objectId); if (search) { const e = search.replace(/[%_,()]/g, ''); query = query.or(`order_number.ilike.%${e}%,comment.ilike.%${e}%`); } const { data, error, count } = await query.range(from, from + pageSize - 1); if (error) { this.fail(error.message); return; } this.orders.set((data ?? []) as unknown as Order[]); this.page.set(page); this.pageSize.set(pageSize); this.total.set(count ?? 0); this.loading.set(false);
    }
    private fail(m: string) { this.error.set(m); this.orders.set([]); this.total.set(0); this.loading.set(false); }
    async create(objectId: string, supplierId: string | null, comment: string | null, lines: NewOrderLine[]): Promise<{ order: CreatedOrder | null; error: string | null }> { const items = lines.map(l => ({ product_id: l.product_id, quantity: l.quantity })); const { data: orderId, error } = await supabase.rpc('create_order_with_items', { p_object_id: objectId, p_comment: comment, p_items: items, p_supplier_id: supplierId, p_idempotency_key: this.createKey.for({ objectId, supplierId, comment, items }) }); if (error) return { order: null, error: friendly(error.message) }; this.createKey.done(); if (!orderId) return { order: null, error: 'The order was created but its ID was not returned.' }; const { data: created, error: readError } = await supabase.from('orders').select('id,order_number').eq('id', orderId).single(); if (readError) return { order: null, error: friendly(readError.message) }; return { order: { id: created.id, orderNumber: created.order_number }, error: null }; }
    async cancelOrder(orderId:string,reasonCode:string,note:string):Promise<{error:unknown|null}>{
      const payload={orderId,reasonCode,note};
      const {error}=await supabase.rpc('cancel_order',{p_order_id:orderId,p_reason_code:reasonCode,p_note:note||null,p_idempotency_key:this.cancelKey.for(payload)});
      if(!error)this.cancelKey.done();
      return {error};
    }
    async setStatus(orderId: string, status: OrderStatus): Promise<string | null> { const { data, error } = await supabase.from('orders').update({ status }).eq('id', orderId).select('id'); if (error) return friendly(error.message); if (!data || !data.length) return BLOCKED; return null; }
    async next(params: Omit<Partial<OrdersQuery>, 'page'> = {}): Promise<void> { if (this.page() >= this.totalPages()) return; await this.load({ ...params, page: this.page() + 1 }); }
    async previous(params: Omit<Partial<OrdersQuery>, 'page'> = {}): Promise<void> { if (this.page() <= 1) return; await this.load({ ...params, page: this.page() - 1 }); }
}
function friendly(message: string) { const d = demoFriendly(message); if (d !== message) return d; if (message.includes('Select a supplier')) return 'Select a supplier before approving this order.'; if (message.includes('Inactive supplier')) return 'This supplier is inactive. Choose an active supplier.'; if (message.includes('Complete Settings')) return 'Complete Settings → Company profile before approving purchase orders.'; if (message.includes('Supplier does not exist')) return 'The selected supplier is no longer available.'; return message; }
