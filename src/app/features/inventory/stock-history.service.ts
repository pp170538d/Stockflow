import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';

export interface StockHistoryPoint {
  movementId: string | null;
  occurredAt: string;
  event: string;
  changeQuantity: number;
  balance: number;
  note: string | null;
  reference: string | null;
  isOpening: boolean;
}

interface StockHistoryRecord {
  movement_id: string | null;
  occurred_at: string;
  event: string;
  change_quantity: number | string;
  balance: number | string;
  note: string | null;
  reference: string | null;
  is_opening: boolean;
}

@Injectable({ providedIn: 'root' })
export class StockHistoryService {
  readonly points = signal<StockHistoryPoint[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  async load(
    objectId: string,
    productId: string,
    from: string | null,
    to: string | null
  ): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const { data, error } = await supabase.rpc('stock_level_history', {
      p_object_id: objectId,
      p_product_id: productId,
      p_from: from,
      p_to: to,
    });

    if (error) {
      this.points.set([]);
      this.error.set(error.message);
      this.loading.set(false);
      return;
    }

    this.points.set(((data ?? []) as StockHistoryRecord[]).map((row) => ({
      movementId: row.movement_id,
      occurredAt: row.occurred_at,
      event: row.event,
      changeQuantity: Number(row.change_quantity),
      balance: Number(row.balance),
      note: row.note,
      reference: row.reference,
      isOpening: row.is_opening,
    })));

    this.loading.set(false);
  }

  clear(): void {
    this.points.set([]);
    this.error.set(null);
  }
}
