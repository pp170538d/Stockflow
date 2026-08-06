import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { Delivery, OrderFulfillment, DeliveryLineInput } from './delivery.model';

/** Compact per-order variance summary for the orders-list chip. */
export interface OrderVariance {
  order_id: string;
  short: number;   // count of lines delivered < ordered
  over: number;    // count of lines delivered > ordered
  net: number;     // total delivered − total ordered (signed)
}

@Injectable({ providedIn: 'root' })
export class DeliveriesService {
  readonly fulfillment = signal<OrderFulfillment[]>([]);
  readonly delivery = signal<Delivery | null>(null);
  readonly loading = signal<boolean>(false);
  readonly saving = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  /** order_id → variance summary, for the row-level chip on the orders list. */
  readonly variances = signal<Record<string, OrderVariance>>({});

  /**
   * Load the ordered-vs-delivered picture for one order (from the
   * `order_fulfillment` view), joined with product name/sku for display.
   */
  async loadFulfillment(orderId: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const { data, error } = await supabase
      .from('order_fulfillment')
      .select('*, product:products ( name, sku )')
      .eq('order_id', orderId);
    if (error) this.error.set(this.friendly(error.message));
    else this.fulfillment.set((data ?? []) as unknown as OrderFulfillment[]);
    this.loading.set(false);
  }

  /**
   * Bulk-load variance summaries for many orders in ONE query (no N+1).
   * Only rows with a delivery contribute; orders with no variance simply
   * don't appear in the map, so the chip is shown only where it matters.
   */
  async loadVariances(orderIds: string[]): Promise<void> {
    if (orderIds.length === 0) {
      this.variances.set({});
      return;
    }
    const { data, error } = await supabase
      .from('order_fulfillment')
      .select('order_id, ordered_qty, delivered_qty, variance')
      .in('order_id', orderIds);
    if (error) return; // silent — the chip is a nicety, never blocks the list

    const map: Record<string, OrderVariance> = {};
    for (const r of (data ?? []) as OrderFulfillment[]) {
      const v = r.variance ?? 0;
      const acc = (map[r.order_id] ??= { order_id: r.order_id, short: 0, over: 0, net: 0 });
      acc.net += v;
      if (v < 0) acc.short++;
      else if (v > 0) acc.over++;
    }
    // Drop entries that ended up perfectly matched (no short & no over)
    for (const id of Object.keys(map)) {
      if (map[id].short === 0 && map[id].over === 0) delete map[id];
    }
    this.variances.set(map);
  }

  /** Fetch the (single) delivery for an order, if one exists. */
  async loadDelivery(orderId: string): Promise<void> {
    const { data } = await supabase
      .from('deliveries')
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle();
    this.delivery.set((data ?? null) as Delivery | null);
  }

  /**
   * Record THE delivery for an order via the atomic RPC.
   * The DB enforces: APPROVED-only, one-per-order, all lines accounted for,
   * reason required on variance, and inbound stock sync. We surface any of
   * those as friendly messages.
   */
  async record(
    orderId: string,
    carrier: string | null,
    receivedBy: string | null,
    note: string | null,
    lines: DeliveryLineInput[]
  ): Promise<string | null> {
    this.saving.set(true);
    this.error.set(null);
    const { error } = await supabase.rpc('record_delivery', {
      p_order_id: orderId,
      p_carrier: carrier,
      p_received_by: receivedBy,
      p_note: note,
      p_items: lines.map((l) => ({
        order_item_id: l.order_item_id,
        delivered_qty: l.delivered_qty,
        reason: l.reason,
      })),
    });
    this.saving.set(false);
    if (error) {
      const msg = this.friendly(error.message);
      this.error.set(msg);
      return msg;
    }
    return null;
  }

  /** Turn raw Postgres / RPC exceptions into human-readable messages. */
  private friendly(msg: string): string {
    if (msg.includes('already been delivered'))
      return 'This order has already been delivered — a delivery is final and can’t be repeated.';
    if (msg.includes('must be APPROVED'))
      return 'Only APPROVED orders can be delivered. Approve the order first.';
    if (msg.includes('A reason is required'))
      return 'Add a reason for every line where the delivered quantity differs from what was ordered.';
    if (msg.includes('must account for all'))
      return 'Every line of the order must be counted before you can confirm the delivery.';
    if (msg.includes('does not belong to order'))
      return 'One of the lines no longer matches this order. Please refresh and try again.';
    if (msg.includes('violates row-level security'))
      return 'You don’t have permission to record a delivery for this object.';
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError'))
      return 'Network issue — check your connection and try again.';
    return 'Could not record the delivery. Please try again.';
  }
}
