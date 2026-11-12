import { supabase } from '../supabase/supabase.client';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------
export type ProductColumn = 'sku' | 'name' | 'category' | 'barcode' | 'active';
export type ImportAction = 'new' | 'update' | 'unchanged' | 'error';

export interface ProductSnapshot {
  name: string;
  category: string | null;
  barcode: string | null;
  active: boolean;
}

export interface ImportRow extends ProductSnapshot {
  row: number;
  sku: string | null;
  action: ImportAction;
  before: ProductSnapshot | null;
}

export interface ImportError {
  row: number;
  field: string;
  message: string;
}

export interface ImportResult {
  ok: boolean;
  applied: boolean;
  dry_run: boolean;
  total: number;
  new: number;
  updated: number;
  unchanged: number;
  invalid: number;
  errors: ImportError[];
  rows: ImportRow[];
  batch_id: string | null;
}

export interface ParsedFile {
  fileName: string;
  fileHash: string;
  /** Columns that exist in the file. Missing columns are left untouched in the DB. */
  columns: ProductColumn[];
  rows: Record<string, string>[];
}

export interface ImportBatch {
  id: string;
  file_name: string;
  row_count: number;
  inserted_count: number;
  updated_count: number;
  unchanged_count: number;
  status: 'applied' | 'reverted';
  created_at: string;
}

type Xlsx = typeof import('xlsx');

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
export const MAX_IMPORT_ROWS = 5000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const PAGE = 1000; // Supabase returns max 1000 rows per request

const HEADERS = ['SKU', 'Name', 'Category', 'Barcode', 'Active'];
const BARCODE_COL = 3;

const ALIASES: Record<string, ProductColumn> = {
  sku: 'sku',
  code: 'sku',
  'product code': 'sku',
  name: 'name',
  product: 'name',
  'product name': 'name',
  category: 'category',
  barcode: 'barcode',
  ean: 'barcode',
  gtin: 'barcode',
  active: 'active',
};

// ---------------------------------------------------------------------
// Export + template
// ---------------------------------------------------------------------
export async function exportProducts(): Promise<string | null> {
  const all: { sku: string; name: string; category: string | null; barcode: string | null; active: boolean }[] = [];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('products')
      .select('sku, name, category, barcode, active')
      .order('sku')
      .range(from, from + PAGE - 1);
    if (error) return friendly(error.message);
    all.push(...((data ?? []) as typeof all));
    if (!data || data.length < PAGE) break;
  }

  const XLSX = await import('xlsx');
  const rows = all.map((p) => [
    p.sku,
    p.name,
    p.category ?? '',
    p.barcode ?? '',
    p.active ? 'yes' : 'no',
  ]);
  downloadSheet(XLSX, rows, `stockflow-products-${today()}.xlsx`);
  return null;
}

export async function downloadProductTemplate(): Promise<void> {
  const XLSX = await import('xlsx');
  downloadSheet(
    XLSX,
    [['SKU-1001', 'Mineral water 0.5 L', 'Drinks', '8600000000011', 'yes']],
    'stockflow-products-template.xlsx'
  );
}

function downloadSheet(XLSX: Xlsx, rows: string[][], fileName: string): void {
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows]);

  // Barcode stays text, so Excel doesn't turn it into 8.6E+12 or drop leading zeros
  for (let r = 1; r <= rows.length; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: BARCODE_COL })];
    if (cell) {
      cell.t = 's';
      cell.z = '@';
    }
  }
  ws['!cols'] = [{ wch: 16 }, { wch: 36 }, { wch: 18 }, { wch: 16 }, { wch: 8 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Products');
  XLSX.writeFile(wb, fileName);
}

// ---------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------
export async function parseProductFile(file: File): Promise<ParsedFile> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!['xlsx', 'xls', 'csv'].includes(ext)) {
    throw new Error('Use an .xlsx, .xls or .csv file.');
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('File is larger than 5 MB.');
  }

  const buffer = await file.arrayBuffer();
  const [XLSX, fileHash] = await Promise.all([import('xlsx'), sha256(buffer)]);

  // CSV: raw = keep every value as text (leading zeros in barcodes survive)
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
    blankrows: true, // keep blank rows so row numbers match Excel
  });

  // Trailing empty rows are just Excel noise
  while (grid.length > 1 && grid[grid.length - 1].every((c) => cellText(c) === '')) {
    grid.pop();
  }

  const header = (grid[0] ?? []).map((h) => ALIASES[cellText(h).toLowerCase()] ?? null);

  const seen = new Set<ProductColumn>();
  for (const col of header) {
    if (!col) continue;
    if (seen.has(col)) throw new Error(`Column "${col}" appears more than once in the header.`);
    seen.add(col);
  }
  if (!seen.has('sku') || !seen.has('name')) {
    throw new Error('The first row must contain at least the SKU and Name columns. Download the template to see the format.');
  }

  const body = grid.slice(1);
  if (!body.length) throw new Error('The file has no data rows.');
  if (body.length > MAX_IMPORT_ROWS) {
    throw new Error(`Max ${MAX_IMPORT_ROWS} rows per import (file has ${body.length}).`);
  }

  // Every column from the header is sent in every row, even when the cell is empty:
  // empty cell = clear the value, missing column = keep the value.
  const rows = body.map((r) => {
    const o: Record<string, string> = {};
    header.forEach((col, i) => {
      if (col) o[col] = cellText(r[i]);
    });
    return o;
  });

  return { fileName: file.name, fileHash, columns: [...seen], rows };
}

// ---------------------------------------------------------------------
// RPC + history
// ---------------------------------------------------------------------
export async function importProducts(
  file: ParsedFile,
  dryRun: boolean
): Promise<{ result: ImportResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc('import_products', {
    p_file_name: file.fileName,
    p_file_hash: file.fileHash,
    p_rows: file.rows,
    p_dry_run: dryRun,
  });
  if (error) return { result: null, error: friendly(error.message) };
  return { result: data as ImportResult, error: null };
}

export async function loadImportHistory(limit = 8): Promise<ImportBatch[]> {
  const { data } = await supabase
    .from('import_batches')
    .select('id, file_name, row_count, inserted_count, updated_count, unchanged_count, status, created_at')
    .eq('kind', 'products')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []) as ImportBatch[];
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
  if (msg.includes('Only admin')) return 'Only an admin can import products.';
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) return 'Network issue - check your connection and try again.';
  return msg;
}