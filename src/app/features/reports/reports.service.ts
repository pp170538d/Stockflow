import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { Urgency, runway as forecast } from '../../core/stock/runway';

export type { Urgency } from '../../core/stock/runway';
export { TARGET_DAYS } from '../../core/stock/runway';

export type MovementEvent =
  | 'DELIVERY'
  | 'SALE'
  | 'STOCK_COUNT'
  | 'ADJUSTMENT'
  | 'TRANSFER'
  | 'RETURN'
  | 'WRITE_OFF';

/** One column of the stock-flow chart (a day, or a week for 90d). */
export interface FlowBucket {
  start: string;
  label: string;
  inU: number;
  outU: number;
  net: number;
  sold: number;
  events: number;
  balance: number;
}

export interface MixSlice {
  event: MovementEvent;
  count: number;
  units: number;
  pct: number;
  offset: number;
}

export interface TopProduct {
  productId: string;
  name: string;
  sku: string;
  unitsOut: number;
  unitsIn: number;
  share: number;
}

export interface RunwayRow {
  productId: string;

  /** Location to reorder for — selected location, or only assigned location. */
  objectId: string | null;

  name: string;
  sku: string;
  onHand: number;
  unitsSold: number;
  dailyRate: number;
  daysLeft: number | null;
  urgency: Urgency;

  /** Too few sales to trust the forecast. */
  lowData: boolean;

  /** Units already on PENDING / APPROVED orders. */
  incoming: number;

  /** Units to order so stock covers TARGET_DAYS after incoming stock. */
  suggestQty: number;
}

export interface ReportKpis {
  onHand: number;
  onHandStart: number;
  unitsIn: number;
  unitsOut: number;
  sold: number;
  soldPrev: number;
  movements: number;
  movementsPrev: number;
  orders: number;
  ordersPrev: number;
  reorder: number;
  soon: number;
}

const DAY = 86_400_000;

const EMPTY_KPIS: ReportKpis = {
  onHand: 0,
  onHandStart: 0,
  unitsIn: 0,
  unitsOut: 0,
  sold: 0,
  soldPrev: 0,
  movements: 0,
  movementsPrev: 0,
  orders: 0,
  ordersPrev: 0,
  reorder: 0,
  soon: 0,
};

const MIX_ORDER: MovementEvent[] = [
  'SALE',
  'DELIVERY',
  'STOCK_COUNT',
  'ADJUSTMENT',
  'RETURN',
  'WRITE_OFF',
  'TRANSFER',
];

const RANK: Record<Urgency, number> = {
  out: 0,
  critical: 1,
  warning: 2,
  healthy: 3,
  idle: 4,
};

@Injectable({ providedIn: 'root' })
export class ReportsService {
  readonly kpis = signal<ReportKpis>(EMPTY_KPIS);
  readonly buckets = signal<FlowBucket[]>([]);
  readonly granularity = signal<'day' | 'week'>('day');
  readonly mix = signal<MixSlice[]>([]);
  readonly topProducts = signal<TopProduct[]>([]);
  readonly runway = signal<RunwayRow[]>([]);

  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Loads the selected window AND the window before it
   * for "vs previous" comparisons.
   *
   * IMPORTANT:
   * Runway starts from object_products, not inventory.
   * An assigned product with no inventory row is still stock = 0
   * and must appear in reports.
   */
  async load(
    objectId: string | null = null,
    days = 30
  ): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const start = new Date();

    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));

    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - days);

    const scope = (q: any) =>
      objectId
        ? q.eq('object_id', objectId)
        : q;

    const [
      invRes,
      movRes,
      ordRes,
      openRes,
      assignedRes,
    ] = await Promise.all([
      scope(
        supabase
          .from('inventory')
          .select(`
            object_id,
            product_id,
            quantity,
            product:products (
              name,
              sku
            )
          `)
      ),

      scope(
        supabase
          .from('stock_movements')
          .select(`
            product_id,
            event,
            quantity,
            created_at,
            product:products (
              name,
              sku
            )
          `)
          .gte(
            'created_at',
            prevStart.toISOString()
          )
          .order(
            'created_at',
            { ascending: false }
          )
          .limit(10000)
      ),

      scope(
        supabase
          .from('orders')
          .select('id, created_at')
          .gte(
            'created_at',
            prevStart.toISOString()
          )
      ),

      scope(
        supabase
          .from('orders')
          .select(`
            object_id,
            order_items (
              product_id,
              quantity
            )
          `)
          .in(
            'status',
            ['PENDING', 'APPROVED']
          )
      ),

      objectId
        ? supabase
            .from('object_products')
            .select(`
              object_id,
              product_id,
              product:products (
                id,
                name,
                sku,
                active
              )
            `)
            .eq('object_id', objectId)
        : supabase
            .from('object_products')
            .select(`
              object_id,
              product_id,
              product:products (
                id,
                name,
                sku,
                active
              )
            `),
    ]);

    if (
      invRes.error ||
      movRes.error ||
      ordRes.error ||
      openRes.error ||
      assignedRes.error
    ) {
      this.error.set(
        invRes.error?.message ||
        movRes.error?.message ||
        ordRes.error?.message ||
        openRes.error?.message ||
        assignedRes.error?.message ||
        'Failed to load reports.'
      );

      this.loading.set(false);
      return;
    }

    const inv = (invRes.data ?? []) as any[];
    const movs = (movRes.data ?? []) as any[];
    const orders =
      (ordRes.data ?? []) as {
        created_at: string;
      }[];

    const assigned =
      (assignedRes.data ?? []) as any[];

    const startMs = start.getTime();

    const cur = movs.filter(
      (m) =>
        new Date(m.created_at).getTime() >=
        startMs
    );

    const prev = movs.filter(
      (m) =>
        new Date(m.created_at).getTime() <
        startMs
    );

    // =============================================================
    // STOCK-FLOW BUCKETS
    // =============================================================

    const size = days >= 90 ? 7 : 1;
    const n = Math.ceil(days / size);

    this.granularity.set(
      size === 7 ? 'week' : 'day'
    );

    const buckets: FlowBucket[] =
      Array.from(
        { length: n },
        (_, i) => {
          const d = new Date(start);

          d.setDate(
            start.getDate() + i * size
          );

          return {
            start: d.toISOString(),

            label: d.toLocaleDateString(
              'en-GB',
              {
                day: 'numeric',
                month: 'short',
              }
            ),

            inU: 0,
            outU: 0,
            net: 0,
            sold: 0,
            events: 0,
            balance: 0,
          };
        }
      );

    let unitsIn = 0;
    let unitsOut = 0;
    let sold = 0;

    for (const m of cur) {
      const q = Number(m.quantity) || 0;

      const d = new Date(m.created_at);

      d.setHours(0, 0, 0, 0);

      const day = Math.round(
        (d.getTime() - startMs) / DAY
      );

      const bucketIndex = Math.min(
        n - 1,
        Math.max(
          0,
          Math.floor(day / size)
        )
      );

      const b = buckets[bucketIndex];

      if (q > 0) {
        b.inU += q;
        unitsIn += q;
      } else {
        b.outU += -q;
        unitsOut += -q;
      }

      b.net += q;
      b.events += 1;

      if (m.event === 'SALE') {
        const saleQty = Math.abs(q);

        b.sold += saleQty;
        sold += saleQty;
      }
    }

    // Current inventory total.
    const onHand = inv.reduce(
      (sum, row) =>
        sum +
        (Number(row.quantity) || 0),
      0
    );

    /*
     * Walk back from today's balance:
     *
     * previous closing =
     * current closing - current net movement
     */
    let bal = onHand;

    for (
      let i = n - 1;
      i >= 0;
      i--
    ) {
      buckets[i].balance = bal;
      bal -= buckets[i].net;
    }

    const onHandStart = bal;

    this.buckets.set(buckets);

    // =============================================================
    // MOVEMENT MIX
    // =============================================================

    const mixMap =
      new Map<
        MovementEvent,
        {
          count: number;
          units: number;
        }
      >();

    for (const m of cur) {
      const event =
        m.event as MovementEvent;

      const current =
        mixMap.get(event) ?? {
          count: 0,
          units: 0,
        };

      current.count += 1;
      current.units += Math.abs(
        Number(m.quantity) || 0
      );

      mixMap.set(event, current);
    }

    const totalEvents =
      cur.length || 1;

    let offset = 0;

    this.mix.set(
      MIX_ORDER
        .filter(
          (event) =>
            mixMap.has(event)
        )
        .map((event) => {
          const current =
            mixMap.get(event)!;

          const pct =
            (
              current.count /
              totalEvents
            ) * 100;

          const slice: MixSlice = {
            event,
            count: current.count,
            units: current.units,
            pct,
            offset,
          };

          offset += pct;

          return slice;
        })
    );

    // =============================================================
    // TOP MOVING PRODUCTS
    // =============================================================

    const topMap =
      new Map<string, TopProduct>();

    for (const m of cur) {
      const q =
        Number(m.quantity) || 0;

      const current =
        topMap.get(m.product_id) ?? {
          productId: m.product_id,
          name:
            m.product?.name ??
            'Product',
          sku:
            m.product?.sku ??
            '',
          unitsOut: 0,
          unitsIn: 0,
          share: 0,
        };

      if (q < 0) {
        current.unitsOut += -q;
      } else {
        current.unitsIn += q;
      }

      topMap.set(
        m.product_id,
        current
      );
    }

    const totalOut =
      [...topMap.values()].reduce(
        (sum, product) =>
          sum + product.unitsOut,
        0
      ) || 1;

    this.topProducts.set(
      [...topMap.values()]
        .filter(
          (product) =>
            product.unitsOut > 0
        )
        .sort(
          (a, b) =>
            b.unitsOut -
            a.unitsOut
        )
        .slice(0, 6)
        .map((product) => ({
          ...product,

          share:
            (
              product.unitsOut /
              totalOut
            ) * 100,
        }))
    );

    // =============================================================
    // SALES BY PRODUCT
    // =============================================================

    const soldMap =
      new Map<string, number>();

    for (const m of cur) {
      if (m.event !== 'SALE') {
        continue;
      }

      soldMap.set(
        m.product_id,
        (
          soldMap.get(
            m.product_id
          ) ?? 0
        ) +
          Math.abs(
            Number(m.quantity) || 0
          )
      );
    }

    // =============================================================
    // PRODUCT SCOPE
    //
    // object_products defines what belongs to a location.
    // Missing inventory row = zero stock, NOT missing product.
    // =============================================================

    const prodMap =
      new Map<
        string,
        {
          name: string;
          sku: string;
          onHand: number;
          objects: Set<string>;
        }
      >();

    /*
     * Start from active assigned products.
     *
     * This fixes the case:
     *
     * object_products:
     *   SKU-1004 assigned
     *
     * inventory:
     *   no row
     *
     * The product must still appear with onHand = 0.
     */
    for (const row of assigned) {
      const product = row.product;

      if (
        !product ||
        product.active === false
      ) {
        continue;
      }

      const current =
        prodMap.get(
          row.product_id
        );

      if (current) {
        current.objects.add(
          row.object_id
        );

        continue;
      }

      prodMap.set(
        row.product_id,
        {
          name:
            product.name ??
            'Product',

          sku:
            product.sku ??
            '',

          onHand: 0,

          objects:
            new Set<string>([
              row.object_id,
            ]),
        }
      );
    }

    /*
     * Overlay actual inventory balances.
     */
    for (const row of inv) {
      const current =
        prodMap.get(
          row.product_id
        );

      if (!current) {
        /*
         * Historical safety fallback:
         * inventory exists but assignment does not.
         */
        prodMap.set(
          row.product_id,
          {
            name:
              row.product?.name ??
              'Product',

            sku:
              row.product?.sku ??
              '',

            onHand:
              Number(
                row.quantity
              ) || 0,

            objects:
              new Set<string>([
                row.object_id,
              ]),
          }
        );

        continue;
      }

      current.onHand +=
        Number(row.quantity) || 0;

      current.objects.add(
        row.object_id
      );
    }

    // =============================================================
    // INCOMING STOCK
    // =============================================================

    const incomingMap =
      new Map<string, number>();

    for (
      const order of
      (openRes.data ?? []) as any[]
    ) {
      for (
        const item of
        (
          order.order_items ?? []
        ) as {
          product_id: string;
          quantity: number;
        }[]
      ) {
        incomingMap.set(
          item.product_id,
          (
            incomingMap.get(
              item.product_id
            ) ?? 0
          ) +
            (
              Number(
                item.quantity
              ) || 0
            )
        );
      }
    }

    // =============================================================
    // RUNWAY
    // =============================================================

    const runway: RunwayRow[] =
      [...prodMap.entries()].map(
        ([productId, product]) => {
          const unitsSold =
            soldMap.get(
              productId
            ) ?? 0;

          const incoming =
            incomingMap.get(
              productId
            ) ?? 0;

          const result =
            forecast(
              product.onHand,
              unitsSold,
              days,
              incoming
            );

          return {
            productId,

            objectId:
              objectId ??
              (
                product.objects.size === 1
                  ? [
                      ...product.objects,
                    ][0]
                  : null
              ),

            name: product.name,
            sku: product.sku,
            onHand:
              product.onHand,
            unitsSold,

            dailyRate:
              result.dailyRate,

            daysLeft:
              result.daysLeft,

            urgency:
              result.urgency,

            lowData:
              result.lowData,

            incoming,

            suggestQty:
              result.suggest,
          };
        }
      );

    runway.sort(
      (a, b) =>
        RANK[a.urgency] -
          RANK[b.urgency] ||
        (
          a.daysLeft ??
          Infinity
        ) -
          (
            b.daysLeft ??
            Infinity
          ) ||
        a.name.localeCompare(
          b.name
        )
    );

    this.runway.set(runway);

    // =============================================================
    // KPIs
    // =============================================================

    const soldPrev = prev
      .filter(
        (m) =>
          m.event === 'SALE'
      )
      .reduce(
        (sum, movement) =>
          sum +
          Math.abs(
            Number(
              movement.quantity
            ) || 0
          ),
        0
      );

    const ordersCur =
      orders.filter(
        (order) =>
          new Date(
            order.created_at
          ).getTime() >=
          startMs
      ).length;

    this.kpis.set({
      onHand,
      onHandStart,
      unitsIn,
      unitsOut,
      sold,
      soldPrev,

      movements:
        cur.length,

      movementsPrev:
        prev.length,

      orders:
        ordersCur,

      ordersPrev:
        orders.length -
        ordersCur,

      reorder:
        runway.filter(
          (row) =>
            row.urgency === 'out' ||
            row.urgency === 'critical'
        ).length,

      soon:
        runway.filter(
          (row) =>
            row.urgency === 'warning'
        ).length,
    });

    this.loaded.set(true);
    this.loading.set(false);
  }
}