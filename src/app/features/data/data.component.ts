import { Component, OnInit, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import {
  ImportBatch, ImportResult, ImportRow, ParsedFile, ProductColumn, ProductSnapshot,
  downloadProductTemplate, exportProducts, importProducts, loadImportHistory, parseProductFile,
} from '../../core/data/product-io';
import { AssignmentsImportComponent } from './assignments-import.component';
import { StockDataComponent } from './stock-data.component';
import { ExportsComponent } from './exports.component';
import { ActivatedRoute } from '@angular/router';
import { inject } from '@angular/core';

type Step = 'idle' | 'reading' | 'preview' | 'importing' | 'done';
type Filter = 'all' | 'new' | 'update' | 'unchanged' | 'error';
type Tab = 'products' | 'assignments' | 'stock' | 'sales';

const MAX_SHOWN = 300;
const OPTIONAL: { col: ProductColumn; label: string }[] = [
  { col: 'category', label: 'Category' },
  { col: 'barcode', label: 'Barcode' },
  { col: 'active', label: 'Active' },
];

@Component({
  selector: 'app-data',
  standalone: true,
  imports: [DatePipe, AssignmentsImportComponent, StockDataComponent, ExportsComponent],
  templateUrl: './data.component.html',
})
export class DataComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);

  readonly tab = signal<Tab>('products');

  readonly step = signal<Step>('idle');
  readonly file = signal<ParsedFile | null>(null);
  readonly result = signal<ImportResult | null>(null);
  readonly error = signal<string | null>(null);
  readonly filter = signal<Filter>('all');
  readonly exporting = signal(false);
  readonly dragOver = signal(false);
  readonly history = signal<ImportBatch[]>([]);
  readonly changes = computed(() => (this.result()?.new ?? 0) + (this.result()?.updated ?? 0));
  readonly canImport = computed(
    () => this.step() === 'preview' && !!this.result()?.ok && this.changes() > 0
  );

  /** Columns not in the file — their values stay as they are. */
  readonly keptColumns = computed(() => {
    const cols = this.file()?.columns ?? [];
    return OPTIONAL.filter((o) => !cols.includes(o.col)).map((o) => o.label);
  });

  readonly errorsByRow = computed(() => {
    const m = new Map<number, string[]>();
    for (const e of this.result()?.errors ?? []) {
      const list = m.get(e.row) ?? [];
      list.push(e.message);
      m.set(e.row, list);
    }
    return m;
  });

  readonly filteredRows = computed(() => {
    const rows = this.result()?.rows ?? [];
    const f = this.filter();
    return f === 'all' ? rows : rows.filter((r) => r.action === f);
  });

  readonly shownRows = computed(() => this.filteredRows().slice(0, MAX_SHOWN));
  readonly maxShown = MAX_SHOWN;

  async ngOnInit(): Promise<void> {
  const requestedTab = this.route.snapshot.queryParamMap.get('tab');

  if (
    requestedTab === 'products' ||
    requestedTab === 'assignments' ||
    requestedTab === 'stock' ||
    requestedTab === 'sales'
  ) {
    this.tab.set(requestedTab);
  }

  await this.loadHistory();
}

  // ---------- file ----------
  onFileInput(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (f) void this.read(f);
  }

  onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver.set(true);
  }

  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver.set(false);
    const f = ev.dataTransfer?.files?.[0];
    if (f) void this.read(f);
  }

  private async read(f: File): Promise<void> {
    this.reset();
    this.step.set('reading');
    try {
      const parsed = await parseProductFile(f);
      const { result, error } = await importProducts(parsed, true);
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

    const { result, error } = await importProducts(parsed, false);

    if (error || !result) {
      this.error.set(error ?? 'Import failed.');
      this.step.set('preview');
      return;
    }

    if (!result.applied) {
      this.result.set(result);
      this.filter.set('error');
      this.error.set('Products changed since the preview. Fix the rows below and upload the file again.');
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

  // ---------- export ----------
  async exportAll(): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(true);
    const err = await exportProducts();
    this.exporting.set(false);
    if (err) this.error.set(err);
  }

  downloadTemplate(): void {
    void downloadProductTemplate();
  }

  // ---------- view helpers ----------
  changed(row: ImportRow, field: keyof ProductSnapshot): boolean {
    return row.action === 'update' && !!row.before && row.before[field] !== row[field];
  }

  rowErrors(row: ImportRow): string[] {
    return this.errorsByRow().get(row.row) ?? [];
  }

  badge(action: ImportRow['action']): string {
    switch (action) {
      case 'new': return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
      case 'update': return 'bg-amber-50 text-amber-700 ring-amber-200';
      case 'error': return 'bg-red-50 text-red-700 ring-red-200';
      default: return 'bg-slate-50 text-slate-500 ring-slate-200';
    }
  }

  private fail(msg: string): void {
    this.error.set(msg);
    this.step.set('idle');
  }

  private async loadHistory(): Promise<void> {
    this.history.set(await loadImportHistory());
  }
}
