import { Component, input } from '@angular/core';

type BadgeTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

@Component({
  selector: 'app-badge',
  standalone: true,
  template: `
    <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
          [class]="toneClasses()">
      <span class="h-1.5 w-1.5 rounded-full" [class]="dotClasses()"></span>
      <ng-content></ng-content>
    </span>
  `,
})
export class BadgeComponent {
  readonly tone = input<BadgeTone>('neutral');

  toneClasses(): string {
    return {
      success: 'bg-green-50 text-green-700',
      warning: 'bg-amber-50 text-amber-700',
      error:   'bg-red-50 text-red-700',
      info:    'bg-blue-50 text-blue-700',
      neutral: 'bg-slate-100 text-slate-600',
    }[this.tone()];
  }

  dotClasses(): string {
    return {
      success: 'bg-green-500',
      warning: 'bg-amber-500',
      error:   'bg-red-500',
      info:    'bg-blue-500',
      neutral: 'bg-slate-400',
    }[this.tone()];
  }
}