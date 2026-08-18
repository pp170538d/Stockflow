import { Component, signal, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './login.component.html',
})
export class LoginComponent {
  private fb = inject(FormBuilder);
  private auth = inject(AuthService);
  private router = inject(Router);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly showPassword = signal(false);

  /**
   * Public, read-only demo credentials shown on the login card so anyone
   * arriving from LinkedIn can walk the app without a sign-up.
   * Seed this user in Supabase as a SELLER scoped to a sandbox object with
   * pre-loaded sample data (see README → demo access).
   */
  readonly demoEmail = 'demo@stockflow.com';
  readonly demoPassword = 'demo1234';

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.loading.set(true);
    this.error.set(null);

    const { email, password } = this.form.getRawValue();
    const errorMsg = await this.auth.login(email, password);
    this.loading.set(false);

    if (errorMsg) {
      this.error.set(errorMsg);
    } else {
      this.router.navigateByUrl('/dashboard');
    }
  }

  /** One-click: fill the demo credentials and sign straight in. */
  async useDemo(): Promise<void> {
    this.form.setValue({ email: this.demoEmail, password: this.demoPassword });
    await this.submit();
  }
}
