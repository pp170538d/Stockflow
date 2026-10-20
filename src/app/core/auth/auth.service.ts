import { Injectable, computed, signal } from '@angular/core';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../supabase/supabase.client';
import { UserProfile } from './user-profile.model';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly _session = signal<Session | null>(null);
  private readonly _profile = signal<UserProfile | null>(null);
  private readonly _loading = signal<boolean>(true);

  private readonly initialization: Promise<void>;

  readonly session = this._session.asReadonly();
  readonly profile = this._profile.asReadonly();
  readonly loading = this._loading.asReadonly();

  readonly isLoggedIn = computed(() => this._session() !== null);
  readonly isAdmin = computed(() => this._profile()?.role === 'ADMIN');
  readonly isDemo = computed(
    () => this._profile()?.email === 'demo@stockflow.com'
  );

  constructor() {
    /*
     * Register the listener synchronously, but do not run database
     * queries directly inside the callback.
     */
    supabase.auth.onAuthStateChange((event, session) => {
      this._session.set(session);

      if (event === 'SIGNED_OUT' || !session?.user) {
        this._profile.set(null);
        return;
      }

      /*
       * Defer the profile query until the auth callback finishes.
       */
      setTimeout(() => {
        void this.loadProfile(session.user.id);
      }, 0);
    });

    this.initialization = this.restoreSession();
  }

  async waitUntilReady(): Promise<void> {
    await this.initialization;
  }

  private async restoreSession(): Promise<void> {
    this._loading.set(true);

    try {
      const {
        data: { session },
        error,
      } = await supabase.auth.getSession();

      if (error) {
        console.error('Failed to restore session:', error.message);
        this._session.set(null);
        this._profile.set(null);
        return;
      }

      this._session.set(session);

      if (session?.user) {
        await this.loadProfile(session.user.id);
      } else {
        this._profile.set(null);
      }
    } finally {
      this._loading.set(false);
    }
  }

  private async loadProfile(userId: string): Promise<void> {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, object_id, created_at')
      .eq('id', userId)
      .single();

    if (error || !data) {
      console.error(
        'Failed to load user profile:',
        error?.message ?? 'Profile not found'
      );

      this._profile.set(null);
      return;
    }

    this._profile.set(data as UserProfile);
  }

  async login(email: string, password: string): Promise<string | null> {
    this._loading.set(true);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        this._session.set(null);
        this._profile.set(null);
        return error.message;
      }

      if (!data.session || !data.user) {
        this._session.set(null);
        this._profile.set(null);
        return 'Login succeeded, but no session was returned.';
      }

      this._session.set(data.session);
      await this.loadProfile(data.user.id);

      if (!this._profile()) {
        await supabase.auth.signOut();
        this._session.set(null);
        return 'No application profile exists for this user.';
      }

      return null;
    } finally {
      this._loading.set(false);
    }
  }

  async logout(): Promise<void> {
    this._loading.set(true);

    try {
      const { error } = await supabase.auth.signOut();

      if (error) {
        console.error('Sign out failed:', error.message);
      }

      this._session.set(null);
      this._profile.set(null);
    } finally {
      this._loading.set(false);
    }
  }
}