
import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { IdempotencyKey } from '../../core/idempotency';
import {
  DeliveryException, DeliveryLineInput, DeliveryMetaInput, GoodsReceipt,
  OrderFulfillment, ReceiptAckInput, Resolution,
} from './delivery.model';

export interface OrderVariance { order_id: string; short: number; over: number; net: number; open: number; }

@Injectable({ providedIn: 'root' })
export class DeliveriesService {
  private readonly recordKey = new IdempotencyKey();
  private readonly resolveKey = new IdempotencyKey();
  private readonly ackKey = new IdempotencyKey();

  readonly fulfillment = signal<OrderFulfillment[]>([]);
  readonly receipt = signal<GoodsReceipt | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly resolving = signal(false);
  readonly savingAck = signal(false);
  readonly error = signal<string | null>(null);
  readonly variances = signal<Record<string, OrderVariance>>({});

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

  async loadVariances(orderIds: string[]): Promise<void> {
    if (!orderIds.length) { this.variances.set({}); return; }
    const [{ data, error }, open] = await Promise.all([
      supabase.from('order_fulfillment').select('order_id, ordered_qty, physical_qty, variance').in('order_id', orderIds),
      supabase.rpc('delivery_exceptions', { p_status: 'open', p_object_id: null, p_delivery_id: null }),
    ]);
    if (error) return;
    const openBy = new Map<string, number>();
    for (const r of (open.data ?? []) as DeliveryException[]) openBy.set(r.order_id, (openBy.get(r.order_id) ?? 0) + 1);
    const map: Record<string, OrderVariance> = {};
    for (const r of (data ?? []) as any[]) {
      const v = r.variance ?? 0;
      const a = (map[r.order_id] ??= { order_id: r.order_id, short: 0, over: 0, net: 0, open: openBy.get(r.order_id) ?? 0 });
      a.net += v;
      if (v < 0) a.short++;
      else if (v > 0) a.over++;
    }
    for (const id of Object.keys(map)) if (!map[id].short && !map[id].over && !map[id].open) delete map[id];
    this.variances.set(map);
  }

  async loadReceipt(orderId: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const { data: d } = await supabase.from('deliveries').select('id').eq('order_id', orderId).maybeSingle();
    if (!d) { this.receipt.set(null); this.loading.set(false); return; }
    await this.refreshReceipt(d.id as string);
    this.loading.set(false);
  }

  private async refreshReceipt(deliveryId: string): Promise<void> {
    const { data, error } = await supabase.rpc('goods_receipt', { p_delivery_id: deliveryId });
    if (error) { this.error.set(this.friendly(error.message)); this.receipt.set(null); }
    else this.receipt.set(data as GoodsReceipt);
  }

  async resolve(lineIds: string[], resolution: Resolution, note: string | null) {
    if (!lineIds.length) return { error: 'Nothing selected.' };
    this.resolving.set(true);
    const { data, error } = await supabase.rpc('resolve_delivery_lines', {
      p_line_ids: lineIds, p_resolution: resolution, p_note: note,
      p_idempotency_key: this.resolveKey.for({ lineIds, resolution, note }),
    });
    this.resolving.set(false);
    if (error) return { error: this.friendly(error.message) };
    this.resolveKey.done();
    const id = this.receipt()?.delivery.id;
    if (id) await this.refreshReceipt(id);
    const r = (data ?? {}) as any;
    return { error: null, resolved: r.resolved, backorderNumber: r.backorder_number ?? null };
  }

  async record(
    orderId: string,
    meta: DeliveryMetaInput,
    lines: DeliveryLineInput[]
  ): Promise<string | null> {
    this.saving.set(true);
    this.error.set(null);

    const items = lines.map((l) => ({
      order_item_id: l.order_item_id,
      physical_qty: l.physical_qty,
      accepted_qty: l.accepted_qty,

      held_qty: l.held_qty,
      immediate_return_qty: l.immediate_return_qty,

      rejection_reason_code: l.rejection_reason_code,

      // Legacy compatibility. SHORT / OVER are now calculated by the DB.
      reason_code: l.reason_code,

      reason: l.reason,
    }));

    const { error } = await supabase.rpc('record_delivery', {
      p_order_id: orderId,
      p_carrier: meta.carrier,
      p_received_by: meta.receivedBy,
      p_note: meta.note,

      p_dispatch_document_type:
        meta.dispatchDocumentType,

      p_dispatch_document_number:
        meta.dispatchDocumentNumber,

      p_dispatch_external_id:
        meta.dispatchExternalId,

      p_physical_receipt_at:
        meta.physicalReceiptAt,

      p_items: items,

      p_idempotency_key:
        this.recordKey.for({
          orderId,
          meta,
          items,
        }),
    });

    this.saving.set(false);

    if (error) {
      const m = this.friendly(error.message);
      this.error.set(m);
      return m;
    }

    this.recordKey.done();

    return null;
  }

  /** Link the receipt acknowledgement (e-Prijemnica in Serbia) to this GRN. */
  async setReceiptAck(input: ReceiptAckInput): Promise<string | null> {
    this.savingAck.set(true);
    const { error } = await supabase.rpc('set_receipt_acknowledgement', {
      p_delivery_id: input.deliveryId,
      p_document_number: input.documentNumber,
      p_status: input.status,
      p_provider: input.provider,
      p_external_id: input.externalId,
      p_sent_at: input.sentAt,
      p_note: input.note,
      p_idempotency_key: this.ackKey.for(input),
    });
    this.savingAck.set(false);
    if (error) return this.friendly(error.message);
    this.ackKey.done();
    await this.refreshReceipt(input.deliveryId);
    return null;
  }

  private friendly(m: string): string {
    if (m.includes('Accepted quantity cannot exceed ordered')) return 'Accepted stock cannot exceed the purchase order quantity. Hold or return the excess.';
    if (m.includes('Disposition quantities are invalid')) return 'Choose what happens to every unit that is not accepted.';
    if (m.includes('Physical and accepted')) return 'Accepted quantity cannot be greater than physical quantity.';
    if (m.includes('only available with the Serbia')) return 'e-Otpremnica requires the Serbia compliance profile (Settings).';
    if (m.includes('dispatch document type')) return 'Choose the dispatch document type.';
    if (m.includes('Document number is required')) return 'Enter the document number.';
    if (m.includes('already been delivered')) return 'This order has already been delivered.';
    if (m.includes('must be APPROVED')) return 'Only APPROVED orders can be delivered.';
    if (m.includes('must account for all')) return 'Every order line must be counted.';
    if (m.includes('reason')) return 'Choose a reason for every shortage, over-delivery or rejected quantity.';
    if (m.includes('DEMO_READONLY') || m.includes('Demo account')) return 'This action is disabled in the demo account.';
    if (m.includes('Failed to fetch')) return 'Network issue - check your connection and try again.';
    return 'Could not complete the action. Please try again.';
  }
}

