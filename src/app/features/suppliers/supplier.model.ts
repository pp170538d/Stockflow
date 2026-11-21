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

// ---------- Supplier product catalog ----------
export type SupplierCatalogStatus = 'active' | 'inactive' | 'all';

export interface SupplierCatalogRow {
  id: string;
  product_id: string;
  sku: string;
  product_name: string;
  category: string | null;
  barcode: string | null;
  product_active: boolean;
  cost_price: number | null;
  supplier_sku: string | null;
  preferred: boolean;
  active: boolean;
  lead_time_days: number | null;
  pack_size: number;
  minimum_packs: number;
  /** pack_size × minimum_packs */
  minimum_units: number;
  updated_at: string;
  last_unit_cost: number | null;
  last_order_number: string | null;
  last_ordered_at: string | null;
  orders_count: number;
  other_preferred_supplier: string | null;
}

export interface SupplierCatalogResult {
  total: number;
  counts: { active: number; inactive: number; preferred: number };
  rows: SupplierCatalogRow[];
  limit: number;
  offset: number;
}

export interface SupplierCatalogCandidate {
  product_id: string;
  sku: string;
  product_name: string;
  category: string | null;
  barcode: string | null;
  preferred_supplier: string | null;
  previously_mapped: boolean;
}

export interface SupplierCatalogCandidatesResult {
  total: number;
  rows: SupplierCatalogCandidate[];
  categories: string[];
  limit: number;
  offset: number;
}

export interface SupplierCatalogPatch {
  supplier_sku?: string | null;
  lead_time_days?: number | null;
  minimum_packs?: number;
  pack_size?: number;
}

export interface SupplierPerformance {
  days: number; currency: string; orders: number; receipts: number; perfect_receipts: number;
  lines: number; exact_lines: number; delivery_accuracy: number | null;
  short_lines: number; over_lines: number; damaged_lines: number; wrong_item_lines: number;
  variance_exposure: number; value_coverage: number | null;
  avg_lead_time_days: number | null; median_lead_time_days: number | null;
  avg_price_change_pct: number | null; comparable_products: number;
}
