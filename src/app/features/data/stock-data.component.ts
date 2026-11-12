import { Component, signal } from '@angular/core';
import { exportCurrentStock } from '../../core/data/opening-io';
import { OpeningImportComponent } from './opening-import.component';
import { ExportsComponent } from './exports.component';

type StockTab = 'opening' | 'snapshot' | 'movements';

@Component({
  selector: 'app-stock-data',
  standalone: true,
  imports: [OpeningImportComponent, ExportsComponent],
  templateUrl: './stock-data.component.html',
})
export class StockDataComponent {
  readonly tab = signal<StockTab>('opening');
  readonly exporting = signal(false);
  readonly error = signal<string | null>(null);
  readonly done = signal<string | null>(null);

  async exportSnapshot(): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(true);
    this.error.set(null);
    this.done.set(null);
    const err = await exportCurrentStock();
    this.exporting.set(false);
    if (err) this.error.set(err);
    else this.done.set('Current stock snapshot exported.');
  }
}
