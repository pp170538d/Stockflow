import { Component, inject } from '@angular/core';
import { ToastService, Toast } from './toast.service';

/**
 * Renders the global toast stack. Mount ONCE, at the end of the app shell
 * template:  <app-toast-host />
 *
 * Fixed to the bottom-right, newest on top of the stack, each auto-dismissing
 * (errors + actionable toasts linger longer — see ToastService).
 */
@Component({
  selector: 'app-toast-host',
  standalone: true,
  template: `
    <div class="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
      @for (t of svc.toasts(); track t.id) {
        <div
          class="pointer-events-auto flex items-start gap-3 rounded-xl bg-white p-3 shadow-lg ring-1 transition-all"
          [class.ring-green-200]="t.tone === 'success'"
          [class.ring-red-200]="t.tone === 'error'"
          [class.ring-blue-200]="t.tone === 'info'"
          [class.ring-amber-200]="t.tone === 'warning'"
          role="status" aria-live="polite">

          <!-- Tone dot / icon -->
          <span class="mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-full text-xs text-white"
            [class.bg-green-500]="t.tone === 'success'"
            [class.bg-red-500]="t.tone === 'error'"
            [class.bg-blue-500]="t.tone === 'info'"
            [class.bg-amber-500]="t.tone === 'warning'">
            {{ icon(t) }}
          </span>

          <!-- Message -->
          <div class="min-w-0 flex-1 pt-0.5">
            <p class="text-sm text-slate-700">{{ t.message }}</p>
          </div>

          <!-- Optional action (e.g. Undo) -->
          @if (t.action) {
            <button (click)="svc.runAction(t)"
              class="flex-shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-brand-600 transition hover:bg-brand-50">
              {{ t.action.label }}
            </button>
          }

          <!-- Dismiss -->
          <button (click)="svc.dismiss(t.id)" aria-label="Dismiss"
            class="flex-shrink-0 rounded-md px-1.5 py-0.5 text-slate-300 transition hover:bg-slate-100 hover:text-slate-500">
            ✕
          </button>
        </div>
      }
    </div>
  `,
})
export class ToastHostComponent {
  readonly svc = inject(ToastService);

  icon(t: Toast): string {
    return { success: '✓', error: '!', info: 'i', warning: '⚠' }[t.tone];
  }
}
