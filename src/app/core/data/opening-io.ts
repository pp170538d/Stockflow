import { supabase } from '../supabase/supabase.client';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------
export type OpeningAction = 'increase' | 'decrease' | 'unchanged' | 'error';

export interface OpeningRow {
  row: number;
  location: string | null;
  sku: string | null;
  product: string | null;
  on_hand: number;
  quantity: number | null;
  diff: number | null;
  action: OpeningAction;
}

export interface OpeningIssue {
  row: number;
  field?: string;
  message: string;
}

export interface OpeningResult {
  ok: boolean;
  applied: boolean;
  dry_run: boolean;
  total: number;
  increase: number;
  decrease: number;
  unchanged: number;
  invalid: number;
  units_in: number;
  units_out: number;
  errors: OpeningIssue[];
  warnings: OpeningIssue[];
  rows: OpeningRow[];
  batch_id: string | null;
  counts: number;
}

export interface ParsedOpeningFile {
  fileName: string;
  fileHash: string;
  rows: Record<string, string>[];
}

export interface OpeningBatch {
  id: string;
  file_name: string;
  row_count: number;
  updated_count: number;
  count_ids: string[];
  created_at: string;
}

type Xlsx = typeof import('xlsx');
type Col = 'location' | 'sku' | 'quantity';

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
export const MAX_OPENING_ROWS = 20000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// "Product" is only there to make the file readable. It is ignored on import.
const HEADERS = ['Location', 'SKU', 'Product', 'Quantity'];

const ALIASES: Record<string, Col> = {
  location: 'location',
  'location name': 'location',
  store: 'location',
  object: 'location',
  sku: 'sku',
  code: 'sku',
  'product code': 'sku',
  quantity: 'quantity',
  qty: 'quantity',
  stock: 'quantity',
  'on hand': 'quantity',
  counted: 'quantity',
};

// ---------------------------------------------------------------------
// Export current stock (same format, so: export → edit → import)
// ---------------------------------------------------------------------
export async function exportCurrentStock(): Promise<string | null> {
  const { data, error } = await supabase.rpc('stock_snapshot');
  if (error) return friendly(error.message);

  type Snap = { store: string; sku: string; product: string; quantity: number };
  const rows = ((data ?? []) as Snap[])
    .map((r) => [r.store, r.sku, r.product, r.quantity] as (string | number)[])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));

  const XLSX = await import('xlsx');
  downloadSheet(XLSX, rows, `stockflow-stock-${today()}.xlsx`);
  return null;
}

export async function downloadOpeningTemplate(): Promise<void> {
  const XLSX = await import('xlsx');
  downloadSheet(
    XLSX,
    [
      ['Corner Store', 'SKU-1001', 'Mineral water 0.5 L', 24],
      ['Corner Store 2', 'SKU-1001', 'Mineral water 0.5 L', 12],
    ],
    'stockflow-opening-balance-template.xlsx'
  );
}

function downloadSheet(XLSX: Xlsx, rows: (string | number)[][], fileName: string): void {
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows]);
  ws['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 36 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock');
  XLSX.writeFile(wb, fileName);
}

// ---------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------
export async function parseOpeningFile(file: File): Promise<ParsedOpeningFile> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!['xlsx', 'xls', 'csv'].includes(ext)) {
    throw new Error('Use an .xlsx, .xls or .csv file.');
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('File is larger than 5 MB.');
  }

  const buffer = await file.arrayBuffer();
  const [XLSX, fileHash] = await Promise.all([import('xlsx'), sha256(buffer)]);

  const wb =
    ext === 'csv'
      ? XLSX.read(new TextDecoder('utf-8').decode(buffer), { type: 'string', raw: true })
      : XLSX.read(buffer, { type: 'array' });

  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no sheets.');

  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: true,
  });

  while (grid.length > 1 && grid[grid.length - 1].every((c) => cellText(c) === '')) {
    grid.pop();
  }

  const header = (grid[0] ?? []).map((h) => ALIASES[cellText(h).toLowerCase()] ?? null);

  const seen = new Set<Col>();
  for (const col of header) {
    if (!col) continue;
    if (seen.has(col)) throw new Error(`Column "${col}" appears more than once in the header.`);
    seen.add(col);
  }
  if (!seen.has('location') || !seen.has('sku') || !seen.has('quantity')) {
    throw new Error(
      'The first row must contain the Location, SKU and Quantity columns. Download the template to see the format.'
    );
  }

  const body = grid.slice(1);
  if (!body.length) throw new Error('The file has no data rows.');
  if (body.length > MAX_OPENING_ROWS) {
    throw new Error(`Max ${MAX_OPENING_ROWS} rows per import (file has ${body.length}).`);
  }

  const rows = body.map((r) => {
    const o: Record<string, string> = {};
    header.forEach((col, i) => {
      if (col) o[col] = cellText(r[i]);
    });
    return o;
  });

  return { fileName: file.name, fileHash, rows };
}

// ---------------------------------------------------------------------
// RPC + history
// ---------------------------------------------------------------------
export async function importOpening(
  file: ParsedOpeningFile,
  dryRun: boolean
): Promise<{ result: OpeningResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc('import_opening_balance', {
    p_file_name: file.fileName,
    p_file_hash: file.fileHash,
    p_rows: file.rows,
    p_dry_run: dryRun,
  });
  if (error) return { result: null, error: friendly(error.message) };
  return { result: data as OpeningResult, error: null };
}

export async function loadOpeningHistory(limit = 8): Promise<OpeningBatch[]> {
  const { data } = await supabase
    .from('import_batches')
    .select('id, file_name, row_count, updated_count, count_ids, created_at')
    .eq('kind', 'opening_balance')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []) as OpeningBatch[];
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function friendly(msg: string): string {
  if (msg.includes('Demo account') || msg.includes('DEMO_READONLY')) return 'This action is disabled in the demo account.';
  if (msg.includes('Only admin')) return 'Only an admin can import stock.';
  if (msg.includes('Nothing to import')) return 'Stock already matches the file. There is nothing to import.';
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) return 'Network issue - check your connection and try again.';
  return msg;
}
