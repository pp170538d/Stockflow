import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-drawer',
  standalone: true,
  template: `
    @if (open()) {
      <!-- Backdrop -->
      <div class="fixed inset-0 z-40 bg-slate-900/40 transition-opacity"
           (click)="close.emit()"></div>

      <!-- Panel -->
      <div class="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col
                  bg-white shadow-xl">
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 class="text-base font-semibold text-slate-900">{{ title() }}</h2>
          <button (click)="close.emit()"
                  class="grid h-8 w-8 place-items-center rounded-lg text-slate-400
                         transition hover:bg-slate-100 hover:text-slate-600">
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>

        <!-- Body (scrollable) -->
        <div class="flex-1 overflow-y-auto px-6 py-5">
          <ng-content></ng-content>
        </div>

        <!-- Footer -->
        <div class="border-t border-slate-200 px-6 py-4">
          <ng-content select="[drawer-footer]"></ng-content>
        </div>
      </div>
    }
  `,
})
export class DrawerComponent {
  readonly open = input<boolean>(false);
  readonly title = input<string>('');
  readonly close = output<void>();
}