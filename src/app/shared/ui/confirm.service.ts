import { Injectable, signal } from '@angular/core';

export type ConfirmTone = 'default' | 'danger';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;   // default: 'Confirm'
  cancelLabel?: string;    // default: 'Cancel'
  tone?: ConfirmTone;      // 'danger' → red confirm button
}

interface ConfirmState extends Required<ConfirmOptions> {
  open: boolean;
}

/**
 * Global confirm-dialog service.
 *
 * Usage (await the user's choice inline — no callbacks):
 *   private confirm = inject(ConfirmService);
 *
 *   const ok = await this.confirm.ask({
 *     title: 'Reject this order?',
 *     message: 'The order will be marked REJECTED. This can’t be undone.',
 *     confirmLabel: 'Reject order',
 *     tone: 'danger',
 *   });
 *   if (!ok) return;
 *   // …proceed
 *
 * The <app-confirm-host> component (mounted once in the shell) renders it.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly state = signal<ConfirmState>({
    open: false,
    title: '',
    message: '',
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    tone: 'default',
  });

  private resolver: ((ok: boolean) => void) | null = null;

  /** Open the dialog and resolve true (confirm) or false (cancel/dismiss). */
  ask(opts: ConfirmOptions): Promise<boolean> {
    this.state.set({
      open: true,
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? 'Confirm',
      cancelLabel: opts.cancelLabel ?? 'Cancel',
      tone: opts.tone ?? 'default',
    });
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
    });
  }

  /** Called by the host when the user clicks Confirm. */
  confirm(): void {
    this.close(true);
  }

  /** Called by the host on Cancel, backdrop click, or Esc. */
  cancel(): void {
    this.close(false);
  }

  private close(result: boolean): void {
    this.state.update((s) => ({ ...s, open: false }));
    this.resolver?.(result);
    this.resolver = null;
  }
}
