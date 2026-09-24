import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { UserProfile, UserRole } from '../../core/auth/user-profile.model';
import { demoFriendly } from '../../core/demo-error';

// Profile joined with its assigned object's name
export interface UserRow extends UserProfile {
  object?: { name: string } | null;
}

/**
 * An UPDATE blocked by a row-level security policy does NOT raise an error in
 * PostgREST — the policy acts as a filter, so the statement matches zero rows
 * and reports success. Asking for the touched rows back with .select() is the
 * only reliable way to tell "blocked" apart from "written".
 */
const BLOCKED = 'This action is disabled in the demo account.';

@Injectable({ providedIn: 'root' })
export class UsersService {
  readonly users = signal<UserRow[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const { data, error } = await supabase
      .from('profiles')
      .select('*, object:objects ( name )')
      .order('created_at', { ascending: false });

    if (error) this.error.set(error.message);
    else this.users.set((data ?? []) as unknown as UserRow[]);
    this.loading.set(false);
  }

  async setRole(userId: string, role: UserRole): Promise<string | null> {
    const { data, error } = await supabase
      .from('profiles')
      .update({ role })
      .eq('id', userId)
      .select('id');

    if (error) return demoFriendly(error.message);
    if (!data || data.length === 0) return BLOCKED;

    await this.load();
    return null;
  }

  async setObject(userId: string, objectId: string | null): Promise<string | null> {
    const { data, error } = await supabase
      .from('profiles')
      .update({ object_id: objectId })
      .eq('id', userId)
      .select('id');

    if (error) return demoFriendly(error.message);
    if (!data || data.length === 0) return BLOCKED;

    await this.load();
    return null;
  }
}
