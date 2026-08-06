import { Component, computed, inject, input, output, effect } from '@angular/core';
import { DatePipe } from '@angular/common';
import { DeliveriesService } from './deliveries.service';
import { Order } from '../orders/order.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { DrawerComponent } from '../../shared/ui/drawer.component';

/**
 * Read-only reconciliation view for a DELIVERED order.
 * Shows, per line: ordered vs delivered, the variance, and the reason —
 * plus who received it, the carrier, and when. This surfaces on the ORDER
 * the "reality" story that until now only lived in the stock-movement graph.
 */
@Component({
  selector: 'app-delivery-summary',
  standalone: true,
  imports: [DatePipe, BadgeComponent, DrawerComponent],
  templateUrl: './delivery-summary.component.html',
})
export class DeliverySummaryComponent {
  readonly svc = inject(DeliveriesService);

  readonly order = input<Order | null>(null);
  readonly open = input<boolean>(false);
  readonly close = output<void>();

  constructor() {
    effect(() => {
      const o = this.order();
      if (this.open() && o) {
        void this.svc.loadFulfillment(o.id);
        void this.svc.loadDelivery(o.id);
      }
    });
  }

  variance(row: { variance: number | null }): number {
    return row.variance ?? 0;
  }

  varianceTone(row: { variance: number | null }): 'success' | 'warning' | 'info' {
    const v = this.variance(row);
    if (v === 0) return 'success';
    if (v < 0) return 'warning';
    return 'info';
  }

  varianceLabel(row: { variance: number | null }): string {
    const v = this.variance(row);
    if (v === 0) return 'Exact';
    if (v < 0) return `Short ${Math.abs(v)}`;
    return `Over ${v}`;
  }

  /** Totals across all lines for the header strip. */
  readonly totals = computed(() => {
    const rows = this.svc.fulfillment();
    let ordered = 0, delivered = 0, exact = 0, short = 0, over = 0;
    for (const r of rows) {
      ordered += r.ordered_qty ?? 0;
      delivered += r.delivered_qty ?? 0;
      const v = r.variance ?? 0;
      if (v === 0) exact++; else if (v < 0) short++; else over++;
    }
    return { ordered, delivered, variance: delivered - ordered, exact, short, over, lines: rows.length };
  });

  readonly hasVariance = computed(() => this.svc.fulfillment().some((r) => (r.variance ?? 0) !== 0));
}
