export interface Product {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  active: boolean;
  created_at: string;
}

export interface ProductInput {
  sku: string;
  name: string;
  category: string | null;
  active: boolean;
}