export interface InventoryRow {
  id: string;
  object_id: string;
  product_id: string;
  quantity: number;
  updated_at: string;
  // joined for display
  product?: { name: string; sku: string; category: string | null };
}

export type MovementType = 'INBOUND' | 'OUTBOUND' | 'ADJUSTMENT';

export interface StockMovement {
  id: string;
  object_id: string;
  product_id: string;
  movement_type: MovementType;
  quantity: number;
  reference: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  product?: { name: string; sku: string };
}