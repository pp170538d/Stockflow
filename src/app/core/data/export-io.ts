import { supabase } from '../supabase/supabase.client';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------
export type MovementEvent =
  | 'DELIVERY' | 'SALE' | 'STOCK_COUNT' | 'ADJUSTMENT' | 'TRANSFER' | 'RETURN' | 'WRITE_OFF';

export const EVENT_LABELS: Record<MovementEvent, string> = {
  DELIVERY: 'Delivery',
  SALE: 'Sale',
  STOCK_COUNT: 'Stock count',
  ADJUSTMENT: 'Adjustment',
  TRANSFER: 'Transfer',
  RETURN: 'Return',
  WRITE_OFF: 'Write-off',
};

export type PeriodKey = 'today' | '7d' | 'month' | 'last-month' | 'custom';

export interface ExportFilter {
  from: Date;
  to: Date;               // exclusive
  objectId?: string | null;
  objectName?: string | null; // only for the file name
  events?: MovementEvent[] | null;
}

interface MovementRow {
  created_at: string;
  location: string;
  sku: string;
  product: string;
  event: MovementEvent;
  quantity: number;
  reference: string | null;
  note: string | null;
  user_name: string | null;
}

type Xlsx = typeof import('xlsx');

const PAGE = 1000;
const MAX_ROWS = 200_000;

// ---------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------
export function periodRange(key: Exclude<PeriodKey, 'custom'>): { from: Date; to: Date } {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(startOfDay);
  tomorrow.setDate(tomorrow.getDate() + 1);

  switch (key) {
    case 'today':
      return { from: startOfDay, to: tomorrow };
    case '7d': {
      const from = new Date(startOfDay);
      from.setDate(from.getDate() - 6);
      return { from, to: tomorrow };
    }
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: tomorrow };
    case 'last-month':
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        to: new Date(now.getFullYear(), now.getMonth(), 1),
      };
  }
}

/** 'yyyy-mm-dd' inputs → [from, to) in local time. `to` is inclusive for the user. */
export function customRange(fromStr: string, toStr: string): { from: Date; to: Date } | null {
  if (!fromStr || !toStr) return null;
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  const from = new Date(fy, fm - 1, fd);
  const to = new Date(ty, tm - 1, td + 1);
  return to > from ? { from, to } : null;
}

// ---------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------

/** Sales for a period: sheet 1 = every sale, sheet 2 = totals per location + product. */
export async function exportSales(f: ExportFilter): Promise<string | null> {
  const { rows, error } = await fetchMovements({ ...f, events: ['SALE'] });
  if (error) return error;
  if (!rows.length) return 'No sales in this period.';

  const XLSX = await import('xlsx');

  // Sales are stored as negative movements → show as positive units
  const detail = rows.map((r) => [
    fmtDate(r.created_at), r.location, r.sku, r.product, -r.quantity, r.user_name ?? '', r.note ?? '',
  ]);

  const totals = new Map<string, { location: string; sku: string; product: string; units: number; lines: number }>();
  for (const r of rows) {
    const key = `${r.location}|${r.sku}`;
    const t = totals.get(key) ?? { location: r.location, sku: r.sku, product: r.product, units: 0, lines: 0 };
    t.units += -r.quantity;
    t.lines += 1;
    totals.set(key, t);
  }
  const summary = [...totals.values()]
    .sort((a, b) => a.location.localeCompare(b.location) || b.units - a.units)
    .map((t) => [t.location, t.sku, t.product, t.units, t.lines]);

  const wb = XLSX.utils.book_new();
  addSheet(XLSX, wb, 'Summary',
    ['Location', 'SKU', 'Product', 'Units sold', 'Sales lines'], summary,
    [24, 16, 36, 12, 12]);
  addSheet(XLSX, wb, 'Sales',
    ['Date', 'Location', 'SKU', 'Product', 'Units', 'Sold by', 'Note'], detail,
    [18, 24, 16, 36, 8, 22, 30]);

  XLSX.writeFile(wb, fileName('sales', f));
  return null;
}

/** Full ledger for a period (optionally only some events). */
export async function exportMovements(f: ExportFilter): Promise<string | null> {
  const { rows, error } = await fetchMovements(f);
  if (error) return error;
  if (!rows.length) return 'No movements in this period.';

  const XLSX = await import('xlsx');
  const data = rows.map((r) => [
    fmtDate(r.created_at),
    r.location,
    r.sku,
    r.product,
    EVENT_LABELS[r.event] ?? r.event,
    r.quantity,
    r.reference ?? '',
    r.note ?? '',
    r.user_name ?? '',
  ]);

  const wb = XLSX.utils.book_new();
  addSheet(XLSX, wb, 'Movements',
    ['Date', 'Location', 'SKU', 'Product', 'Event', 'Qty', 'Reference', 'Note', 'User'], data,
    [18, 24, 16, 36, 14, 8, 28, 32, 22]);

  XLSX.writeFile(wb, fileName('movements', f));
  return null;
}

// ---------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------
async function fetchMovements(f: ExportFilter): Promise<{ rows: MovementRow[]; error: string | null }> {
  const rows: MovementRow[] = [];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .rpc('export_movements', {
        p_from: f.from.toISOString(),
        p_to: f.to.toISOString(),
        p_object_id: f.objectId ?? null,
        p_events: f.events?.length ? f.events : null,
      })
      .range(from, from + PAGE - 1);

    if (error) return { rows: [], error: friendly(error.message) };
    rows.push(...((data ?? []) as MovementRow[]));
    if (!data || data.length < PAGE) break;
    if (rows.length >= MAX_ROWS) {
      return { rows: [], error: `More than ${MAX_ROWS.toLocaleString()} rows. Choose a shorter period or one location.` };
    }
  }
  return { rows, error: null };
}

function addSheet(
  XLSX: Xlsx, wb: import('xlsx').WorkBook, name: string,
  headers: string[], rows: (string | number)[][], widths: number[]
): void {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = widths.map((wch) => ({ wch }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws, name);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fileName(kind: string, f: ExportFilter): string {
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const lastDay = new Date(f.to.getTime() - 1);
  const loc = f.objectName ? '-' + f.objectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
  return `stockflow-${kind}${loc}-${day(f.from)}_${day(lastDay)}.xlsx`;
}

function friendly(msg: string): string {
  if (msg.includes('Max period')) return 'Choose a period of one year or less.';
  if (msg.includes('Invalid period')) return 'The end date must be after the start date.';
  if (msg.includes('No location assigned')) return 'Your account has no location assigned.';
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) return 'Network issue - check your connection and try again.';
  return msg;
}
