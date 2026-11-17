export interface BusinessObject {
  id: string;
  name: string;
  city: string | null;
  address: string | null;
  active: boolean;
  created_at: string;

  code: string | null;
  sales_source: SalesSource;
}

export type SalesSource = 'manual' | 'import';

// Shape used when creating/updating (no id/created_at — DB generates those)
export interface ObjectInput {
  name: string;
  address: string | null;
  city: string | null;
  active: boolean;
  code: string | null;
  sales_source: SalesSource;
}