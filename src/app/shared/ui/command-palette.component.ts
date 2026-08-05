import {
  Component, computed, inject, signal, effect,
  HostListener, ElementRef, viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { NAV_ITEMS } from '../../layout/nav-items';

interface CommandItem {
  label: string;
  sublabel?: string;
  path: string;
  group: 'Actions' | 'Navigation' | 'Objects' | 'Products';
  icon?: string;
}

@Component({
  selector: 'app-command-palette',
  standalone: true,
  template: `
    @if (open()) {
      <!-- Backdrop -->
      <div class="fixed inset-0 z-[60] bg-slate-900/40 backdrop-blur-sm"
           (click)="close()"></div>

      <!-- Panel -->
      <div class="fixed inset-x-0 top-[15vh] z-[70] mx-auto w-full max-w-lg px-4">
        <div class="overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200"
             (click)="$event.stopPropagation()">

          <!-- Search input -->
          <div class="flex items-center gap-3 border-b border-slate-100 px-4">
            <svg class="h-5 w-5 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
            </svg>
            <input #searchInput type="text" [value]="query()"
              (input)="onQuery($any($event.target).value)"
              placeholder="Search or jump to…"
              class="w-full bg-transparent py-4 text-sm text-slate-900 outline-none placeholder:text-slate-400" />
            <kbd class="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">ESC</kbd>
          </div>

          <!-- Results -->
          <div class="max-h-[50vh] overflow-y-auto p-2">
            @if (results().length === 0) {
              <p class="py-8 text-center text-sm text-slate-400">No results found.</p>
            } @else {
              @for (item of results(); track item.path + item.label; let i = $index) {
                <button (click)="select(item)" (mouseenter)="activeIndex.set(i)"
                  class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition"
                  [class.bg-brand-50]="activeIndex() === i">
                  <span class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-slate-100 text-slate-500"
                        [class.bg-brand-100]="activeIndex() === i"
                        [class.text-brand-600]="activeIndex() === i">
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path [attr.d]="item.icon || 'M9 5l7 7-7 7'" />
                    </svg>
                  </span>
                  <span class="flex-1">
                    <span class="block text-sm font-medium text-slate-900">{{ item.label }}</span>
                    @if (item.sublabel) {
                      <span class="block font-mono text-xs text-slate-400">{{ item.sublabel }}</span>
                    }
                  </span>
                  <span class="text-[10px] font-medium uppercase tracking-wide text-slate-300">
                    {{ item.group }}
                  </span>
                </button>
              }
            }
          </div>

          <!-- Footer hint -->
          <div class="flex items-center gap-4 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
            <span>↑ ↓ to navigate</span>
            <span>↵ to select</span>
            <span>esc to close</span>
          </div>
        </div>
      </div>
    }
  `,
})
export class CommandPaletteComponent {
  private router = inject(Router);
  private auth = inject(AuthService);

  readonly open = signal(false);
  readonly query = signal('');
  readonly activeIndex = signal(0);

  private readonly objects = signal<{ id: string; name: string }[]>([]);
  private readonly products = signal<{ id: string; name: string; sku: string }[]>([]);
  private loaded = false;

  readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  /** Static commands: quick actions + role-filtered navigation. */
  private readonly commands = computed<CommandItem[]>(() => {
    const isAdmin = this.auth.isAdmin();
    const actions: CommandItem[] = [
      { label: 'New order', path: '/orders/new', group: 'Actions', icon: 'M12 5v14M5 12h14' },
    ];
    const nav = NAV_ITEMS
      .filter((n) => !n.adminOnly || isAdmin)
      .map((n) => ({ label: n.label, path: n.path, group: 'Navigation' as const, icon: n.icon }));
    return [...actions, ...nav];
  });

  readonly results = computed<CommandItem[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.commands();

    const objs: CommandItem[] = this.objects().map((o) => ({
      label: o.name, path: '/objects', group: 'Objects',
      icon: 'M3 7h18M3 12h18M3 17h18',
    }));
    const prods: CommandItem[] = this.products().map((p) => ({
      label: p.name, sublabel: p.sku, path: '/products', group: 'Products',
      icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7',
    }));

    return [...this.commands(), ...objs, ...prods]
      .filter((c) =>
        c.label.toLowerCase().includes(q) ||
        (c.sublabel ?? '').toLowerCase().includes(q)
      )
      .slice(0, 20);
  });

  constructor() {
    // Focus the input the moment the palette opens
    effect(() => {
      if (this.open()) {
        queueMicrotask(() => this.searchInput()?.nativeElement.focus());
      }
    });
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    const toggle = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
    if (toggle) { e.preventDefault(); this.open() ? this.close() : this.openPalette(); return; }
    if (!this.open()) return;

    if (e.key === 'Escape') { this.close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); this.select(this.results()[this.activeIndex()]); }
  }

  async openPalette(): Promise<void> {
    this.query.set('');
    this.activeIndex.set(0);
    this.open.set(true);
    await this.ensureLoaded();
  }

  close(): void { this.open.set(false); }

  onQuery(v: string): void { this.query.set(v); this.activeIndex.set(0); }

  private move(delta: number): void {
    const n = this.results().length;
    if (!n) return;
    this.activeIndex.set((this.activeIndex() + delta + n) % n);
  }

  select(item?: CommandItem): void {
    if (!item) return;
    this.close();
    this.router.navigateByUrl(item.path);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const [o, p] = await Promise.all([
      supabase.from('objects').select('id, name').eq('active', true).order('name'),
      supabase.from('products').select('id, name, sku').eq('active', true).order('name'),
    ]);
    this.objects.set(o.data ?? []);
    this.products.set(p.data ?? []);
    this.loaded = true;
  }
}