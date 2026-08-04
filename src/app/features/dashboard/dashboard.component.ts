import { Component, inject } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  template: `
    <div class="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
      <h1 class="text-2xl font-semibold tracking-tight text-slate-900">Dashboard</h1>
      <p class="mt-1 text-slate-500">
        Welcome back,
        <span class="font-medium text-slate-900">{{ auth.profile()?.email }}</span>
        · <span class="text-brand-700">{{ auth.profile()?.role }}</span>
      </p>
    </div>
  `,
})
export class DashboardComponent {
  readonly auth = inject(AuthService);
}