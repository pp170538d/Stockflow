import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { UserProfile, UserRole } from '../../core/auth/user-profile.model';

// Profile joined with its assigned object's name
export interface UserRow extends UserProfile {
  object?: { name: string } | null;
}

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
    const { error } = await supabase.from('profiles').update({ role }).eq('id', userId);
    if (error) return error.message;
    await this.load();
    return null;
  }

  async setObject(userId: string, objectId: string | null): Promise<string | null> {
    const { error } = await supabase.from('profiles').update({ object_id: objectId }).eq('id', userId);
    if (error) return error.message;
    await this.load();
    return null;
  }
}