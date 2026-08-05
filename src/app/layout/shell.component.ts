import { Component, computed, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router } from '@angular/router';
import { AuthService } from '../core/auth/auth.service';
import { NAV_ITEMS } from './nav-items';
import { CommandPaletteComponent } from '../shared/ui/command-palette.component';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommandPaletteComponent],
  templateUrl: './shell.component.html',
})
export class ShellComponent {
  readonly auth = inject(AuthService);
  private router = inject(Router);

  // Desktop: collapsed to icons.  Mobile: drawer open/closed.
  readonly collapsed = signal(false);
  readonly mobileOpen = signal(false);

  // Sellers don't see admin-only items
  readonly navItems = computed(() =>
    NAV_ITEMS.filter((item) => !item.adminOnly || this.auth.isAdmin())
  );

  readonly initials = computed(() => {
    const p = this.auth.profile();
    const src = p?.full_name || p?.email || '?';
    return src.substring(0, 2).toUpperCase();
  });

  toggleCollapse(): void { this.collapsed.update((v) => !v); }
  toggleMobile(): void { this.mobileOpen.update((v) => !v); }
  closeMobile(): void { this.mobileOpen.set(false); }

  async signOut(): Promise<void> {
    await this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}