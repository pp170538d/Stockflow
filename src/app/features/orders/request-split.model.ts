// =====================================================================
// Request → purchase plan (split by supplier)
// Mirrors request_supplier_suggestions() and approve_request().
// =====================================================================

/** One request line with the catalog suggestion (request_supplier_suggestions RPC). */
export interface RequestSuggestion {
  order_item_id: string;
  product_id: string;
  sku: string;
  product_name: string;
  requested_qty: number;
  quantity: number;
  supplier_id: string | null;     // preferred supplier, if any
  supplier_name: string | null;
  pack_size: number | null;
  minimum_packs: number | null;
  suggested_qty: number;          // rounded to the preferred supplier's pack rule
  last_unit_cost: number | null;
  current_cost: number | null;
  suppliers_count: number;
}

/** A supplier that can deliver a product (from supplier_products). */
export interface SupplierOption {
  supplier_id: string;
  supplier_name: string;
  pack_size: number;
  minimum_packs: number;
  lead_time_days: number | null;
  preferred: boolean;
  in_catalog: boolean;            // false = any active supplier, not mapped yet
}

/** One allocation of a request line to a supplier. */
export interface Allocation {
  key: string;
  supplierId: string | null;
  quantity: number;
}

/** UI state for one request line. */
export interface PlanLine {
  s: RequestSuggestion;
  included: boolean;
  allocations: Allocation[];
}

export interface PlanGroup {
  supplierId: string;
  supplierName: string;
  lines: number;
  units: number;
  value: number;
  missingCost: number;
}

export interface ApproveRequestResult {
  request_id: string;
  split: boolean;
  orders: {
    id: string;
    order_number: string;
    supplier_id: string;
    supplier_name: string;
    lines: number;
    units: number;
    value: number;
  }[];
}
