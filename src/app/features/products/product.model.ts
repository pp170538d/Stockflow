export interface Product {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  category: string | null;

  cost_price: number | null;
  sell_price: number | null;

  active: boolean;
  created_at: string;
}

export interface ProductInput {
  sku: string;
  barcode: string | null;
  name: string;
  category: string | null;

  cost_price: number | null;
  sell_price: number | null;

  active: boolean;
}