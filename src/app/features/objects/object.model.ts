export interface BusinessObject {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  active: boolean;
  created_at: string;
}

// Shape used when creating/updating (no id/created_at — DB generates those)
export interface ObjectInput {
  name: string;
  address: string | null;
  city: string | null;
  active: boolean;
}