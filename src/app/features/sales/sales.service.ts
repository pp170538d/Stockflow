import { Injectable, computed, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';

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
}

interface SalesSummaryRecord {
  total_units: number | string | null;
  sale_events: number | string | null;
  products_sold: number | string | null;
}

@Injectable({ providedIn: 'root' })
export class SalesService {
  readonly rows = signal<SaleRow[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly page = signal(1);
  readonly pageSize = signal(10);
  readonly total = signal(0);

  readonly summary = signal<SalesSummary>({
    totalUnits: 0,
    saleEvents: 0,
    productsSold: 0,
  });

  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.total() / this.pageSize()))
  );

  async load(params: Partial<SalesQuery> = {}): Promise<void> {
    const page = params.page ?? this.page();
    const pageSize = params.pageSize ?? this.pageSize();
    const objectId = params.objectId ?? '';
    const rangeDays = params.rangeDays === undefined ? 30 : params.rangeDays;
    const search = (params.search ?? '').trim();

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const since =
      rangeDays === null
        ? null
        : (() => {
            const d = new Date();
            d.setDate(d.getDate() - rangeDays);
            return d.toISOString();
          })();

    this.loading.set(true);
    this.error.set(null);

    let query = supabase
      .from('sales_feed')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (objectId) {
      query = query.eq('object_id', objectId);
    }

    if (since !== null) {
      query = query.gte('created_at', since);
    }

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
      this.error.set(error.message);
      this.rows.set([]);
      this.total.set(0);
      this.summary.set({
        totalUnits: 0,
        saleEvents: 0,
        productsSold: 0,
      });
      this.loading.set(false);
      return;
    }

    const rows = ((data ?? []) as SalesFeedRecord[]).map((r) => ({
      id: r.id,
      objectId: r.object_id,
      objectName: r.object_name ?? '—',
      productId: r.product_id,
      name: r.product_name ?? 'Product',
      sku: r.sku ?? '—',
      units: r.units ?? 0,
      note: r.note,
      createdAt: r.created_at,
    }));

    this.rows.set(rows);
    this.page.set(page);
    this.pageSize.set(pageSize);
    this.total.set(count ?? 0);

    if (summaryError) {
      this.summary.set({
        totalUnits: 0,
        saleEvents: count ?? 0,
        productsSold: 0,
      });
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

  async next(params: Omit<Partial<SalesQuery>, 'page'> = {}): Promise<void> {
    if (this.page() >= this.totalPages()) return;

    await this.load({
      ...params,
      page: this.page() + 1,
    });
  }

  async previous(params: Omit<Partial<SalesQuery>, 'page'> = {}): Promise<void> {
    if (this.page() <= 1) return;

    await this.load({
      ...params,
      page: this.page() - 1,
    });
  }
}