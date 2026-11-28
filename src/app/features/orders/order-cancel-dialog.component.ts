import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppError } from '../../core/errors/app-error';
import { Order } from './order.model';

export type CancelReason = 'SUPPLIER_WILL_NOT_DELIVER'|'ORDERED_BY_MISTAKE'|'DUPLICATE_ORDER'|'NO_LONGER_REQUIRED'|'LEGACY_TEST_ORDER'|'OTHER';

@Component({
  selector: 'app-order-cancel-dialog', standalone: true, imports: [FormsModule],
  templateUrl: './order-cancel-dialog.component.html',
})
export class OrderCancelDialogComponent {
  @Input({ required: true }) order!: Order;
  @Input() saving = false;
  @Input() error: AppError | null = null;
  @Output() close = new EventEmitter<void>();
  @Output() confirmCancel = new EventEmitter<{ reason: CancelReason; note: string }>();
  readonly reason = signal<CancelReason | ''>('');
  readonly note = signal('');
  readonly reasons: Array<{ value: CancelReason; label: string }> = [
    { value:'SUPPLIER_WILL_NOT_DELIVER', label:'Supplier will not deliver' },
    { value:'ORDERED_BY_MISTAKE', label:'Ordered by mistake' },
    { value:'DUPLICATE_ORDER', label:'Duplicate order' },
    { value:'NO_LONGER_REQUIRED', label:'No longer required' },
    { value:'LEGACY_TEST_ORDER', label:'Legacy test order' },
    { value:'OTHER', label:'Other' },
  ];
  get canSubmit(): boolean { return !!this.reason() && (this.reason() !== 'OTHER' || !!this.note().trim()) && !this.saving; }
  submit(): void { if (this.canSubmit) this.confirmCancel.emit({ reason: this.reason() as CancelReason, note: this.note().trim() }); }
}
