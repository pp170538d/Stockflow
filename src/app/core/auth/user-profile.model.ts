export type UserRole = 'ADMIN' | 'SELLER';

export interface UserProfile {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  object_id: string | null;
  created_at: string;
}