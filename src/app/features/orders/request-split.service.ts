import { Injectable } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { ApproveRequestResult, RequestSuggestion, SupplierOption } from './request-split.model';

interface CatalogRow {
  supplier_id: string;
  product_id: string;
  pack_size: number;
  minimum_packs: number;
  lead_time_days: number | null;
  preferred: boolean;
  supplier: { name: string; active: boolean } | null;
}

@Injectable({ providedIn: 'root' })
export class RequestSplitService {
  /** Suggested supplier + rounded quantity per request line. */
  async suggestions(orderId: string): Promise<{ data: RequestSuggestion[]; error: string | null }> {
    const { data, error } = await supabase.rpc('request_supplier_suggestions', { p_order_id: orderId });
    if (error) return { data: [], error: friendly(error.message) };
    return { data: (data ?? []) as RequestSuggestion[], error: null };
  }

  /**
   * Supplier options per product: catalog suppliers first (preferred on top),
   * then every other active supplier so the admin can still choose one.
   */
  async options(productIds: string[]): Promise<{ byProduct: Map<string, SupplierOption[]>; error: string | null }> {
    const byProduct = new Map<string, SupplierOption[]>();
    if (!productIds.length) return { byProduct, error: null };

    const [catalog, all] = await Promise.all([
      supabase
        .from('supplier_products')
        .select('supplier_id, product_id, pack_size, minimum_packs, lead_time_days, preferred, supplier:suppliers ( name, active )')
        .in('product_id', productIds)
        .eq('active', true),
      supabase.from('suppliers').select('id, name').eq('active', true).order('name'),
    ]);

    if (catalog.error) return { byProduct, error: friendly(catalog.error.message) };
    if (all.error) return { byProduct, error: friendly(all.error.message) };

    const rows = (catalog.data ?? []) as unknown as CatalogRow[];
    const suppliers = (all.data ?? []) as { id: string; name: string }[];

    for (const pid of productIds) {
      const mapped = rows
        .filter((r) => r.product_id === pid && r.supplier?.active)
        .map<SupplierOption>((r) => ({
          supplier_id: r.supplier_id,
          supplier_name: r.supplier?.name ?? 'Supplier',
          pack_size: r.pack_size,
          minimum_packs: r.minimum_packs,
          lead_time_days: r.lead_time_days,
          preferred: r.preferred,
          in_catalog: true,
        }))
        .sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.supplier_name.localeCompare(b.supplier_name));

      const mappedIds = new Set(mapped.map((m) => m.supplier_id));
      const others = suppliers
        .filter((s) => !mappedIds.has(s.id))
        .map<SupplierOption>((s) => ({
          supplier_id: s.id,
          supplier_name: s.name,
          pack_size: 1,
          minimum_packs: 1,
          lead_time_days: null,
          preferred: false,
          in_catalog: false,
        }));

      byProduct.set(pid, [...mapped, ...others]);
    }
    return { byProduct, error: null };
  }

  /** Last approved/delivered unit cost per supplier + product ("supplierId:productId"). */
  async lastPrices(productIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (!productIds.length) return map;

    const { data } = await supabase
      .from('order_items')
      .select('product_id, unit_cost, order:orders!inner ( supplier_id, status, created_at )')
      .in('product_id', productIds)
      .in('order.status', ['APPROVED', 'DELIVERED'])
      .not('unit_cost', 'is', null)
      .limit(2000);

    const rows = (data ?? []) as unknown as {
      product_id: string;
      unit_cost: number;
      order: { supplier_id: string | null; created_at: string } | null;
    }[];

    const latest = new Map<string, string>();
    for (const r of rows) {
      if (!r.order?.supplier_id) continue;
      const key = `${r.order.supplier_id}:${r.product_id}`;
      const seen = latest.get(key);
      if (!seen || r.order.created_at > seen) {
        latest.set(key, r.order.created_at);
        map.set(key, Number(r.unit_cost));
      }
    }
    return map;
  }

  /** Atomic: approve the request, creating one purchase order per supplier. */
  async approve(
    orderId: string,
    lines: { order_item_id: string; supplier_id: string; quantity: number }[]
  ): Promise<{ data: ApproveRequestResult | null; error: string | null }> {
    const { data, error } = await supabase.rpc('approve_request', {
      p_order_id: orderId,
      p_lines: lines,
    });
    if (error) return { data: null, error: friendly(error.message) };
    return { data: data as ApproveRequestResult, error: null };
  }
}

function friendly(msg: string): string {
  if (msg.includes('Demo account') || msg.includes('DEMO_READONLY'))
    return 'This action is disabled in the demo account.';
  if (msg.includes('Company profile'))
    return 'Complete Settings › Company profile before approving purchase orders.';
  if (
    msg.includes('Every line needs') || msg.includes('Invalid supplier quantity') || msg.includes('Quantities must') ||
    msg.includes('inactive or missing') || msg.includes('Only a PENDING') ||
    msg.includes('does not belong') || msg.includes('Only admins') || msg.includes('Assign at least')
  ) return msg;
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError'))
    return 'Network issue — check your connection and try again.';
  return 'Could not complete the action. Please try again.';
}
