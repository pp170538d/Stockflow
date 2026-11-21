import { Order } from './order.model';

/**
 * Opens a responsive purchase-order preview.
 *
 * The document uses the unit cost frozen on each order item.
 * That means a later change to products.cost_price does not change
 * the financial value of an already-created purchase order.
 *
 * The user explicitly chooses Print / Save PDF from the preview toolbar.
 * Company, supplier and delivery details come from immutable approval snapshots.
 */
export function printPurchaseOrder(order: Order): string | null {
  if (
    order.status !== 'APPROVED' &&
    order.status !== 'DELIVERED'
  ) {
    return 'The purchase order can be printed after approval.';
  }

  if (
    !order.company_snapshot ||
    !order.supplier_snapshot ||
    !order.delivery_snapshot
  ) {
    return 'This legacy order has no approved document snapshot and cannot be printed as a purchase order.';
  }

  const popup = window.open('', '_blank');

  if (!popup) {
    return 'The browser blocked the purchase order preview. Allow pop-ups for Stockflow and try again.';
  }

  const company = order.company_snapshot;
  const supplier = order.supplier_snapshot;
  const delivery = order.delivery_snapshot;
  const preparedBy = order.prepared_by_snapshot;

  const items = order.order_items ?? [];

  const totalUnits = items.reduce(
    (sum, item) => sum + item.quantity,
    0
  );

  const pricedItems = items.filter(
    (item) => item.unit_cost !== null
  );

  const linesWithoutCost =
    items.length - pricedItems.length;

  const totalValue = pricedItems.reduce(
    (sum, item) =>
      sum +
      item.quantity *
        (item.unit_cost ?? 0),
    0
  );

  const currency =
    order.currency ?? 'RSD';

  const issuedAt =
    order.approved_at ??
    order.created_at;

  const rows = items
    .map((item, index) => {
      const unitCost =
        item.unit_cost;

      const lineTotal =
        unitCost === null
          ? null
          : item.quantity * unitCost;

      return `
        <tr>
          <td
            class="num"
            data-label="#"
          >
            ${index + 1}
          </td>

          <td
            class="sku"
            data-label="SKU"
          >
            ${esc(item.product?.sku ?? '')}
          </td>

          <td
            class="product"
            data-label="Product"
          >
            ${esc(
              item.product?.name ??
                'Product'
            )}
          </td>

          <td
            class="qty"
            data-label="Quantity"
          >
            ${item.quantity}
          </td>

          <td
            class="money-cell"
            data-label="Unit cost"
          >
            ${
              unitCost === null
                ? '—'
                : `${money(unitCost)} ${esc(currency)}`
            }
          </td>

          <td
            class="money-cell line-total"
            data-label="Line total"
          >
            ${
              lineTotal === null
                ? '—'
                : `${money(lineTotal)} ${esc(currency)}`
            }
          </td>
        </tr>
      `;
    })
    .join('');

  popup.document.open();

  popup.document.write(`
<!doctype html>
<html lang="en">

<head>

  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1, viewport-fit=cover"
  >

  <meta
    name="theme-color"
    content="#0f172a"
  >

  <title>
    ${esc(order.order_number)} - Purchase Order
  </title>

  <style>

    @page {
      size: A4;
      margin: 15mm;
    }

    * {
      box-sizing: border-box;
    }

    html {
      background: #e2e8f0;
    }

    body {
      margin: 0;

      color: #0f172a;
      background: #e2e8f0;

      font-family:
        Arial,
        Helvetica,
        sans-serif;

      font-size: 11px;
      line-height: 1.45;

      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    button {
      font: inherit;
    }

    /* ===========================
       TOOLBAR
       =========================== */

    .toolbar-shell {
      position: sticky;
      top: 0;
      z-index: 20;

      padding:
        max(10px, env(safe-area-inset-top))
        14px
        10px;

      background:
        rgba(15, 23, 42, .96);

      box-shadow:
        0 6px 18px
        rgba(15, 23, 42, .2);

      backdrop-filter: blur(10px);
    }

    .toolbar {
      display: flex;

      max-width: 210mm;

      margin: 0 auto;

      align-items: center;
      justify-content: space-between;

      gap: 12px;
    }

    .toolbar-copy {
      min-width: 0;
      color: #fff;
    }

    .toolbar-title {
      overflow: hidden;

      font-size: 13px;
      font-weight: 700;

      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .toolbar-subtitle {
      margin-top: 2px;

      color: #94a3b8;

      font-size: 10px;
    }

    .toolbar-actions {
      display: flex;
      flex-shrink: 0;

      gap: 8px;
    }

    .action {
      display: inline-flex;

      min-height: 42px;

      align-items: center;
      justify-content: center;

      gap: 7px;

      border: 0;
      border-radius: 10px;

      padding: 0 14px;

      cursor: pointer;

      font-size: 12px;
      font-weight: 700;
    }

    .action-primary {
      color: #0f172a;
      background: #fff;
    }

    .action-secondary {
      color: #e2e8f0;
      background: transparent;

      box-shadow:
        inset 0 0 0 1px #475569;
    }

    .action:focus-visible {
      outline:
        3px solid
        rgba(129, 140, 248, .55);

      outline-offset: 2px;
    }

    .preview-note {
      display: none;
    }

    /* ===========================
       DOCUMENT
       =========================== */

    .page {
      width: calc(100% - 32px);
      max-width: 210mm;

      min-height: 297mm;

      margin:
        20px auto
        40px;

      padding: 15mm;

      background: #fff;

      box-shadow:
        0 15px 45px
        rgba(15, 23, 42, .16);
    }

    .top {
      display: flex;

      justify-content: space-between;

      gap: 30px;

      padding-bottom: 18px;

      border-bottom:
        2px solid #0f172a;
    }

    .brand {
      color: #4f46e5;

      font-size: 12px;
      font-weight: 700;

      letter-spacing: .14em;
      text-transform: uppercase;
    }

    h1 {
      margin:
        5px 0 0;

      font-size: 27px;

      letter-spacing: -.02em;
    }

    .doc-meta {
      min-width: 230px;

      text-align: right;
    }

    .number {
      font-family:
        "Courier New",
        monospace;

      font-size: 15px;
      font-weight: 700;
    }

    .status {
      display: inline-block;

      margin-top: 7px;

      padding:
        4px 8px;

      border-radius: 20px;

      color: #1d4ed8;
      background: #dbeafe;

      font-size: 9px;
      font-weight: 700;

      letter-spacing: .08em;
    }

    /* ===========================
       PARTIES
       =========================== */

    .parties {
      display: grid;

      grid-template-columns:
        repeat(
          3,
          minmax(0, 1fr)
        );

      gap: 12px;

      margin:
        22px 0;
    }

    .party {
      min-width: 0;
      min-height: 130px;

      padding: 13px;

      overflow-wrap: anywhere;

      border:
        1px solid #e2e8f0;

      border-radius: 9px;
    }

    .label {
      margin-bottom: 8px;

      color: #64748b;

      font-size: 9px;
      font-weight: 700;

      letter-spacing: .1em;
      text-transform: uppercase;
    }

    .party-name {
      margin-bottom: 4px;

      font-size: 12px;
      font-weight: 700;
    }

    .muted {
      color: #64748b;

      overflow-wrap: anywhere;
    }

    /* ===========================
       ITEMS
       =========================== */

    .table-title {
      margin-top: 4px;
    }

    .table-wrap {
      width: 100%;

      overflow-x: auto;

      -webkit-overflow-scrolling:
        touch;
    }

    table {
      width: 100%;

      border-collapse:
        collapse;
    }

    thead {
      display:
        table-header-group;
    }

    th {
      padding:
        9px 8px;

      border-bottom:
        1px solid #94a3b8;

      color: #475569;
      background: #f8fafc;

      font-size: 9px;

      letter-spacing: .08em;

      text-align: left;
      text-transform: uppercase;
    }

    td {
      padding:
        10px 8px;

      border-bottom:
        1px solid #e2e8f0;

      vertical-align: top;
    }

    tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .num {
      width: 32px;

      color: #94a3b8;
    }

    .sku {
      width: 105px;

      font-family:
        "Courier New",
        monospace;
    }

    .product {
      min-width: 120px;
    }

    .qty {
      width: 65px;

      font-weight: 700;

      text-align: right;
    }

    .money-cell {
      width: 105px;

      font-variant-numeric:
        tabular-nums;

      text-align: right;

      white-space: nowrap;
    }

    .line-total {
      font-weight: 700;
    }

    th.qty,
    th.money-cell {
      text-align: right;
    }

    /* ===========================
       SUMMARY
       =========================== */

    .summary {
      display: flex;

      justify-content: flex-end;

      margin-top: 12px;
    }

    .summary-box {
      min-width: 285px;

      padding:
        11px 13px;

      border-radius: 8px;

      background: #f8fafc;
    }

    .sum-row {
      display: flex;

      justify-content: space-between;

      gap: 30px;
    }

    .sum-row + .sum-row {
      margin-top: 5px;
    }

    .sum-row.total {
      margin-top: 9px;

      padding-top: 9px;

      border-top:
        1px solid #cbd5e1;

      font-size: 13px;
    }

    .coverage-note {
      margin-top: 8px;

      color: #b45309;

      font-size: 9px;

      text-align: right;
    }

    /* ===========================
       NOTE / FOOTER
       =========================== */

    .note {
      margin-top: 20px;

      padding: 13px;

      border-left:
        3px solid #4f46e5;

      background: #f8fafc;

      white-space: pre-wrap;

      overflow-wrap: anywhere;
    }

    .footer {
      display: grid;

      grid-template-columns:
        1fr 1fr;

      gap: 20px;

      margin-top: 28px;

      padding-top: 14px;

      border-top:
        1px solid #e2e8f0;
    }

    .generated {
      margin-top: 24px;

      color: #94a3b8;

      font-size: 9px;

      text-align: center;
    }

    /* ===========================
       MOBILE
       =========================== */

    @media screen and (max-width: 640px) {

      html,
      body {
        background: #fff;
      }

      .toolbar-shell {
        padding-right: 12px;
        padding-left: 12px;
      }

      .toolbar {
        align-items: stretch;
        flex-direction: column;
      }

      .toolbar-actions {
        display: grid;

        grid-template-columns:
          1fr 1fr;
      }

      .action {
        width: 100%;
      }

      .preview-note {
        display: block;

        padding:
          10px 14px;

        color: #475569;
        background: #f8fafc;

        font-size: 11px;

        text-align: center;

        border-bottom:
          1px solid #e2e8f0;
      }

      .page {
        width: 100%;
        min-height: 0;

        margin: 0;

        padding:
          18px 16px
          32px;

        box-shadow: none;
      }

      .top {
        align-items: flex-start;
        flex-direction: column;

        gap: 14px;

        padding-bottom: 14px;
      }

      h1 {
        font-size: 25px;
      }

      .doc-meta {
        min-width: 0;
        width: 100%;

        text-align: left;
      }

      .parties {
        grid-template-columns:
          1fr;

        gap: 8px;

        margin:
          16px 0
          20px;
      }

      .party {
        min-height: 0;

        padding: 12px;
      }

      .table-title {
        margin-top: 2px;
      }

      table,
      thead,
      tbody,
      tr,
      th,
      td {
        display: block;
      }

      thead {
        position: absolute;

        width: 1px;
        height: 1px;

        overflow: hidden;

        clip:
          rect(0 0 0 0);

        white-space: nowrap;
      }

      tbody {
        display: grid;

        gap: 8px;
      }

      tr {
        display: grid;

        grid-template-columns:
          minmax(0, 1fr)
          auto;

        gap:
          7px 12px;

        padding: 12px;

        border:
          1px solid #e2e8f0;

        border-radius: 10px;
      }

      td {
        width: auto;

        padding: 0;

        border: 0;
      }

      td::before {
        content:
          attr(data-label);

        display: block;

        margin-bottom: 2px;

        color: #94a3b8;

        font-family:
          Arial,
          Helvetica,
          sans-serif;

        font-size: 8px;
        font-weight: 700;

        letter-spacing: .08em;

        text-transform: uppercase;
      }

      .num {
        display: none;
      }

      .sku {
        grid-column: 1;
        grid-row: 1;
      }

      .product {
        grid-column:
          1 / -1;

        grid-row: 2;

        font-size: 13px;
        font-weight: 700;
      }

      .qty {
        grid-column: 2;
        grid-row: 1;

        min-width: 60px;

        font-size: 15px;

        text-align: right;
      }

      .money-cell {
        width: auto;

        text-align: left;

        white-space: normal;
      }

      .money-cell:nth-of-type(5) {
        grid-column: 1;
        grid-row: 3;
      }

      .money-cell:nth-of-type(6) {
        grid-column: 2;
        grid-row: 3;

        text-align: right;
      }

      .summary {
        justify-content: stretch;
      }

      .summary-box {
        width: 100%;
        min-width: 0;
      }

      .footer {
        grid-template-columns:
          1fr;

        gap: 16px;

        margin-top: 22px;
      }

      .generated {
        margin-top: 20px;
      }
    }

    /* ===========================
       PRINT
       =========================== */

    @media print {

      html,
      body {
        background: #fff;
      }

      body {
        font-size: 10px;
      }

      .no-print {
        display: none !important;
      }

      .toolbar-shell,
      .preview-note {
        display: none !important;
      }

      .page {
        width: auto;

        max-width: none;
        min-height: 0;

        margin: 0;

        padding: 0;

        box-shadow: none;
      }

      .top {
        flex-direction: row;
      }

      * {
        animation: none !important;
        transition: none !important;
      }

      .table-wrap {
        overflow: visible !important;
      }

      .page,
      .top,
      .parties,
      .party,
      .table-wrap,
      table,
      tbody,
      tr,
      td {
        transform: none !important;
      }

      .doc-meta {
        text-align: right;
      }

      .parties {
        display: grid;

        grid-template-columns:
          repeat(
            3,
            minmax(0, 1fr)
          );

        align-items: start;

        gap: 12px;
      }

      .party {
        min-height: 0;
        height: auto;

        align-self: start;
      }

      table {
        display: table;
      }

      thead {
        position: static;

        display:
          table-header-group;

        width: auto;
        height: auto;

        overflow: visible;

        clip: auto;

        white-space: normal;
      }

      tbody {
        display:
          table-row-group;
      }

      tr {
        display:
          table-row;

        padding: 0;

        border: 0;
      }

      th {
        display:
          table-cell;
      }

      td {
        display:
          table-cell;

        padding:
          8px 6px;

        border-bottom:
          1px solid #e2e8f0;
      }

      td::before {
        content:
          none !important;
      }

      .num {
        display:
          table-cell;

        width: 30px;
      }

      .sku {
        width: 95px;
      }

      .product {
        font-size: inherit;
        font-weight: inherit;
      }

      .qty {
        width: 60px;

        font-size: inherit;

        text-align: right;
      }

      .money-cell {
        width: 95px;

        text-align: right;

        white-space: nowrap;
      }

      .summary {
        justify-content: flex-end;
      }

      .summary-box {
        width: auto;

        min-width: 285px;
      }

      .footer {
        grid-template-columns:
          1fr 1fr;
      }
    }

  </style>

</head>

<body>

  <!-- ===========================
       PREVIEW TOOLBAR
       =========================== -->

  <div class="toolbar-shell no-print">

    <div class="toolbar">

      <div class="toolbar-copy">

        <div class="toolbar-title">
          ${esc(order.order_number)}
        </div>

        <div class="toolbar-subtitle">
          Purchase order preview
        </div>

      </div>

      <div class="toolbar-actions">

        <button
          class="action action-secondary"
          type="button"
          onclick="window.close()"
        >
          Close
        </button>

        <button
          class="action action-primary"
          type="button"
          onclick="printDocument()"
        >
          Print / Save PDF
        </button>

      </div>

    </div>

  </div>

  <div class="preview-note no-print">
    Review the purchase order, including quantities and costs, then use Print / Save PDF when ready.
  </div>

  <!-- ===========================
       DOCUMENT
       =========================== -->

  <main class="page">

    <header class="top">

      <div>

        <div class="brand">
          Stockflow
        </div>

        <h1>
          Purchase Order
        </h1>

      </div>

      <div class="doc-meta">

        <div class="number">
          ${esc(order.order_number)}
        </div>

        <div class="muted">
          Issued ${esc(
            formatDate(issuedAt)
          )}
        </div>

        <div class="status">
          ${esc(order.status)}
        </div>

      </div>

    </header>

    <!-- PARTIES -->

    <section class="parties">

      ${
        partyBlock(
          'From',
          company,
          company.email
        )
      }

      ${
        partyBlock(
          'Supplier',
          supplier,
          supplier.order_email
        )
      }

      ${
        partyBlock(
          'Deliver to',
          delivery,
          null
        )
      }

    </section>

    <!-- ORDER ITEMS -->

    <div class="label table-title">
      Order items
    </div>

    <div class="table-wrap">

      <table>

        <thead>

          <tr>

            <th>#</th>

            <th>SKU</th>

            <th>Product</th>

            <th class="qty">
              Qty
            </th>

            <th class="money-cell">
              Unit cost
            </th>

            <th class="money-cell">
              Line total
            </th>

          </tr>

        </thead>

        <tbody>
          ${rows}
        </tbody>

      </table>

    </div>

    <!-- SUMMARY -->

    <div class="summary">

      <div class="summary-box">

        <div class="sum-row">

          <span>
            Different products
          </span>

          <strong>
            ${items.length}
          </strong>

        </div>

        <div class="sum-row">

          <span>
            Total units
          </span>

          <strong>
            ${totalUnits}
          </strong>

        </div>

        <div class="sum-row total">

          <span>
            Total value
          </span>

          <strong>
            ${money(totalValue)}
            ${esc(currency)}
          </strong>

        </div>

        ${
          linesWithoutCost > 0
            ? `
              <div class="coverage-note">
                ${linesWithoutCost}
                ${
                  linesWithoutCost === 1
                    ? 'line has'
                    : 'lines have'
                }
                no unit cost and
                ${
                  linesWithoutCost === 1
                    ? 'is'
                    : 'are'
                }
                excluded from total value.
              </div>
            `
            : ''
        }

      </div>

    </div>

    ${
      order.comment
        ? `
          <section class="note">

            <div class="label">
              Order note
            </div>

            ${esc(order.comment)}

          </section>
        `
        : ''
    }

    <!-- FOOTER -->

    <footer class="footer">

      <div>

        <div class="label">
          Prepared by
        </div>

        <strong>
          ${esc(
            preparedBy?.full_name ||
              preparedBy?.email ||
              'Stockflow user'
          )}
        </strong>

        ${
          preparedBy?.full_name &&
          preparedBy?.email
            ? `
              <div class="muted">
                ${esc(
                  preparedBy.email
                )}
              </div>
            `
            : ''
        }

      </div>

      <div>

        <div class="label">
          Approval
        </div>

        <strong>
          Approved purchase order
        </strong>

        <div class="muted">
          ${esc(
            formatDate(issuedAt)
          )}
        </div>

      </div>

    </footer>

    <div class="generated">
      Values in ${esc(currency)} at frozen purchase-order unit cost
      · Generated from Stockflow on
      ${esc(
        formatDate(
          new Date().toISOString()
        )
      )}
    </div>

  </main>

  <script>

    async function printDocument() {

      document.documentElement
        .classList
        .add(
          'preparing-print'
        );

      if (
        document.fonts &&
        document.fonts.ready
      ) {

        try {
          await document.fonts.ready;
        } catch (_) {}

      }

      void document.body.offsetHeight;

      requestAnimationFrame(
        function () {

          requestAnimationFrame(
            function () {
              window.print();
            }
          );

        }
      );

    }

    window.addEventListener(
      'afterprint',
      function () {

        document.documentElement
          .classList
          .remove(
            'preparing-print'
          );

      }
    );

  </script>

</body>

</html>
  `);

  popup.document.close();

  popup.focus();

  return null;
}

function partyBlock(
  label: string,
  party: NonNullable<
    Order['company_snapshot']
  >,
  email: string | null | undefined
): string {
  const cityLine = [
    party.postal_code,
    party.city,
  ]
    .filter(Boolean)
    .join(' ');

  return `
    <article class="party">

      <div class="label">
        ${esc(label)}
      </div>

      <div class="party-name">
        ${esc(
          party.name ?? ''
        )}
      </div>

      ${line(party.address)}

      ${line(cityLine)}

      ${line(party.country)}

      ${
        party.tax_id
          ? `
            <div class="muted">
              Tax ID:
              ${esc(
                party.tax_id
              )}
            </div>
          `
          : ''
      }

      ${
        party.registration_number
          ? `
            <div class="muted">
              Reg. no:
              ${esc(
                party.registration_number
              )}
            </div>
          `
          : ''
      }

      ${
        email
          ? `
            <div class="muted">
              ${esc(email)}
            </div>
          `
          : ''
      }

      ${
        party.phone
          ? `
            <div class="muted">
              ${esc(
                party.phone
              )}
            </div>
          `
          : ''
      }

    </article>
  `;
}

function line(
  value:
    | string
    | null
    | undefined
): string {
  return value
    ? `
      <div>
        ${esc(value)}
      </div>
    `
    : '';
}

function money(
  value:
    | number
    | null
    | undefined
): string {
  if (
    value === null ||
    value === undefined
  ) {
    return '—';
  }

  return new Intl
    .NumberFormat(
      'en-GB',
      {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }
    )
    .format(value);
}

function esc(
  value: unknown
): string {
  return String(
    value ?? ''
  )
    .replace(
      /&/g,
      '&amp;'
    )
    .replace(
      /</g,
      '&lt;'
    )
    .replace(
      />/g,
      '&gt;'
    )
    .replace(
      /"/g,
      '&quot;'
    )
    .replace(
      /'/g,
      '&#039;'
    );
}

function formatDate(
  iso: string
): string {
  return new Intl
    .DateTimeFormat(
      'en-GB',
      {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }
    )
    .format(
      new Date(iso)
    );
}