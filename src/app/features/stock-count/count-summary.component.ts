import { Component, computed, inject, input, output, effect } from '@angular/core';
import { DatePipe } from '@angular/common';
import { StockCountService } from './stock-count.service';
import { StockCountSummary } from './stock-count.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { DrawerComponent } from '../../shared/ui/drawer.component';

/**
 * Read-only reconciliation view for a single past stock count.
 * Shows who/when and per-line detail. Deliberately NO summed-quantity totals
 * (summing units across different products is meaningless) — only a
 * product-count header ("2 of 2 products differed").
 */
@Component({
  selector: 'app-count-summary',
  standalone: true,
  imports: [DatePipe, BadgeComponent, DrawerComponent],
  templateUrl: './count-summary.component.html',
})
export class CountSummaryComponent {
  readonly svc = inject(StockCountService);

  readonly count = input<StockCountSummary | null>(null);
  readonly open = input<boolean>(false);
  readonly close = output<void>();

  constructor() {
    effect(() => {
      const c = this.count();
      if (this.open() && c) void this.svc.loadItems(c.count_id);
    });
  }

  variance(v: number | null): number {
    return v ?? 0;
  }
  varianceTone(v: number | null): 'success' | 'warning' | 'info' {
    const x = v ?? 0;
    return x === 0 ? 'success' : x < 0 ? 'warning' : 'info';
  }
  varianceLabel(v: number | null): string {
    const x = v ?? 0;
    return x === 0 ? 'Match' : x < 0 ? `Short ${Math.abs(x)}` : `Over ${x}`;
  }

  /** Product-count header only — never sums quantities across products. */
  readonly totals = computed(() => {
    const items = this.svc.items();
    const lines = items.length;
    const off = items.filter((i) => (i.variance ?? 0) !== 0).length;
    return { lines, off, matched: lines - off };
  });

  readonly hasVariance = computed(() => this.totals().off > 0);
}
