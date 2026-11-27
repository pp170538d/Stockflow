import { Component, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HeldDisposition, HeldStock, HeldStockService } from './held-stock.service';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';

@Component({
  selector: 'app-held-stock-drawer',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './held-stock-drawer.component.html',
})
export class HeldStockDrawerComponent {
  private svc = inject(HeldStockService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly open = input(false);
  readonly lineId = input<string | null>(null);
  readonly product = input('');
  readonly close = output<void>();
  readonly changed = output<void>();

  readonly held = signal<HeldStock | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);

  type: HeldDisposition = 'ACCEPT';
  qty = 1;
  provider = 'MANUAL';
  documentNo = '';
  externalId = '';
  note = '';

  constructor() {
    effect(() => {
      const id = this.lineId();
      if (this.open() && id) void this.load(id);
    });
  }

  async load(id: string): Promise<void> {
    this.loading.set(true);
    const h = await this.svc.forLine(id);
    this.held.set(h);
    if (h) this.qty = Math.min(1, h.remaining_qty);
    this.loading.set(false);
  }

  setType(type: HeldDisposition): void {
    this.type = type;
    this.documentNo = '';
    this.externalId = '';
    this.note = '';
  }

  setQty(value: number): void {
    const max = this.held()?.remaining_qty ?? 1;
    this.qty = Math.max(1, Math.min(max, Math.floor(value) || 1));
  }

  actionLabel(): string {
    if (this.type === 'ACCEPT') return 'Accept into stock';
    if (this.type === 'RETURN_LATER') return 'Confirm return';
    return 'Confirm disposal';
  }

  private confirmation(): { title: string; message: string; confirmLabel: string; tone?: 'danger' } {
    if (this.type === 'ACCEPT') return {
      title: `Accept ${this.qty} HELD unit${this.qty === 1 ? '' : 's'}?`,
      message: `${this.qty} unit${this.qty === 1 ? '' : 's'} of ${this.product()} will enter usable stock.`,
      confirmLabel: 'Accept into stock',
    };
    if (this.type === 'RETURN_LATER') return {
      title: `Return ${this.qty} HELD unit${this.qty === 1 ? '' : 's'}?`,
      message: `The return will be recorded under dispatch ${this.documentNo.trim()}.`,
      confirmLabel: 'Confirm return',
    };
    return {
      title: `Dispose ${this.qty} HELD unit${this.qty === 1 ? '' : 's'}?`,
      message: 'This records authorized disposal. The goods will not enter usable stock.',
      confirmLabel: 'Confirm disposal',
      tone: 'danger',
    };
  }

  async submit(): Promise<void> {
    const h = this.held();
    if (!h || this.saving()) return;

    const ok = await this.confirm.ask(this.confirmation());
    if (!ok) return;

    this.saving.set(true);
    const r = await this.svc.dispose(
      h.id,
      this.qty,
      this.type,
      this.type === 'RETURN_LATER' ? this.provider : null,
      this.type === 'RETURN_LATER' ? this.documentNo.trim() : null,
      this.type === 'RETURN_LATER' ? this.externalId.trim() || null : null,
      this.note.trim() || null
    );
    this.saving.set(false);

    if (r.error || !r.data) {
      this.toast.error(r.error ?? 'Could not update HELD goods.');
      return;
    }

    const outcome = this.type === 'ACCEPT'
      ? `${this.qty} unit(s) accepted into usable stock.`
      : this.type === 'RETURN_LATER'
        ? `${this.qty} unit(s) recorded for supplier return.`
        : `${this.qty} unit(s) disposed.`;

    this.toast.success(
      r.data.remaining_qty === 0
        ? `${outcome} HELD custody closed.`
        : `${outcome} ${r.data.remaining_qty} unit(s) still held.`
    );

    await this.load(this.lineId()!);
    this.changed.emit();
  }
}
