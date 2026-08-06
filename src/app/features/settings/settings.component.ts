import { Component, inject, signal, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { ToastService } from '../../shared/ui/toast.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  templateUrl: './settings.component.html',
})
export class SettingsComponent implements OnInit {
  readonly auth = inject(AuthService);
  private router = inject(Router);
  private toast = inject(ToastService);

  // Profile
  readonly fullName = signal('');
  readonly savingProfile = signal(false);
  readonly profileMsg = signal<string | null>(null);

  // Password
  readonly newPassword = signal('');
  readonly confirmPassword = signal('');
  readonly savingPassword = signal(false);
  readonly passwordMsg = signal<string | null>(null);
  readonly passwordErr = signal<string | null>(null);

  ngOnInit(): void {
    this.fullName.set(this.auth.profile()?.full_name ?? '');
  }

  async saveProfile(): Promise<void> {
    const id = this.auth.profile()?.id;
    if (!id) return;
    this.savingProfile.set(true);
    this.profileMsg.set(null);
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: this.fullName().trim() || null })
      .eq('id', id);
    this.savingProfile.set(false);
    if (error) {
      this.toast.error('Could not save your name — try again.');
    } else {
      this.profileMsg.set('Profile updated ✓');
      this.toast.success('Profile updated.');
    }
  }

  async changePassword(): Promise<void> {
    this.passwordMsg.set(null);
    this.passwordErr.set(null);
    if (this.newPassword().length < 6) {
      this.passwordErr.set('Password must be at least 6 characters.');
      return;
    }
    if (this.newPassword() !== this.confirmPassword()) {
      this.passwordErr.set('Passwords do not match.');
      return;
    }
    this.savingPassword.set(true);
    const { error } = await supabase.auth.updateUser({ password: this.newPassword() });
    this.savingPassword.set(false);
    if (error) {
      this.passwordErr.set(error.message);
      this.toast.error('Could not change password — try again.');
    } else {
      this.passwordMsg.set('Password changed ✓');
      this.toast.success('Password changed. 🔒');
      this.newPassword.set('');
      this.confirmPassword.set('');
    }
  }

  async signOut(): Promise<void> {
    await this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
