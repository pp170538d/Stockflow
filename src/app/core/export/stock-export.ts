import { supabase } from '../supabase/supabase.client';

interface SnapshotRow {
  store: string;
  sku: string | null;
  product: string;
  quantity: number;
  last_movement: string | null;
}

export async function exportStockSnapshot(): Promise<string | null> {
  const { data, error } = await supabase.rpc('stock_snapshot');
  if (error) return error.message;

  // loaded only on click, so it doesn't grow the main bundle
  const XLSX = await import('xlsx');

  const rows = ((data ?? []) as SnapshotRow[]).map(r => ({
    Store: r.store,
    SKU: r.sku ?? '',
    Product: r.product,
    Quantity: r.quantity,                       // stays a real number
    'Last movement': r.last_movement ? new Date(r.last_movement) : '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true });
  ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 32 }, { wch: 10 }, { wch: 18 }];
  ws['!autofilter'] = { ref: ws['!ref']! };     // filter arrows in the header

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock');

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  XLSX.writeFile(wb, `stock-snapshot-${stamp}.xlsx`);

  return null;
}