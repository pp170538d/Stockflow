import { Order } from './order.model';

/**
 * Opens a clean Purchase Order document and launches the browser print dialog.
 * In Chrome/Edge choose "Save as PDF". The document is built only from the
 * immutable approval snapshots, never from current supplier/company master data.
 */
export function printPurchaseOrder(order: Order): string | null {
  if (order.status !== 'APPROVED' && order.status !== 'DELIVERED') {
    return 'The purchase order can be printed after approval.';
  }

  if (
    !order.company_snapshot ||
    !order.supplier_snapshot ||
    !order.delivery_snapshot
  ) {
    return 'This legacy order has no approved document snapshot and cannot be printed as a purchase order.';
  }

  const popup = window.open('', '_blank', 'width=980,height=760');
  if (!popup) {
    return 'The browser blocked the print window. Allow pop-ups for Stockflow and try again.';
  }

  const company = order.company_snapshot;
  const supplier = order.supplier_snapshot;
  const delivery = order.delivery_snapshot;
  const preparedBy = order.prepared_by_snapshot;
  const items = order.order_items ?? [];
  const totalUnits = items.reduce((sum, item) => sum + item.quantity, 0);
  const issuedAt = order.approved_at ?? order.created_at;

  const rows = items.map((item, index) => `
    <tr>
      <td class="num">${index + 1}</td>
      <td class="sku">${esc(item.product?.sku ?? '')}</td>
      <td>${esc(item.product?.name ?? 'Product')}</td>
      <td class="qty">${item.quantity}</td>
    </tr>
  `).join('');

  popup.document.open();
  popup.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${esc(order.order_number)} - Purchase Order</title>
  <style>
    @page { size: A4; margin: 15mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #0f172a;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 11px;
      line-height: 1.45;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .top { display: flex; justify-content: space-between; gap: 30px; padding-bottom: 18px; border-bottom: 2px solid #0f172a; }
    .brand { font-size: 12px; font-weight: 700; letter-spacing: .14em; color: #4f46e5; text-transform: uppercase; }
    h1 { margin: 5px 0 0; font-size: 27px; letter-spacing: -.02em; }
    .doc-meta { min-width: 230px; text-align: right; }
    .number { font-family: "Courier New", monospace; font-size: 15px; font-weight: 700; }
    .status { display: inline-block; margin-top: 7px; padding: 4px 8px; border-radius: 20px; background: #dbeafe; color: #1d4ed8; font-size: 9px; font-weight: 700; letter-spacing: .08em; }
    .parties { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin: 22px 0; }
    .party { min-height: 130px; padding: 13px; border: 1px solid #e2e8f0; border-radius: 9px; }
    .label { margin-bottom: 8px; color: #64748b; font-size: 9px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
    .party-name { margin-bottom: 4px; font-size: 12px; font-weight: 700; }
    .muted { color: #64748b; }
    table { width: 100%; border-collapse: collapse; margin-top: 4px; }
    thead { display: table-header-group; }
    th { padding: 9px 8px; border-bottom: 1px solid #94a3b8; background: #f8fafc; color: #475569; font-size: 9px; letter-spacing: .08em; text-align: left; text-transform: uppercase; }
    td { padding: 10px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
    tr { page-break-inside: avoid; }
    .num { width: 38px; color: #94a3b8; }
    .sku { width: 135px; font-family: "Courier New", monospace; }
    .qty { width: 75px; font-weight: 700; text-align: right; }
    th.qty { text-align: right; }
    .summary { display: flex; justify-content: flex-end; margin-top: 12px; }
    .summary-box { min-width: 230px; padding: 11px 13px; background: #f8fafc; border-radius: 8px; }
    .sum-row { display: flex; justify-content: space-between; gap: 30px; }
    .sum-row + .sum-row { margin-top: 5px; }
    .note { margin-top: 20px; padding: 13px; border-left: 3px solid #4f46e5; background: #f8fafc; }
    .footer { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 28px; padding-top: 14px; border-top: 1px solid #e2e8f0; }
    .generated { margin-top: 24px; color: #94a3b8; font-size: 9px; text-align: center; }
    @media print { .no-print { display: none !important; } }
  </style>
</head>
<body>
  <header class="top">
    <div>
      <div class="brand">Stockflow</div>
      <h1>Purchase Order</h1>
    </div>
    <div class="doc-meta">
      <div class="number">${esc(order.order_number)}</div>
      <div class="muted">Issued ${esc(formatDate(issuedAt))}</div>
      <div class="status">${esc(order.status)}</div>
    </div>
  </header>

  <section class="parties">
    ${partyBlock('From', company, company.email)}
    ${partyBlock('Supplier', supplier, supplier.order_email)}
    ${partyBlock('Deliver to', delivery, null)}
  </section>

  <div class="label">Order items</div>
  <table>
    <thead><tr><th>#</th><th>SKU</th><th>Product</th><th class="qty">Quantity</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="summary">
    <div class="summary-box">
      <div class="sum-row">
  <span>Different products</span>
  <strong>${items.length}</strong>
</div>
<div class="sum-row">
  <span>Total units</span>
  <strong>${totalUnits}</strong>
</div>
    </div>
  </div>

  ${order.comment ? `<section class="note"><div class="label">Order note</div>${esc(order.comment)}</section>` : ''}

  <footer class="footer">
    <div>
      <div class="label">Prepared by</div>
      <strong>${esc(preparedBy?.full_name || preparedBy?.email || 'Stockflow user')}</strong>
      ${preparedBy?.full_name && preparedBy?.email ? `<div class="muted">${esc(preparedBy.email)}</div>` : ''}
    </div>
    <div>
      <div class="label">Approval</div>
      <strong>Approved purchase order</strong>
      <div class="muted">${esc(formatDate(issuedAt))}</div>
    </div>
  </footer>

  <div class="generated">Generated from Stockflow on ${esc(formatDate(new Date().toISOString()))}</div>
  <script>
    window.addEventListener('load', function () {
      setTimeout(function () { window.print(); }, 150);
    });
  </script>
</body>
</html>`);
  popup.document.close();
  return null;
}

function partyBlock(
  label: string,
  party: NonNullable<Order['company_snapshot']>,
  email: string | null | undefined
): string {
  const cityLine = [party.postal_code, party.city].filter(Boolean).join(' ');
  return `<article class="party">
    <div class="label">${esc(label)}</div>
    <div class="party-name">${esc(party.name ?? '')}</div>
    ${line(party.address)}
    ${line(cityLine)}
    ${line(party.country)}
    ${party.tax_id ? `<div class="muted">Tax ID: ${esc(party.tax_id)}</div>` : ''}
    ${party.registration_number ? `<div class="muted">Reg. no: ${esc(party.registration_number)}</div>` : ''}
    ${email ? `<div class="muted">${esc(email)}</div>` : ''}
    ${party.phone ? `<div class="muted">${esc(party.phone)}</div>` : ''}
  </article>`;
}

function line(value: string | null | undefined): string {
  return value ? `<div>${esc(value)}</div>` : '';
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
