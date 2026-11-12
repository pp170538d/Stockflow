export interface Supplier {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
  tax_id: string | null;
  registration_number: string | null;
  order_email: string | null;
  phone: string | null;
  contact_name: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SupplierInput {
  name: string;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
  tax_id: string | null;
  registration_number: string | null;
  order_email: string | null;
  phone: string | null;
  contact_name: string | null;
  active: boolean;
}
