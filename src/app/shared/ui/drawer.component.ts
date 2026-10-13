import { Component, HostListener, input, output } from '@angular/core';

@Component({
  selector: 'app-drawer',
  standalone: true,
  host: { '[attr.inert]': 'open() ? null : ""' },
  template: `
    <!-- Backdrop -->
    <div class="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[1px] transition-[opacity,visibility] duration-300"
         [class.opacity-0]="!open()" [class.invisible]="!open()"
         (click)="close.emit()"></div>

    <!-- Panel -->
    <div role="dialog" aria-modal="true" [attr.aria-label]="title()"
         class="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-white shadow-2xl
                transition-[transform,visibility] duration-300 ease-[cubic-bezier(.2,.8,.2,1)]"
         [class.translate-x-full]="!open()" [class.invisible]="!open()">
      <div class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <h2 class="text-base font-semibold text-slate-900">{{ title() }}</h2>
        <button (click)="close.emit()" aria-label="Close"
                class="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="flex-1 overflow-y-auto px-6 py-5"><ng-content></ng-content></div>
      <div class="border-t border-slate-200 px-6 py-4"><ng-content select="[drawer-footer]"></ng-content></div>
    </div>
  `,
})
export class DrawerComponent {
  readonly open = input<boolean>(false);
  readonly title = input<string>('');
  readonly close = output<void>();

  @HostListener('document:keydown.escape')
  onEsc(): void { if (this.open()) this.close.emit(); }
}