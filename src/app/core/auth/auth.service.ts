import { Injectable, signal, computed } from '@angular/core';
import { supabase } from '../supabase/supabase.client';
import { UserProfile } from './user-profile.model';

@Injectable({ providedIn: 'root' })
export class AuthService {
  // --- Reactive state (Signals) ---
  private readonly _profile = signal<UserProfile | null>(null);
  private readonly _loading = signal<boolean>(true);

  readonly profile = this._profile.asReadonly();
  readonly loading = this._loading.asReadonly();

  // Convenience computed signals
  readonly isLoggedIn = computed(() => this._profile() !== null);
  readonly isAdmin = computed(() => this._profile()?.role === 'ADMIN');

  constructor() {
    this.restoreSession();

    // Keep state in sync if the session changes in another tab / on refresh
    supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        this.loadProfile(session.user.id);
      } else {
        this._profile.set(null);
      }
    });
  }

  /** On app start, check if a session already exists. */
  private async restoreSession(): Promise<void> {
    this._loading.set(true);
    const { data } = await supabase.auth.getSession();
    if (data.session?.user) {
      await this.loadProfile(data.session.user.id);
    }
    this._loading.set(false);
  }

  /** Fetch the profiles row for the logged-in user. */
  private async loadProfile(userId: string): Promise<void> {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (!error && data) {
      this._profile.set(data as UserProfile);
    }
  }

  /** Email + password login. Returns an error message or null on success. */
  async login(email: string, password: string): Promise<string | null> {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return error.message;
    if (data.user) await this.loadProfile(data.user.id);
    return null;
  }

  /** Sign out and clear state. */
  async logout(): Promise<void> {
    await supabase.auth.signOut();
    this._profile.set(null);
  }
}