import { supabase } from '../supabase/supabase.client';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------
export type SalesAction = 'sale' | 'return' | 'error';

export interface SalesRow {
  row: number;
  date: string | null;
  location: string | null;
  sku: string | null;
  product: string | null;
  quantity: number | null;
  unit_price: number | null;
  amount: number | null;
  action: SalesAction;
}

export interface SalesIssue {
  row: number;
  field?: string;
  message: string;
}

export interface SalesResult {
  ok: boolean;
  applied: boolean;
  dry_run: boolean;
  total: number;
  sales: number;
  returns: number;
  invalid: number;
  units_sold: number;
  units_returned: number;
  revenue: number;
  unpriced: number;
  currency: string;
  errors: SalesIssue[];
  warnings: SalesIssue[];
  rows: SalesRow[];
  batch_id: string | null;
  movements: number;
}

export interface ParsedSalesFile {
  fileName: string;
  fileHash: string;
  rows: Record<string, string>[];
}

export interface SalesBatch {
  id: string;
  file_name: string;
  row_count: number;
  inserted_count: number;
  created_at: string;
}

type Xlsx = typeof import('xlsx');
type Col = 'date' | 'location_code' | 'sku_or_barcode' | 'quantity' | 'unit_price';

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
export const MAX_SALES_ROWS = 20000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const HEADERS = ['Date', 'Location code', 'SKU or barcode', 'Quantity', 'Unit price'];

const ALIASES: Record<string, Col> = {
  date: 'date',
  'sale date': 'date',
  datum: 'date',
  'location code': 'location_code',
  location_code: 'location_code',
  location: 'location_code',
  store: 'location_code',
  'store code': 'location_code',
  'sku or barcode': 'sku_or_barcode',
  sku_or_barcode: 'sku_or_barcode',
  sku: 'sku_or_barcode',
  barcode: 'sku_or_barcode',
  ean: 'sku_or_barcode',
  quantity: 'quantity',
  qty: 'quantity',
  kolicina: 'quantity',
  'unit price': 'unit_price',
  unit_price: 'unit_price',
  price: 'unit_price',
  cena: 'unit_price',
};

// ---------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------
export async function downloadSalesTemplate(): Promise<void> {
  const XLSX = await import('xlsx');
  const rows = [
    ['2026-11-18', 'BG-KNEZ', '8600000000011', 3, 120],
    ['2026-11-18', 'BG-KNEZ', 'SKU-1002', -1, 250],
  ];
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows]);
  // Date and barcode stay text: Excel must not turn them into numbers
  for (let r = 1; r <= rows.length; r++) {
    for (const c of [0, 2]) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell) { cell.t = 's'; cell.z = '@'; }
    }
  }
  ws['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 18 }, { wch: 10 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sales');
  XLSX.writeFile(wb, 'stockflow-sales-template.xlsx');
}

// ---------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------
export async function parseSalesFile(file: File): Promise<ParsedSalesFile> {
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
  for (const req of ['date', 'location_code', 'sku_or_barcode', 'quantity'] as Col[]) {
    if (!seen.has(req)) {
      throw new Error(
        'The first row must contain Date, Location code, SKU or barcode and Quantity. Download the template to see the format.'
      );
    }
  }

  const body = grid.slice(1);
  if (!body.length) throw new Error('The file has no data rows.');
  if (body.length > MAX_SALES_ROWS) {
    throw new Error(`Max ${MAX_SALES_ROWS} rows per import (file has ${body.length}).`);
  }

  const rows = body.map((r) => {
    const o: Record<string, string> = {};
    header.forEach((col, i) => {
      if (!col) return;
      o[col] = col === 'date' ? dateText(r[i]) : cellText(r[i]);
    });
    return o;
  });

  return { fileName: file.name, fileHash, rows };
}

// ---------------------------------------------------------------------
// RPC + history
// ---------------------------------------------------------------------
export async function importSales(
  file: ParsedSalesFile,
  dryRun: boolean
): Promise<{ result: SalesResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc('import_sales', {
    p_file_name: file.fileName,
    p_file_hash: file.fileHash,
    p_rows: file.rows,
    p_dry_run: dryRun,
  });
  if (error) return { result: null, error: friendly(error.message) };
  return { result: data as SalesResult, error: null };
}

export async function loadSalesHistory(limit = 8): Promise<SalesBatch[]> {
  const { data } = await supabase
    .from('import_batches')
    .select('id, file_name, row_count, inserted_count, created_at')
    .eq('kind', 'sales')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []) as SalesBatch[];
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

/**
 * Excel stores a date cell as a serial number (46000 = 2025-12-09).
 * Convert it to YYYY-MM-DD; text dates go to the server as they are.
 */
function dateText(v: unknown): string {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  return cellText(v);
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function friendly(msg: string): string {
  if (msg.includes('Demo account') || msg.includes('DEMO_READONLY')) return 'This action is disabled in the demo account.';
  if (msg.includes('already imported')) return 'This file was already imported.';
  if (msg.includes('Not signed in')) return 'Your session expired. Sign in again.';
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) return 'Network issue - check your connection and try again.';
  return msg;
}
