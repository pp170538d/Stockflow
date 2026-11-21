import { GoodsReceipt, ReceiptLine, ReceiptParty, Resolution } from './delivery.model';
import { reasonLabel } from '../../core/stock/reason-codes';

const RESOLUTION: Record<Resolution, string> = {
  BACKORDER: 'Backordered',
  CLOSE_SHORT: 'Closed short',
  CLAIM: 'Claim',
  ACCEPT: 'Accepted',
  RETURN_TO_SUPPLIER: 'Returned to supplier',
};

/**
 * Opens a printable goods receipt (GRN). The user picks Print / Save PDF
 * from the preview toolbar, same pattern as the purchase order.
 */
export function printGoodsReceipt(r: GoodsReceipt): string | null {
  const popup = window.open('', '_blank');
  if (!popup) {
    return 'The browser blocked the receipt preview. Allow pop-ups for Stockflow and try again.';
  }

  const cur = r.currency;
  const lines = r.lines;
  const sum = (f: (l: ReceiptLine) => number | null) => lines.reduce((s, l) => s + (f(l) ?? 0), 0);
  const orderedUnits = sum((l) => l.ordered_qty);
  const receivedUnits = sum((l) => l.received_qty);
  const orderedValue = sum((l) => l.ordered_value);
  const receivedValue = sum((l) => l.received_value);
  const diffValue = receivedValue - orderedValue;
  const differences = lines.filter((l) => l.variance !== 0);
  const open = differences.filter((l) => l.resolution_status === 'open').length;
  const title = r.delivery.delivery_number ?? 'Goods receipt';

  const rows = lines
    .map((l, i) => `
      <tr class="${l.variance < 0 ? 'short' : l.variance > 0 ? 'over' : ''}">
        <td class="c">${i + 1}</td>
        <td class="mono">${esc(l.sku)}</td>
        <td>${esc(l.product_name)}</td>
        <td class="r">${l.ordered_qty}</td>
        <td class="r b">${l.received_qty}</td>
        <td class="r b">${l.variance === 0 ? '—' : signed(l.variance)}</td>
        <td class="r">${money(l.unit_cost)}</td>
        <td class="r">${money(l.received_value)}</td>
      </tr>`)
    .join('');

  const diffRows = differences
    .map((l) => `
      <tr>
        <td>${esc(l.product_name)}<div class="muted mono">${esc(l.sku)}</div></td>
        <td class="r b">${signed(l.variance)}</td>
        <td class="r">${money(l.variance_value)}</td>
        <td>${esc(reasonLabel(l.reason_code))}${l.reason && l.reason !== reasonLabel(l.reason_code) ? `<div class="muted">${esc(l.reason)}</div>` : ''}</td>
        <td>${l.resolution_status === 'open'
          ? '<span class="tag open">Open</span>'
          : `<span class="tag done">${esc(l.resolution ? RESOLUTION[l.resolution] : 'Resolved')}</span>${l.backorder_number ? `<div class="muted">${esc(l.backorder_number)}</div>` : ''}${l.resolution_note ? `<div class="muted">${esc(l.resolution_note)}</div>` : ''}`}
        </td>
      </tr>`)
    .join('');

  popup.document.open();
  popup.document.write(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Goods Receipt</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #e2e8f0; color: #0f172a; font: 11px/1.45 Arial, Helvetica, sans-serif;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bar { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center; gap: 12px;
         padding: 10px 16px; background: #0f172a; color: #fff; }
  .bar b { font-family: monospace; font-size: 13px; }
  .bar button { border: 0; border-radius: 8px; padding: 8px 14px; font: 600 12px Arial; cursor: pointer; }
  .p { background: #4f46e5; color: #fff; } .s { background: #fff; color: #0f172a; }
  .page { max-width: 820px; margin: 18px auto; padding: 32px; background: #fff; box-shadow: 0 10px 30px rgba(15,23,42,.12); }
  .top { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #0f172a; padding-bottom: 14px; }
  .brand { color: #4f46e5; font-weight: 700; font-size: 13px; }
  h1 { margin: 2px 0 0; font-size: 22px; }
  .meta { text-align: right; }
  .num { font-family: monospace; font-size: 15px; font-weight: 700; }
  .muted { color: #64748b; font-size: 10px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 16px 0; }
  .box { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; }
  .lbl { color: #64748b; font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; margin-bottom: 4px; }
  .strong { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: #64748b;
       border-bottom: 1px solid #cbd5e1; padding: 6px; }
  td { padding: 6px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .r { text-align: right; } .c { text-align: center; color: #94a3b8; } .b { font-weight: 700; }
  .mono { font-family: monospace; font-size: 10px; }
  tr.short td { background: #fffbeb; } tr.over td { background: #eff6ff; }
  .sum { display: flex; justify-content: flex-end; margin-top: 12px; }
  .sum div.box { min-width: 260px; }
  .row { display: flex; justify-content: space-between; padding: 2px 0; }
  .tag { display: inline-block; border-radius: 999px; padding: 1px 7px; font-size: 9px; font-weight: 700; }
  .open { background: #fef3c7; color: #92400e; } .done { background: #dcfce7; color: #166534; }
  h2 { font-size: 12px; margin: 22px 0 4px; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 34px; }
  .line { border-top: 1px solid #0f172a; padding-top: 4px; margin-top: 30px; }
  @media print { body { background: #fff; } .bar { display: none; } .page { margin: 0; padding: 0; box-shadow: none; max-width: none; } }
</style></head>
<body>
  <div class="bar"><div><b>${esc(title)}</b> <span style="opacity:.7">Goods receipt preview</span></div>
    <div><button class="s" onclick="window.close()">Close</button> <button class="p" onclick="window.print()">Print / Save PDF</button></div></div>
  <main class="page">
    <header class="top">
      <div><div class="brand">Stockflow</div><h1>Goods Receipt</h1></div>
      <div class="meta">
        <div class="num">${esc(title)}</div>
        <div class="muted">Received ${esc(date(r.delivery.delivered_at))}</div>
        <div class="muted">Purchase order <b>${esc(r.order.order_number)}</b></div>
        <div style="margin-top:4px">${open ? `<span class="tag open">${open} open</span>` : '<span class="tag done">Closed</span>'}</div>
      </div>
    </header>

    <section class="grid">
      ${party('Supplier', r.order.supplier)}
      ${party('Received at', r.order.deliver_to, r.object_name)}
      <div class="box">
        <div class="lbl">Receipt</div>
        <div><span class="muted">Received by</span><div class="strong">${esc(r.delivery.received_by || '—')}</div></div>
        <div style="margin-top:4px"><span class="muted">Carrier</span><div>${esc(r.delivery.carrier || '—')}</div></div>
      </div>
    </section>

    <div class="lbl">Received items</div>
    <table>
      <thead><tr><th>#</th><th>SKU</th><th>Product</th><th class="r">Ordered</th><th class="r">Received</th>
        <th class="r">Diff</th><th class="r">Unit cost</th><th class="r">Value</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="sum"><div class="box">
      <div class="row"><span>Lines</span><b>${lines.length}</b></div>
      <div class="row"><span>Units ordered / received</span><b>${orderedUnits} / ${receivedUnits}</b></div>
      <div class="row"><span>Ordered value</span><b>${money(orderedValue)} ${esc(cur)}</b></div>
      <div class="row"><span>Received value</span><b>${money(receivedValue)} ${esc(cur)}</b></div>
      <div class="row"><span>Difference</span><b>${diffValue > 0 ? '+' : ''}${money(diffValue)} ${esc(cur)}</b></div>
    </div></div>

    ${differences.length ? `
      <h2>Differences</h2>
      <table>
        <thead><tr><th>Product</th><th class="r">Diff</th><th class="r">Value</th><th>Reason</th><th>Decision</th></tr></thead>
        <tbody>${diffRows}</tbody>
      </table>` : '<p class="muted" style="margin-top:16px">Received exactly as ordered — no differences.</p>'}

    ${r.delivery.note ? `<h2>Delivery note</h2><div>${esc(r.delivery.note)}</div>` : ''}

    <section class="sign">
      <div><div class="line">Received by (signature)</div></div>
      <div><div class="line">Delivered by / carrier (signature)</div></div>
    </section>

    <p class="muted" style="margin-top:20px">Values in ${esc(cur)} at purchase-order unit cost. Generated from Stockflow on ${esc(date(new Date().toISOString()))}.</p>
  </main>
</body></html>`);
  popup.document.close();
  popup.focus();
  return null;
}

function party(label: string, p: ReceiptParty | null, fallbackName?: string): string {
  const name = p?.name || fallbackName || '—';
  const city = [p?.postal_code, p?.city].filter(Boolean).join(' ');
  return `<div class="box"><div class="lbl">${esc(label)}</div><div class="strong">${esc(name)}</div>
    ${p?.address ? `<div>${esc(p.address)}</div>` : ''}${city ? `<div>${esc(city)}</div>` : ''}
    ${p?.tax_id ? `<div class="muted">Tax ID: ${esc(p.tax_id)}</div>` : ''}</div>`;
}

function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function date(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
