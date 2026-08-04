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

@Component({
  selector: 'app-users',
  standalone: true,
  imports: [DatePipe, BadgeComponent, EmptyStateComponent, DrawerComponent],
  templateUrl: './users.component.html',
})
export class UsersComponent implements OnInit {
  readonly svc = inject(UsersService);
  readonly auth = inject(AuthService);

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

    this.saving.set(true);
    this.formError.set(null);

    // Update role, then object (sellers need an object; admins don't)
    const roleErr = await this.svc.setRole(u.id, this.draftRole());
    const objectId = this.draftRole() === 'ADMIN' ? null : (this.draftObjectId() || null);
    const objErr = roleErr ? null : await this.svc.setObject(u.id, objectId);

    this.saving.set(false);

    const err = roleErr || objErr;
    if (err) this.formError.set(err);
    else this.drawerOpen.set(false);
  }

  isSelf(u: UserRow): boolean {
    return u.id === this.auth.profile()?.id;
  }
}