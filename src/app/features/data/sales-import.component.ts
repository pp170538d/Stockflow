import { ChangeDetectionStrategy, Component, OnInit, computed, signal } from '@angular/core';
import { DecimalPipe, DatePipe } from '@angular/common';
import {
  SalesBatch, SalesResult, SalesRow, ParsedSalesFile,
  parseSalesFile, importSales, loadSalesHistory, downloadSalesTemplate,
} from '../../core/data/sales-io';

type Step = 'idle' | 'checking' | 'preview' | 'importing' | 'done';
type Filter = 'all' | 'error' | 'warning';

@Component({
  selector: 'app-sales-import',
  standalone: true,
  imports: [DecimalPipe, DatePipe],
  templateUrl: './sales-import.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SalesImportComponent implements OnInit {
  readonly step = signal<Step>('idle');
  readonly file = signal<ParsedSalesFile | null>(null);
  readonly result = signal<SalesResult | null>(null);
  readonly error = signal<string | null>(null);
  readonly filter = signal<Filter>('all');
  readonly history = signal<SalesBatch[]>([]);
  readonly dragging = signal(false);

  readonly errorsByRow = computed(() => groupByRow(this.result()?.errors ?? []));
  readonly warningsByRow = computed(() => groupByRow(this.result()?.warnings ?? []));

  readonly visibleRows = computed(() => {
    const rows = this.result()?.rows ?? [];
    switch (this.filter()) {
      case 'error': return rows.filter((r) => r.action === 'error');
      case 'warning': return rows.filter((r) => this.warningsByRow().has(r.row));
      default: return rows;
    }
  });

  /** Warnings not tied to a visible row (e.g. negative stock, reported once per product). */
  readonly negativeStock = computed(() =>
    (this.result()?.warnings ?? []).filter((w) => w.message.includes('goes negative'))
  );

  readonly canImport = computed(() => {
    const r = this.result();
    return this.step() === 'preview' && !!r && r.ok && r.sales + r.returns > 0;
  });

  ngOnInit(): void {
    void this.loadHistory();
  }

  // ---------- file ----------
  onPick(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (f) void this.check(f);
  }

  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.dragging.set(false);
    const f = ev.dataTransfer?.files?.[0];
    if (f) void this.check(f);
  }

  onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    this.dragging.set(true);
  }

  async check(f: File): Promise<void> {
    this.step.set('checking');
    this.error.set(null);
    this.result.set(null);
    try {
      const parsed = await parseSalesFile(f);
      const { result, error } = await importSales(parsed, true);
      if (error || !result) {
        this.fail(error ?? 'Preview failed.');
        return;
      }
      this.file.set(parsed);
      this.result.set(result);
      this.filter.set(result.invalid > 0 ? 'error' : 'all');
      this.step.set('preview');
    } catch (e) {
      this.fail(e instanceof Error ? e.message : 'Could not read the file.');
    }
  }

  // ---------- import ----------
  async apply(): Promise<void> {
    const parsed = this.file();
    if (!parsed || !this.canImport()) return;

    this.step.set('importing');
    this.error.set(null);

    const { result, error } = await importSales(parsed, false);
    if (error || !result) {
      this.error.set(error ?? 'Import failed.');
      this.step.set('preview');
      return;
    }
    if (!result.applied) {
      this.result.set(result);
      this.filter.set('error');
      this.error.set('Data changed since the preview. Fix the rows below and upload the file again.');
      this.step.set('preview');
      return;
    }
    this.result.set(result);
    this.step.set('done');
    void this.loadHistory();
  }

  reset(): void {
    this.step.set('idle');
    this.file.set(null);
    this.result.set(null);
    this.error.set(null);
    this.filter.set('all');
  }

  downloadTemplate(): void {
    void downloadSalesTemplate();
  }

  // ---------- view helpers ----------
  rowErrors(row: SalesRow): string[] {
    return this.errorsByRow().get(row.row) ?? [];
  }

  rowWarnings(row: SalesRow): string[] {
    return (this.warningsByRow().get(row.row) ?? []).filter((m) => !m.includes('goes negative'));
  }

  label(action: SalesAction): string {
    switch (action) {
      case 'sale': return 'Sale';
      case 'return': return 'Return';
      default: return 'Error';
    }
  }

  badge(action: SalesAction): string {
    switch (action) {
      case 'sale': return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
      case 'return': return 'bg-sky-50 text-sky-700 ring-sky-200';
      default: return 'bg-red-50 text-red-700 ring-red-200';
    }
  }

  private fail(msg: string): void {
    this.error.set(msg);
    this.step.set('idle');
  }

  private async loadHistory(): Promise<void> {
    this.history.set(await loadSalesHistory());
  }
}

type SalesAction = SalesRow['action'];

function groupByRow(items: { row: number; message: string }[]): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const it of items) {
    const list = m.get(it.row) ?? [];
    list.push(it.message);
    m.set(it.row, list);
  }
  return m;
}
