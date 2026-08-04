import { Component, input } from '@angular/core';

@Component({
  selector: 'app-empty-state',
  standalone: true,
  template: `
    <div class="flex flex-col items-center justify-center rounded-2xl border border-dashed
                border-slate-300 bg-white px-6 py-16 text-center">
      <div class="grid h-12 w-12 place-items-center rounded-xl bg-slate-100 text-slate-400">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7h18M3 12h18M3 17h18" />
        </svg>
      </div>
      <h3 class="mt-4 text-sm font-semibold text-slate-900">{{ title() }}</h3>
      <p class="mt-1 max-w-sm text-sm text-slate-500">{{ subtitle() }}</p>
      <div class="mt-6"><ng-content></ng-content></div>
    </div>
  `,
})
export class EmptyStateComponent {
  readonly title = input<string>('Nothing here yet');
  readonly subtitle = input<string>('');
}