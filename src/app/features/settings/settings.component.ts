import { Component, inject, signal, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { ToastService } from '../../shared/ui/toast.service';

interface CompanyProfile {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
  tax_id: string | null;
  registration_number: string | null;
  email: string | null;
  phone: string | null;
  updated_at: string;
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule],
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

  // Company
  readonly companyLoading = signal(false);
  readonly savingCompany = signal(false);
  readonly companyError = signal<string | null>(null);
  readonly companyMsg = signal<string | null>(null);
  readonly companyName = signal('');
  readonly companyAddress = signal('');
  readonly companyCity = signal('');
  readonly companyPostalCode = signal('');
  readonly companyCountry = signal('Serbia');
  readonly companyTaxId = signal('');
  readonly companyRegistrationNumber = signal('');
  readonly companyEmail = signal('');
  readonly companyPhone = signal('');

  // Password
  readonly newPassword = signal('');
  readonly confirmPassword = signal('');
  readonly savingPassword = signal(false);
  readonly passwordMsg = signal<string | null>(null);
  readonly passwordErr = signal<string | null>(null);

  ngOnInit(): void {
    this.fullName.set(this.auth.profile()?.full_name ?? '');
    if (this.auth.isAdmin()) void this.loadCompany();
  }

  async saveProfile(): Promise<void> {
    const id = this.auth.profile()?.id;
    if (!id || this.auth.isDemo()) return;
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

  async loadCompany(): Promise<void> {
    this.companyLoading.set(true);
    this.companyError.set(null);
    const { data, error } = await supabase
      .from('company_profile')
      .select('id, name, address, city, postal_code, country, tax_id, registration_number, email, phone, updated_at')
      .maybeSingle();
    this.companyLoading.set(false);

    if (error) {
      this.companyError.set(error.message);
      return;
    }
    if (!data) return;

    const c = data as CompanyProfile;
    this.companyName.set(c.name ?? '');
    this.companyAddress.set(c.address ?? '');
    this.companyCity.set(c.city ?? '');
    this.companyPostalCode.set(c.postal_code ?? '');
    this.companyCountry.set(c.country ?? '');
    this.companyTaxId.set(c.tax_id ?? '');
    this.companyRegistrationNumber.set(c.registration_number ?? '');
    this.companyEmail.set(c.email ?? '');
    this.companyPhone.set(c.phone ?? '');
  }

  async saveCompany(): Promise<void> {
    if (!this.auth.isAdmin() || this.auth.isDemo()) return;
    if (!this.companyName().trim()) {
      this.companyError.set('Company name is required.');
      return;
    }

    this.savingCompany.set(true);
    this.companyError.set(null);
    this.companyMsg.set(null);

    const { error } = await supabase.rpc('save_company_profile', {
      p_data: {
        name: this.companyName().trim(),
        address: this.companyAddress().trim(),
        city: this.companyCity().trim(),
        postal_code: this.companyPostalCode().trim(),
        country: this.companyCountry().trim(),
        tax_id: this.companyTaxId().trim(),
        registration_number: this.companyRegistrationNumber().trim(),
        email: this.companyEmail().trim(),
        phone: this.companyPhone().trim(),
      },
    });

    this.savingCompany.set(false);
    if (error) {
      this.companyError.set(friendly(error.message));
      this.toast.error('Could not save company profile.');
      return;
    }

    this.companyMsg.set('Company profile updated ✓');
    this.toast.success('Company profile updated.');
    await this.loadCompany();
  }

  async changePassword(): Promise<void> {
    this.passwordMsg.set(null);
    this.passwordErr.set(null);

    if (this.auth.isDemo()) {
      this.passwordErr.set('Password changes are disabled in the demo account.');
      return;
    }
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

function friendly(message: string): string {
  if (message.includes('Demo account')) return 'Company changes are disabled in the demo account.';
  if (message.includes('Only admin')) return 'Only an admin can edit the company profile.';
  return message;
}
