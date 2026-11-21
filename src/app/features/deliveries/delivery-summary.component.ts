import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { DeliveriesService } from './deliveries.service';
import { ReceiptLine, Resolution } from './delivery.model';
import { Order } from '../orders/order.model';
import { AuthService } from '../../core/auth/auth.service';
import { reasonLabel } from '../../core/stock/reason-codes';
import { DrawerComponent } from '../../shared/ui/drawer.component';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { printGoodsReceipt } from './grn-pdf';

type View = 'open' | 'resolved' | 'all';

interface ResolutionOption {
  code: Resolution;
  label: string;
  hint: string;
  primary?: boolean;
}

const SHORT_OPTIONS: ResolutionOption[] = [
  { code: 'BACKORDER', label: 'Backorder', hint: 'Supplier sends the rest — creates an approved order', primary: true },
  { code: 'CLOSE_SHORT', label: 'Close short', hint: 'The rest will not come' },
  { code: 'CLAIM', label: 'Claim', hint: 'Invoice dispute / credit note — note required' },
];

const OVER_OPTIONS: ResolutionOption[] = [
  { code: 'ACCEPT', label: 'Accept extra', hint: 'Keep the units, supplier invoices the difference', primary: true },
  { code: 'RETURN_TO_SUPPLIER', label: 'Return to supplier', hint: 'Takes the extra units off the shelf' },
  { code: 'CLAIM', label: 'Claim', hint: 'Invoice dispute — note required' },
];

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  BACKORDER: 'Backordered',
  CLOSE_SHORT: 'Closed short',
  CLAIM: 'Claim opened',
  ACCEPT: 'Accepted',
  RETURN_TO_SUPPLIER: 'Returned to supplier',
};

/**
 * Goods receipt (GRN) for a DELIVERED order.
 * Built for receipts with many lines: filter, search, bulk decisions,
 * one expanded line at a time, and Print / Save PDF.
 */
@Component({
  selector: 'app-delivery-summary',
  standalone: true,
  imports: [DatePipe, DecimalPipe, DrawerComponent],
  templateUrl: './delivery-summary.component.html',
})
export class DeliverySummaryComponent {
  readonly svc = inject(DeliveriesService);
  readonly auth = inject(AuthService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly order = input<Order | null>(null);
  readonly open = input<boolean>(false);
  readonly close = output<void>();
  readonly changed = output<void>();

  readonly view = signal<View>('all');
  readonly search = signal('');
  readonly expanded = signal<string | null>(null);
  readonly note = signal('');

  constructor() {
    effect(() => {
      const o = this.order();
      if (this.open() && o) {
        this.search.set('');
        this.expanded.set(null);
        this.note.set('');
        void this.svc.loadReceipt(o.id).then(() => {
          this.view.set(this.openLines().length ? 'open' : 'all');
        });
      }
    });
  }

  // ---------- data ----------
  readonly r = computed(() => this.svc.receipt());
  readonly lines = computed(() => this.r()?.lines ?? []);
  readonly openLines = computed(() => this.lines().filter((l) => l.resolution_status === 'open'));
  readonly resolvedLines = computed(() => this.lines().filter((l) => l.resolution_status === 'resolved'));

  readonly visible = computed(() => {
    const q = this.search().trim().toLowerCase();
    const base =
      this.view() === 'open' ? this.openLines()
      : this.view() === 'resolved' ? this.resolvedLines()
      : this.lines();
    return q
      ? base.filter((l) => l.product_name.toLowerCase().includes(q) || l.sku.toLowerCase().includes(q))
      : base;
  });

  readonly totals = computed(() => {
    let ordered = 0, received = 0, orderedValue = 0, receivedValue = 0;
    let exact = 0, short = 0, over = 0, missingCost = 0;
    for (const l of this.lines()) {
      ordered += l.ordered_qty;
      received += l.received_qty;
      orderedValue += l.ordered_value ?? 0;
      receivedValue += l.received_value ?? 0;
      if (l.unit_cost === null) missingCost++;
      if (l.variance === 0) exact++; else if (l.variance < 0) short++; else over++;
    }
    return {
      ordered, received, orderedValue, receivedValue,
      differenceValue: receivedValue - orderedValue,
      exact, short, over, missingCost,
    };
  });

  /** Bulk targets: open lines in the current filter/search. */
  readonly bulkOver = computed(() =>
    this.visible().filter((l) => l.resolution_status === 'open' && l.variance > 0));
  readonly bulkShort = computed(() =>
    this.visible().filter((l) => l.resolution_status === 'open' && l.variance < 0));

  // ---------- presentation ----------
  options(l: ReceiptLine): ResolutionOption[] {
    return l.variance < 0 ? SHORT_OPTIONS : OVER_OPTIONS;
  }

  reasonText(l: ReceiptLine): string {
    return reasonLabel(l.reason_code);
  }

  extraNote(l: ReceiptLine): string | null {
    return l.reason && l.reason !== reasonLabel(l.reason_code) ? l.reason : null;
  }

  resolutionLabel(l: ReceiptLine): string {
    return l.resolution ? RESOLUTION_LABELS[l.resolution] : 'Resolved';
  }

  signed(n: number): string {
    return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
  }

  toggle(l: ReceiptLine): void {
    if (l.resolution_status !== 'open' || !this.auth.isAdmin()) return;
    this.note.set('');
    this.expanded.set(this.expanded() === l.line_id ? null : l.line_id);
  }

  // ---------- actions ----------
  async resolveOne(l: ReceiptLine, opt: ResolutionOption): Promise<void> {
    if (!l.line_id) return;
    await this.run([l], opt.code, opt.label);
  }

  async bulk(kind: 'ACCEPT' | 'BACKORDER' | 'CLOSE_SHORT'): Promise<void> {
    const lines = kind === 'ACCEPT' ? this.bulkOver() : this.bulkShort();
    const label = { ACCEPT: 'Accept all extra', BACKORDER: 'Backorder all short', CLOSE_SHORT: 'Close all short' }[kind];
    await this.run(lines, kind, label);
  }

  private async run(lines: ReceiptLine[], code: Resolution, label: string): Promise<void> {
    const ids = lines.map((l) => l.line_id).filter((id): id is string => !!id);
    if (!ids.length) return;

    const note = this.note().trim() || null;
    if (code === 'CLAIM' && !note) {
      this.toast.error('Add a note for the claim — claim number or what was agreed.');
      return;
    }

    const units = lines.reduce((s, l) => s + Math.abs(l.variance), 0);
    const what = lines.length === 1 ? `${units} × ${lines[0].product_name}` : `${lines.length} lines (${units} units)`;
    const message = {
      BACKORDER: `Creates ONE approved order for ${what} from the same supplier. It will show as "on the way".`,
      CLOSE_SHORT: `${what} will not be delivered. If shelves run low, replenishment suggests a new order.`,
      CLAIM: `Records a claim for ${what} with your note.`,
      ACCEPT: `Keeps the extra ${what} on the shelf.`,
      RETURN_TO_SUPPLIER: `Removes ${what} from stock as returned to the supplier.`,
    }[code];

    const ok = await this.confirm.ask({
      title: `${label}?`,
      message,
      confirmLabel: label,
      ...(code === 'RETURN_TO_SUPPLIER' ? { tone: 'danger' as const } : {}),
    });
    if (!ok) return;

    const res = await this.svc.resolve(ids, code, note);
    if (res.error) {
      this.toast.error(res.error);
      return;
    }

    this.expanded.set(null);
    this.note.set('');
    this.toast.success(
      code === 'BACKORDER' && res.backorderNumber
        ? `Backorder ${res.backorderNumber} created and approved.`
        : `${res.resolved ?? ids.length} ${(res.resolved ?? ids.length) === 1 ? 'line' : 'lines'} ${RESOLUTION_LABELS[code].toLowerCase()}.`
    );
    if (!this.openLines().length) this.view.set('all');
    this.changed.emit();
  }

  print(): void {
    const r = this.r();
    if (!r) return;
    const err = printGoodsReceipt(r);
    if (err) this.toast.error(err);
  }
}
