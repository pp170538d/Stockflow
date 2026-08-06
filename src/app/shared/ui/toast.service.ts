import { Injectable, signal } from '@angular/core';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  /** Optional single action, e.g. an "Undo" button. */
  action?: { label: string; run: () => void };
  /** ms before auto-dismiss. 0 = sticky (won't auto-close). */
  duration: number;
}

/**
 * Global toast/notification service.
 *
 * Usage anywhere:
 *   private toast = inject(ToastService);
 *   this.toast.success('Delivery recorded');
 *   this.toast.error('Could not save — try again');
 *   this.toast.success('Order approved', { action: { label: 'Undo', run: () => … } });
 *
 * The <app-toast-host> component (mounted once in the shell) renders these.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private nextId = 0;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  private push(tone: ToastTone, message: string, opts?: Partial<Pick<Toast, 'action' | 'duration'>>): number {
    const id = ++this.nextId;
    // Errors linger longer; anything with an action (e.g. Undo) gets extra time.
    const duration = opts?.duration
      ?? (opts?.action ? 8000 : tone === 'error' ? 6000 : 4000);
    const toast: Toast = { id, tone, message, action: opts?.action, duration };
    this.toasts.update((list) => [...list, toast]);
    if (duration > 0) {
      this.timers.set(id, setTimeout(() => this.dismiss(id), duration));
    }
    return id;
  }

  success(message: string, opts?: Partial<Pick<Toast, 'action' | 'duration'>>) { return this.push('success', message, opts); }
  error(message: string, opts?: Partial<Pick<Toast, 'action' | 'duration'>>)   { return this.push('error', message, opts); }
  info(message: string, opts?: Partial<Pick<Toast, 'action' | 'duration'>>)    { return this.push('info', message, opts); }
  warning(message: string, opts?: Partial<Pick<Toast, 'action' | 'duration'>>) { return this.push('warning', message, opts); }

  /** Run the toast's action then dismiss it (used by the Undo button). */
  runAction(t: Toast): void {
    t.action?.run();
    this.dismiss(t.id);
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) { clearTimeout(timer); this.timers.delete(id); }
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  clear(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.toasts.set([]);
  }
}
