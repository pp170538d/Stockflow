import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { UsersService, UserRow } from './users.service';
import { BusinessObject } from '../objects/object.model';
import { UserRole } from '../../core/auth/user-profile.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { DrawerComponent } from '../../shared/ui/drawer.component';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';

@Component({
  selector: 'app-users',
  standalone: true,
  imports: [DatePipe, BadgeComponent, EmptyStateComponent, DrawerComponent],
  templateUrl: './users.component.html',
})
export class UsersComponent implements OnInit {
  readonly svc = inject(UsersService);
  readonly auth = inject(AuthService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly search = signal('');
  readonly objects = signal<BusinessObject[]>([]);

  // Edit drawer state
  readonly drawerOpen = signal(false);
  readonly editingUser = signal<UserRow | null>(null);
  readonly draftRole = signal<UserRole>('SELLER');
  readonly draftObjectId = signal<string>('');
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.svc.users();
    if (!q) return list;
    return list.filter(
      (u) =>
        (u.email ?? '').toLowerCase().includes(q) ||
        (u.full_name ?? '').toLowerCase().includes(q)
    );
  });

  async ngOnInit(): Promise<void> {
    this.svc.load();
    const { data } = await supabase.from('objects').select('*').eq('active', true).order('name');
    this.objects.set((data ?? []) as BusinessObject[]);
  }

  openEdit(u: UserRow): void {
    this.editingUser.set(u);
    this.draftRole.set(u.role);
    this.draftObjectId.set(u.object_id ?? '');
    this.formError.set(null);
    this.drawerOpen.set(true);
  }

  closeDrawer(): void {
    this.drawerOpen.set(false);
  }

  async save(): Promise<void> {
    const u = this.editingUser();
    if (!u) return;

    // Elevating someone to ADMIN is privileged — confirm it explicitly.
    if (this.draftRole() === 'ADMIN' && u.role !== 'ADMIN') {
      const ok = await this.confirm.ask({
        title: 'Grant admin access?',
        message: `${u.full_name || u.email} will get full access to every object and all management actions.`,
        confirmLabel: 'Make admin',
        tone: 'danger',
      });
      if (!ok) return;
    }

    this.saving.set(true);
    this.formError.set(null);
    // Update role, then object (sellers need an object; admins don't)
    const roleErr = await this.svc.setRole(u.id, this.draftRole());
    const objectId = this.draftRole() === 'ADMIN' ? null : (this.draftObjectId() || null);
    const objErr = roleErr ? null : await this.svc.setObject(u.id, objectId);
    this.saving.set(false);
    const err = roleErr || objErr;
    if (err) {
      this.formError.set(err);
      this.toast.error(err);
    } else {
      this.drawerOpen.set(false);
      this.toast.success(`${u.full_name || u.email} updated.`);
    }
  }

  isSelf(u: UserRow): boolean {
    return u.id === this.auth.profile()?.id;
  }
}
