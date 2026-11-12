import { Component, OnInit, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import {
  OpeningBatch, OpeningResult, OpeningRow, ParsedOpeningFile,
  downloadOpeningTemplate, exportCurrentStock, importOpening,
  loadOpeningHistory, parseOpeningFile,
} from '../../core/data/opening-io';

type Step = 'idle' | 'reading' | 'preview' | 'importing' | 'done';
type Filter = 'all' | 'increase' | 'decrease' | 'unchanged' | 'error';

const MAX_SHOWN = 300;

@Component({
  selector: 'app-opening-import',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './opening-import.component.html',
})
export class OpeningImportComponent implements OnInit {
  readonly step = signal<Step>('idle');
  readonly file = signal<ParsedOpeningFile | null>(null);
  readonly result = signal<OpeningResult | null>(null);
  readonly error = signal<string | null>(null);
  readonly filter = signal<Filter>('all');
  readonly exporting = signal(false);
  readonly dragOver = signal(false);
  readonly history = signal<OpeningBatch[]>([]);

  readonly changes = computed(() => (this.result()?.increase ?? 0) + (this.result()?.decrease ?? 0));

  readonly canImport = computed(
    () => this.step() === 'preview' && !!this.result()?.ok && this.changes() > 0
  );

  private readonly errorsByRow = computed(() => groupByRow(this.result()?.errors ?? []));
  private readonly warningsByRow = computed(() => groupByRow(this.result()?.warnings ?? []));

  readonly filteredRows = computed(() => {
    const rows = this.result()?.rows ?? [];
    const f = this.filter();
    return f === 'all' ? rows : rows.filter((r) => r.action === f);
  });

  readonly shownRows = computed(() => this.filteredRows().slice(0, MAX_SHOWN));
  readonly maxShown = MAX_SHOWN;

  async ngOnInit(): Promise<void> {
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
      const parsed = await parseOpeningFile(f);
      const { result, error } = await importOpening(parsed, true);
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

    const { result, error } = await importOpening(parsed, false);

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

  // ---------- export ----------
  async exportAll(): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(true);
    const err = await exportCurrentStock();
    this.exporting.set(false);
    if (err) this.error.set(err);
  }

  downloadTemplate(): void {
    void downloadOpeningTemplate();
  }

  // ---------- view helpers ----------
  rowErrors(row: OpeningRow): string[] {
    return this.errorsByRow().get(row.row) ?? [];
  }

  rowWarnings(row: OpeningRow): string[] {
    return this.warningsByRow().get(row.row) ?? [];
  }

  diffText(row: OpeningRow): string {
    if (row.diff === null || row.action === 'error') return '—';
    if (row.diff === 0) return '0';
    return row.diff > 0 ? `+${row.diff}` : `${row.diff}`;
  }

  diffTone(row: OpeningRow): string {
    if (row.action === 'increase') return 'text-emerald-700 font-semibold';
    if (row.action === 'decrease') return 'text-orange-700 font-semibold';
    return 'text-slate-400';
  }

  label(action: OpeningRow['action']): string {
    switch (action) {
      case 'increase': return 'Increase';
      case 'decrease': return 'Decrease';
      case 'error': return 'Error';
      default: return 'No change';
    }
  }

  badge(action: OpeningRow['action']): string {
    switch (action) {
      case 'increase': return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
      case 'decrease': return 'bg-orange-50 text-orange-700 ring-orange-200';
      case 'error': return 'bg-red-50 text-red-700 ring-red-200';
      default: return 'bg-slate-50 text-slate-500 ring-slate-200';
    }
  }

  private fail(msg: string): void {
    this.error.set(msg);
    this.step.set('idle');
  }

  private async loadHistory(): Promise<void> {
    this.history.set(await loadOpeningHistory());
  }
}

function groupByRow(items: { row: number; message: string }[]): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const it of items) {
    const list = m.get(it.row) ?? [];
    list.push(it.message);
    m.set(it.row, list);
  }
  return m;
}
