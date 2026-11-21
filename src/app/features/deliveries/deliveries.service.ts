import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import {
  DeliveryException, DeliveryLineInput, GoodsReceipt, OrderFulfillment, Resolution,
} from './delivery.model';

/** Compact per-order variance summary for the orders-list chip. */
export interface OrderVariance {
  order_id: string;
  short: number;
  over: number;
  net: number;
  open: number;
}

@Injectable({ providedIn: 'root' })
export class DeliveriesService {
  readonly fulfillment = signal<OrderFulfillment[]>([]);
  readonly receipt = signal<GoodsReceipt | null>(null);
  readonly loading = signal<boolean>(false);
  readonly saving = signal<boolean>(false);
  readonly resolving = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly variances = signal<Record<string, OrderVariance>>({});

  /** Used by Confirm delivery. */
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

  /** Variance + open-decision count per order, in two queries (no N+1). */
  async loadVariances(orderIds: string[]): Promise<void> {
    if (orderIds.length === 0) {
      this.variances.set({});
      return;
    }

    const [{ data, error }, open] = await Promise.all([
      supabase
        .from('order_fulfillment')
        .select('order_id, ordered_qty, delivered_qty, variance')
        .in('order_id', orderIds),
      supabase.rpc('delivery_exceptions', { p_status: 'open', p_object_id: null, p_delivery_id: null }),
    ]);
    if (error) return;

    const openByOrder = new Map<string, number>();
    for (const r of (open.data ?? []) as DeliveryException[]) {
      openByOrder.set(r.order_id, (openByOrder.get(r.order_id) ?? 0) + 1);
    }

    const map: Record<string, OrderVariance> = {};
    for (const r of (data ?? []) as OrderFulfillment[]) {
      const v = r.variance ?? 0;
      const acc = (map[r.order_id] ??= {
        order_id: r.order_id, short: 0, over: 0, net: 0, open: openByOrder.get(r.order_id) ?? 0,
      });
      acc.net += v;
      if (v < 0) acc.short++;
      else if (v > 0) acc.over++;
    }
    for (const id of Object.keys(map)) {
      if (map[id].short === 0 && map[id].over === 0) delete map[id];
    }
    this.variances.set(map);
  }

  /** Full goods receipt for a delivered order. */
  async loadReceipt(orderId: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const { data: d } = await supabase
      .from('deliveries')
      .select('id')
      .eq('order_id', orderId)
      .maybeSingle();

    if (!d) {
      this.receipt.set(null);
      this.loading.set(false);
      return;
    }

    await this.refreshReceipt(d.id as string);
    this.loading.set(false);
  }

  private async refreshReceipt(deliveryId: string): Promise<void> {
    const { data, error } = await supabase.rpc('goods_receipt', { p_delivery_id: deliveryId });
    if (error) {
      this.error.set(this.friendly(error.message));
      this.receipt.set(null);
      return;
    }
    this.receipt.set(data as GoodsReceipt);
  }

  /** Admin decision on one or more lines of the current receipt. */
  async resolve(
    lineIds: string[],
    resolution: Resolution,
    note: string | null
  ): Promise<{ error: string | null; resolved?: number; backorderNumber?: string | null }> {
    if (lineIds.length === 0) return { error: 'Nothing selected.' };

    this.resolving.set(true);
    const { data, error } = await supabase.rpc('resolve_delivery_lines', {
      p_line_ids: lineIds,
      p_resolution: resolution,
      p_note: note,
    });
    this.resolving.set(false);

    if (error) return { error: this.friendly(error.message) };

    const deliveryId = this.receipt()?.delivery.id;
    if (deliveryId) await this.refreshReceipt(deliveryId);

    const result = (data ?? {}) as { resolved?: number; backorder_number?: string | null };
    return { error: null, resolved: result.resolved, backorderNumber: result.backorder_number ?? null };
  }

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
        reason_code: l.reason_code,
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

  private friendly(msg: string): string {
    if (msg.includes('DEMO_READONLY') || msg.includes('Demo account'))
      return 'This action is disabled in the demo account.';
    if (msg.includes('already been delivered'))
      return 'This order has already been delivered — a delivery is final and can not be repeated.';
    if (msg.includes('must be APPROVED'))
      return 'Only APPROVED orders can be delivered. Approve the order first.';
    if (msg.includes('A reason is required') || msg.includes('Invalid delivery reason'))
      return 'Pick a reason for every line where the delivered quantity differs from what was ordered.';
    if (msg.includes('must account for all'))
      return 'Every line of the order must be counted before you can confirm the delivery.';
    if (msg.includes('Insufficient stock'))
      return 'Not enough stock left to return these units — they may have been sold already.';
    if (
      msg.includes('already resolved') || msg.includes('only apply') || msg.includes('Add a note') ||
      msg.includes('Only admins') || msg.includes('one receipt') || msg.includes('exactly as ordered')
    ) return msg;
    if (msg.includes('violates row-level security'))
      return 'You don’t have permission to do this for this location.';
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError'))
      return 'Network issue — check your connection and try again.';
    return 'Could not complete the action. Please try again.';
  }
}
