import { supabase } from '../supabase/supabase.client';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------
export type AssignAction = 'add' | 'remove' | 'unchanged' | 'error';

export interface AssignRow {
  row: number;
  location: string | null;
  sku: string | null;
  product: string | null;
  assigned: boolean | null;
  on_hand: number;
  action: AssignAction;
}

export interface AssignIssue {
  row: number;
  field?: string;
  message: string;
}

export interface AssignResult {
  ok: boolean;
  applied: boolean;
  dry_run: boolean;
  total: number;
  add: number;
  remove: number;
  unchanged: number;
  invalid: number;
  errors: AssignIssue[];
  warnings: AssignIssue[];
  rows: AssignRow[];
  batch_id: string | null;
}

export interface ParsedAssignFile {
  fileName: string;
  fileHash: string;
  rows: Record<string, string>[];
}

export interface AssignBatch {
  id: string;
  file_name: string;
  row_count: number;
  inserted_count: number;
  removed_count: number;
  status: 'applied' | 'reverted';
  created_at: string;
}

type Xlsx = typeof import('xlsx');
type Col = 'location' | 'sku' | 'assigned';

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
export const MAX_ASSIGN_ROWS = 20000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const PAGE = 1000;

// "Product" is only there to make the file readable. It is ignored on import.
const HEADERS = ['Location', 'SKU', 'Product', 'Assigned'];

const ALIASES: Record<string, Col> = {
  location: 'location',
  'location name': 'location',
  store: 'location',
  object: 'location',
  sku: 'sku',
  code: 'sku',
  'product code': 'sku',
  assigned: 'assigned',
  assign: 'assigned',
};

// ---------------------------------------------------------------------
// Export + template
// ---------------------------------------------------------------------
export async function exportAssignments(): Promise<string | null> {
  type Raw = {
    objects: { name: string } | null;
    products: { sku: string; name: string } | null;
  };
  const all: string[][] = [];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('object_products')
      .select('id, objects(name), products(sku, name)')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) return friendly(error.message);

    for (const r of (data ?? []) as unknown as Raw[]) {
      if (r.objects && r.products) {
        all.push([r.objects.name, r.products.sku, r.products.name, 'yes']);
      }
    }
    if (!data || data.length < PAGE) break;
  }

  all.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  const XLSX = await import('xlsx');
  downloadSheet(XLSX, all, `stockflow-assignments-${today()}.xlsx`);
  return null;
}

export async function downloadAssignmentTemplate(): Promise<void> {
  const XLSX = await import('xlsx');
  downloadSheet(
    XLSX,
    [
      ['Corner Store', 'SKU-1001', 'Mineral water 0.5 L', 'yes'],
      ['Corner Store 2', 'SKU-1001', 'Mineral water 0.5 L', 'no'],
    ],
    'stockflow-assignments-template.xlsx'
  );
}

function downloadSheet(XLSX: Xlsx, rows: string[][], fileName: string): void {
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows]);
  ws['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 36 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Assignments');
  XLSX.writeFile(wb, fileName);
}

// ---------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------
export async function parseAssignmentFile(file: File): Promise<ParsedAssignFile> {
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
    blankrows: true, // keep blank rows so row numbers match Excel
  });

  // Trailing empty rows are just Excel noise
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
  if (!seen.has('location') || !seen.has('sku')) {
    throw new Error(
      'The first row must contain at least the Location and SKU columns. Download the template to see the format.'
    );
  }

  const body = grid.slice(1);
  if (!body.length) throw new Error('The file has no data rows.');
  if (body.length > MAX_ASSIGN_ROWS) {
    throw new Error(`Max ${MAX_ASSIGN_ROWS} rows per import (file has ${body.length}).`);
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
export async function importAssignments(
  file: ParsedAssignFile,
  dryRun: boolean
): Promise<{ result: AssignResult | null; error: string | null }> {
  const { data, error } = await supabase.rpc('import_object_products', {
    p_file_name: file.fileName,
    p_file_hash: file.fileHash,
    p_rows: file.rows,
    p_dry_run: dryRun,
  });
  if (error) return { result: null, error: friendly(error.message) };
  return { result: data as AssignResult, error: null };
}

export async function loadAssignmentHistory(limit = 8): Promise<AssignBatch[]> {
  const { data } = await supabase
    .from('import_batches')
    .select('id, file_name, row_count, inserted_count, removed_count, status, created_at')
    .eq('kind', 'object_products')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []) as AssignBatch[];
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
  if (msg.includes('Only admin')) return 'Only an admin can import assignments.';
  if (msg.includes('Stock changed')) return 'Stock changed since the preview. Upload the file again.';
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) return 'Network issue - check your connection and try again.';
  return msg;
}
