export type OrderStatus = 'PENDING' | 'APPROVED' | 'DELIVERED' | 'REJECTED';

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  quantity: number;
  // joined for display
  product?: { name: string; sku: string };
}

export interface Order {
  id: string;
  object_id: string;
  status: OrderStatus;
  comment: string | null;
  created_by: string;
  created_at: string;
  // joined for display
  object?: { name: string };
  order_items?: OrderItem[];
}

// For creating a new order (header + lines together)
export interface NewOrderLine {
  product_id: string;
  quantity: number;
}