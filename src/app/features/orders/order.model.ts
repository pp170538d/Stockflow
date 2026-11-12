export type OrderStatus = 'PENDING' | 'APPROVED' | 'DELIVERED' | 'REJECTED';

export interface OrderPartySnapshot {
  id?: string | null;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: string | null;
  tax_id?: string | null;
  registration_number?: string | null;
  email?: string | null;
  order_email?: string | null;
  phone?: string | null;
  contact_name?: string | null;
  full_name?: string | null;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  quantity: number;
  product?: { name: string; sku: string };
}

export interface OrderSupplier {
  id: string;
  name: string;
  order_email: string | null;
  active: boolean;
}

export interface Order {
  id: string;
  order_number: string;
  object_id: string;
  supplier_id: string | null;
  status: OrderStatus;
  comment: string | null;
  created_by: string;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  company_snapshot: OrderPartySnapshot | null;
  supplier_snapshot: OrderPartySnapshot | null;
  delivery_snapshot: OrderPartySnapshot | null;
  prepared_by_snapshot: OrderPartySnapshot | null;
  object?: { name: string };
  supplier?: OrderSupplier | null;
  order_items?: OrderItem[];
}

export interface NewOrderLine {
  product_id: string;
  quantity: number;
}
