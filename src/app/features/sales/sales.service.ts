import { Injectable, computed, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { IdempotencyKey } from '../../core/idempotency';

export interface SaleRow {
  id: string;
  objectId: string;
  objectName: string;
  productId: string;
  name: string;
  sku: string;
  units: number;
  note: string | null;
  createdAt: string;
  /** "sale:<uuid>" when the line belongs to a multi-product sale. */
  reference: string | null;
  /** What the customer paid for this line, incl. VAT (null = no price recorded). */
  amount: number | null;
}

/** Lightweight sale line used for the chart, top products and KPIs. */
export interface SaleInsight {
  id: string;
  productId: string;
  name: string;
  sku: string;
  units: number;
  note: string | null;
  reference: string | null;
  createdAt: string;
}

/** A product that can be sold right now from one store. */
export interface SellableProduct {
  productId: string;
  name: string;
  sku: string;
  barcode: string | null;
  onHand: number;
  /** Units sold in the last 30 days at this store. */
  sold30: number;
  /** Average units per day over the last 30 days. */
  dailyRate: number;
  /** Shelf price incl. VAT (what the customer pays). null = no price set. */
  sellPrice: number | null;
  /** VAT rate in %, e.g. 20. */
  vatRate: number;
}
export interface SaleLineInput {
  productId: string;
  qty: number;
}

export interface SalesQuery {
  page: number;
  pageSize: number;
  objectId: string;
  rangeDays: number | null;
  search: string;
}

export interface SalesSummary {
  totalUnits: number;
  saleEvents: number;
  productsSold: number;
}

interface SalesFeedRecord {
  id: string;
  object_id: string;
  object_name: string | null;
  product_id: string;
  product_name: string | null;
  sku: string | null;
  units: number | null;
  note: string | null;
  created_at: string;
  occurred_at: string;
  unit_price: number | null;
  gross: number | null;
  revenue: number | null;
  margin: number | null;
}

interface SalesSummaryRecord {
  total_units: number | string | null;
  sale_events: number | string | null;
  products_sold: number | string | null;
}

@Injectable({ providedIn: 'root' })
export class SalesService {
  private readonly saleKey = new IdempotencyKey();
  readonly rows = signal<SaleRow[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly page = signal(1);
  readonly pageSize = signal(10);
  readonly total = signal(0);

  readonly summary = signal<SalesSummary>({ totalUnits: 0, saleEvents: 0, productsSold: 0 });

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));

  // ---------- insights (chart + top products) ----------
  readonly insights = signal<SaleInsight[]>([]);
  readonly insightsLoading = signal(false);

  // ---------- record sale ----------
  readonly sellable = signal<SellableProduct[]>([]);
  readonly sellableLoading = signal(false);
  readonly saving = signal(false);

  /** Company currency (company profile), e.g. RSD. */
  readonly currency = signal('RSD');
  private currencyLoaded = false;

  private async ensureCurrency(): Promise<void> {
    if (this.currencyLoaded) return;
    this.currencyLoaded = true;
    const { data } = await supabase.rpc('app_currency');
    if (typeof data === 'string' && data) this.currency.set(data);
  }

  async load(params: Partial<SalesQuery> = {}): Promise<void> {
    const page = params.page ?? this.page();
    const pageSize = params.pageSize ?? this.pageSize();
    const objectId = params.objectId ?? '';
    const rangeDays = params.rangeDays === undefined ? 30 : params.rangeDays;
    const search = (params.search ?? '').trim();

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    const since = sinceIso(rangeDays);

    this.loading.set(true);
    this.error.set(null);
    void this.ensureCurrency();

    let query = supabase
  .from('sales_feed')
  .select('*', { count: 'exact' })
  .order('occurred_at', { ascending: false })
  .order('created_at', { ascending: false })
  .range(from, to);

    if (objectId) query = query.eq('object_id', objectId);
    if (since !== null) query = query.gte('occurred_at', since);
    if (search) {
      const safe = search.replace(/,/g, ' ');
      query = query.or(
        [
          `product_name.ilike.%${safe}%`,
          `sku.ilike.%${safe}%`,
          `object_name.ilike.%${safe}%`,
          `note.ilike.%${safe}%`,
        ].join(',')
      );
    }

    const [rowsResult, summaryResult] = await Promise.all([
      query,
      supabase.rpc('sales_feed_summary', {
        p_object_id: objectId || null,
        p_from: since,
        p_search: search || null,
      }),
    ]);

    const { data, error, count } = rowsResult;
    const { data: summaryData, error: summaryError } = summaryResult;

    if (error) {
      this.error.set(this.friendly(error.message));
      this.rows.set([]);
      this.total.set(0);
      this.summary.set({ totalUnits: 0, saleEvents: 0, productsSold: 0 });
      this.loading.set(false);
      return;
    }

    const records = (data ?? []) as SalesFeedRecord[];

    // References live on stock_movements — fetch them for this page only.
    const refs = new Map<string, string | null>();
    if (records.length) {
      const { data: refData } = await supabase
        .from('stock_movements')
        .select('id, reference')
        .in('id', records.map((r) => r.id));
      for (const r of (refData ?? []) as { id: string; reference: string | null }[]) {
        refs.set(r.id, r.reference);
      }
    }

    this.rows.set(
      records.map((r) => ({
        id: r.id,
        objectId: r.object_id,
        objectName: r.object_name ?? '—',
        productId: r.product_id,
        name: r.product_name ?? 'Product',
        sku: r.sku ?? '—',
        units: r.units ?? 0,
        note: r.note,
        createdAt: r.occurred_at ?? r.created_at,
        reference: refs.get(r.id) ?? null,
        amount: r.gross !== null && r.gross !== undefined
          ? Number(r.gross)
          : r.unit_price !== null ? (r.units ?? 0) * Number(r.unit_price) : null,
      }))
    );
    this.page.set(page);
    this.pageSize.set(pageSize);
    this.total.set(count ?? 0);

    if (summaryError) {
      this.summary.set({ totalUnits: 0, saleEvents: count ?? 0, productsSold: 0 });
    } else {
      const s = (summaryData?.[0] ?? null) as SalesSummaryRecord | null;
      this.summary.set({
        totalUnits: Number(s?.total_units ?? 0),
        saleEvents: Number(s?.sale_events ?? 0),
        productsSold: Number(s?.products_sold ?? 0),
      });
    }

    this.loading.set(false);
  }

  /** Every sale line in the range (capped) — feeds chart, top products and KPIs. */
  async loadInsights(objectId: string, rangeDays: number | null): Promise<void> {
    this.insightsLoading.set(true);
    const since = sinceIso(rangeDays);

    let q = supabase
  .from('stock_movements')
  .select('id, product_id, quantity, note, reference, occurred_at, product:products ( name, sku )')
  .eq('event', 'SALE')
  .order('occurred_at', { ascending: false })
  .order('created_at', { ascending: false })
  .limit(5000);

    if (objectId) q = q.eq('object_id', objectId);
if (since !== null) q = q.gte('occurred_at', since);

    const { data, error } = await q;
    if (error) {
      this.insights.set([]);
      this.insightsLoading.set(false);
      return;
    }

    this.insights.set(
      ((data ?? []) as any[]).map((m) => ({
        id: m.id,
        productId: m.product_id,
        name: m.product?.name ?? 'Product',
        sku: m.product?.sku ?? '—',
        units: Math.abs(Number(m.quantity) || 0),
        note: m.note,
        reference: m.reference,
        createdAt: m.occurred_at,
      }))
    );
    this.insightsLoading.set(false);
  }

  next(params: Omit<Partial<SalesQuery>, 'page'> = {}): Promise<void> {
    if (this.page() >= this.totalPages()) return Promise.resolve();
    return this.load({ ...params, page: this.page() + 1 });
  }

  previous(params: Omit<Partial<SalesQuery>, 'page'> = {}): Promise<void> {
    if (this.page() <= 1) return Promise.resolve();
    return this.load({ ...params, page: this.page() - 1 });
  }

  /** What can be sold in this store right now, with 30-day sales pace per product. */
  async loadSellable(objectId: string): Promise<void> {
    this.sellableLoading.set(true);
    void this.ensureCurrency();

    const [inv, mov] = await Promise.all([
      supabase
        .from('inventory')
        .select('product_id, quantity, product:products ( name, sku, barcode, active, sell_price, vat_rate )')
        .eq('object_id', objectId),
      supabase
        .from('stock_movements')
        .select('product_id, quantity')
        .eq('object_id', objectId)
        .eq('event', 'SALE')
        .gte('occurred_at', sinceIso(30) as string)
        .limit(5000),
    ]);

    const sold = new Map<string, number>();
    for (const m of (mov.data ?? []) as { product_id: string; quantity: number }[]) {
      sold.set(m.product_id, (sold.get(m.product_id) ?? 0) + Math.abs(Number(m.quantity) || 0));
    }

    const list = ((inv.data ?? []) as any[])
      .filter((r) => r.product && r.product.active !== false)
      .map((r) => {
        const sold30 = sold.get(r.product_id) ?? 0;
        return {
          productId: r.product_id,
          name: r.product.name ?? 'Product',
          sku: r.product.sku ?? '—',
          barcode: r.product.barcode ?? null,
          onHand: Number(r.quantity) || 0,
          sold30,
          dailyRate: sold30 / 30,
          sellPrice: r.product.sell_price === null || r.product.sell_price === undefined
            ? null : Number(r.product.sell_price),
          vatRate: Number(r.product.vat_rate ?? 20),
        };
      });

    this.sellable.set(list);
    this.sellableLoading.set(false);
  }

  /**
   * One sale = several SALE movements sharing one reference ("sale:<uuid>").
   * Written by the record_sale RPC in one transaction: every line or none.
   * A retry with the same idempotency key returns the first result.
   * Returns the reference on success, or an error message.
   */
  async recordSale(
    objectId: string,
    lines: SaleLineInput[],
    note: string | null,
    _createdBy?: string // kept for callers; the database uses auth.uid()
  ): Promise<{ reference: string | null; error: string | null }> {
    const clean = lines
      .filter((l) => l.qty > 0)
      .sort((a, b) => a.productId.localeCompare(b.productId))
      .map((l) => ({ product_id: l.productId, qty: Math.abs(l.qty) }));
    if (!clean.length) return { reference: null, error: 'Add at least one product.' };

    this.saving.set(true);
    const { data, error } = await supabase.rpc('record_sale', {
      p_object_id: objectId,
      p_lines: clean,
      p_note: note,
      p_idempotency_key: this.saleKey.for({ objectId, clean, note }),
    });
    this.saving.set(false);

    if (error) return { reference: null, error: this.friendly(error.message) };
    this.saleKey.done();
    return { reference: (data as { reference: string } | null)?.reference ?? null, error: null };
  }

  private friendly(msg: string): string {
    if (msg.includes('register import')) return msg;
if (msg.includes('cannot be in the future')) return msg;
    if (msg.includes('DEMO_READONLY')) return 'This action is disabled in the demo account.';
    if (msg.includes('Insufficient stock')) return msg;
    if (msg.includes('violates row-level security')) return "You don't have permission to sell from this store.";
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError'))
      return 'Network issue - check your connection and try again.';
    return msg;
  }
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function sinceIso(rangeDays: number | null): string | null {
  if (rangeDays === null) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (rangeDays - 1));
  return d.toISOString();
}
