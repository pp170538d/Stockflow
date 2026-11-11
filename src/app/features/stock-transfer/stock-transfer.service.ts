import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';

export interface TransferProduct {
  productId: string;
  name: string;
  sku: string;
  barcode: string | null;

  sourceQty: number;
  destinationQty: number;
}

export interface TransferLineInput {
  product_id: string;
  quantity: number;
}

interface AssignedProductRow {
  product_id: string;
  product: {
    id: string;
    name: string;
    sku: string;
    barcode: string | null;
    active: boolean;
  } | null;
}

interface InventoryRow {
  product_id: string;
  quantity: number;
}

@Injectable({ providedIn: 'root' })
export class StockTransferService {
  readonly products = signal<TransferProduct[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Products transferable from source -> destination.
   *
   * A product is returned only when it is:
   *  - active
   *  - assigned to the source store
   *  - assigned to the destination store
   *
   * Inventory quantity may be zero / missing at either side.
   */
  async loadTransferableProducts(
    sourceObjectId: string,
    destinationObjectId: string
  ): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.products.set([]);

    if (!sourceObjectId || !destinationObjectId) {
      this.loading.set(false);
      return;
    }

    if (sourceObjectId === destinationObjectId) {
      this.error.set('Source and destination stores must be different.');
      this.loading.set(false);
      return;
    }

    const [sourceAssignments, destinationAssignments] = await Promise.all([
      supabase
        .from('object_products')
        .select(`
          product_id,
          product:products (
            id,
            name,
            sku,
            barcode,
            active
          )
        `)
        .eq('object_id', sourceObjectId),

      supabase
        .from('object_products')
        .select(`
          product_id,
          product:products (
            id,
            name,
            sku,
            barcode,
            active
          )
        `)
        .eq('object_id', destinationObjectId),
    ]);

    if (sourceAssignments.error) {
      this.error.set(sourceAssignments.error.message);
      this.loading.set(false);
      return;
    }

    if (destinationAssignments.error) {
      this.error.set(destinationAssignments.error.message);
      this.loading.set(false);
      return;
    }

    const sourceRows =
      (sourceAssignments.data ?? []) as unknown as AssignedProductRow[];

    const destinationRows =
      (destinationAssignments.data ?? []) as unknown as AssignedProductRow[];

    // Destination assortment.
    const destinationProductIds = new Set(
      destinationRows
        .filter((row) => row.product?.active !== false)
        .map((row) => row.product_id)
    );

    // Intersection:
    // active AND source-assigned AND destination-assigned.
    const common = sourceRows.filter(
      (row) =>
        row.product &&
        row.product.active !== false &&
        destinationProductIds.has(row.product_id)
    );

    if (!common.length) {
      this.products.set([]);
      this.loading.set(false);
      return;
    }

    const productIds = common.map((row) => row.product_id);

    const [sourceInventory, destinationInventory] = await Promise.all([
      supabase
        .from('inventory')
        .select('product_id, quantity')
        .eq('object_id', sourceObjectId)
        .in('product_id', productIds),

      supabase
        .from('inventory')
        .select('product_id, quantity')
        .eq('object_id', destinationObjectId)
        .in('product_id', productIds),
    ]);

    if (sourceInventory.error) {
      this.error.set(sourceInventory.error.message);
      this.loading.set(false);
      return;
    }

    if (destinationInventory.error) {
      this.error.set(destinationInventory.error.message);
      this.loading.set(false);
      return;
    }

    const sourceQty = new Map<string, number>(
      ((sourceInventory.data ?? []) as InventoryRow[]).map((row) => [
        row.product_id,
        Number(row.quantity) || 0,
      ])
    );

    const destinationQty = new Map<string, number>(
      ((destinationInventory.data ?? []) as InventoryRow[]).map((row) => [
        row.product_id,
        Number(row.quantity) || 0,
      ])
    );

    const result: TransferProduct[] = common
      .map((row) => ({
        productId: row.product_id,
        name: row.product?.name ?? 'Product',
        sku: row.product?.sku ?? '—',
        barcode: row.product?.barcode ?? null,

        sourceQty: sourceQty.get(row.product_id) ?? 0,
        destinationQty: destinationQty.get(row.product_id) ?? 0,
      }))
      .sort(
        (a, b) =>
          Number(b.sourceQty > 0) - Number(a.sourceQty > 0) ||
          a.name.localeCompare(b.name)
      );

    this.products.set(result);
    this.loading.set(false);
  }

  /**
   * Executes the atomic PostgreSQL transfer workflow.
   *
   * Returns:
   *  - transfer:<uuid> on success
   *  - a friendly error on failure
   */
  async recordTransfer(
    sourceObjectId: string,
    destinationObjectId: string,
    reason: string,
    items: TransferLineInput[]
  ): Promise<{ reference: string | null; error: string | null }> {
    const clean = items
      .filter((item) => item.quantity > 0)
      .sort((a, b) => a.product_id.localeCompare(b.product_id));

    if (!clean.length) {
      return {
        reference: null,
        error: 'Add at least one product to the transfer.',
      };
    }

    const cleanReason = reason.trim();

    if (!cleanReason) {
      return {
        reference: null,
        error: 'A reason is required for a stock transfer.',
      };
    }

    if (sourceObjectId === destinationObjectId) {
      return {
        reference: null,
        error: 'Source and destination stores must be different.',
      };
    }

    this.saving.set(true);

    const { data, error } = await supabase.rpc('record_transfer', {
      p_from_object_id: sourceObjectId,
      p_to_object_id: destinationObjectId,
      p_reason: cleanReason,
      p_items: clean,
    });

    this.saving.set(false);

    if (error) {
      return {
        reference: null,
        error: this.friendly(error.message),
      };
    }

    return {
      reference: typeof data === 'string' ? data : null,
      error: null,
    };
  }

  clear(): void {
    this.products.set([]);
    this.error.set(null);
  }

  private friendly(message: string): string {
    if (
      message.includes('You can only work with your own store') ||
      message.includes('permission denied') ||
      message.includes('row-level security')
    ) {
      return "You don't have permission to transfer stock from this store.";
    }

    if (message.includes('Insufficient stock')) {
      return message;
    }

    if (message.includes('not assigned to the destination store')) {
      return message;
    }

    if (message.includes('not assigned to the source store')) {
      return message;
    }

    if (message.includes('does not exist or is inactive')) {
      return message;
    }

    if (message.includes('same product cannot appear')) {
      return 'The same product cannot appear more than once in a transfer.';
    }

    if (
      message.includes('Failed to fetch') ||
      message.includes('NetworkError')
    ) {
      return 'Network issue - check your connection and try again.';
    }

    return message;
  }
}