import { Component, inject, HostListener } from '@angular/core';
import { ConfirmService } from './confirm.service';

/**
 * Renders the global confirm dialog. Mount ONCE in the app shell template:
 *   <app-confirm-host />
 *
 * Driven entirely by ConfirmService.ask(). Backdrop click and the Esc key
 * both count as "cancel". A 'danger' tone paints the confirm button red.
 */
@Component({
  selector: 'app-confirm-host',
  standalone: true,
  template: `
    @if (svc.state(); as s) {
      @if (s.open) {
        <!-- Backdrop -->
        <div class="fixed inset-0 z-[110] flex items-center justify-center p-4">
          <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]"
               (click)="svc.cancel()"></div>

          <!-- Dialog -->
          <div class="relative w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl ring-1 ring-slate-200"
               role="dialog" aria-modal="true">
            <h2 class="text-base font-semibold text-slate-900">{{ s.title }}</h2>
            <p class="mt-2 text-sm text-slate-600">{{ s.message }}</p>

            <div class="mt-5 flex justify-end gap-2">
              <button type="button" (click)="svc.cancel()"
                class="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
                {{ s.cancelLabel }}
              </button>
              <button type="button" (click)="svc.confirm()"
                class="rounded-lg px-4 py-2 text-sm font-medium text-white transition"
                [class.bg-red-600]="s.tone === 'danger'"
                [class.hover:bg-red-700]="s.tone === 'danger'"
                [class.bg-brand-600]="s.tone !== 'danger'"
                [class.hover:bg-brand-700]="s.tone !== 'danger'">
                {{ s.confirmLabel }}
              </button>
            </div>
          </div>
        </div>
      }
    }
  `,
})
export class ConfirmHostComponent {
  readonly svc = inject(ConfirmService);

  /** Esc cancels the dialog (only acts when one is open). */
  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.svc.state().open) this.svc.cancel();
  }
}
