import { Injectable, computed, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import {
  InventoryItem, InventoryRow, StockMovement, MovementEvent, Urgency,
  INSIGHT_DAYS, CRITICAL_DAYS, WARNING_DAYS,
} from './inventory.model';

export interface MovementsQuery {
  page: number;
  pageSize: number;
  event: MovementEvent | '';
  search: string;
}

interface WindowMovement {
  product_id: string;
  event: MovementEvent;
  quantity: number;
  created_at: string;
}

const DAY = 86_400_000;
const SPARK_W = 100;
const SPARK_H = 28;

@Injectable({ providedIn: 'root' })
export class InventoryService {
  readonly rows = signal<InventoryRow[]>([]);
  readonly items = signal<InventoryItem[]>([]);
  readonly movements = signal<StockMovement[]>([]);

  /** movement_id → balance right after that movement (for the history timeline). */
  readonly balances = signal<Map<string, number>>(new Map());

  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  readonly movementsLoading = signal<boolean>(false);
  readonly movementsError = signal<string | null>(null);
  readonly movementsPage = signal(1);
  readonly movementsPageSize = signal(20);
  readonly movementsTotal = signal(0);
  readonly movementsTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.movementsTotal() / this.movementsPageSize()))
  );

  /**
   * Current stock for one object + 30 days of ledger behaviour per product.
   * Two queries in parallel; everything else is computed client-side.
   * `silent` keeps the table on screen (no skeleton) — used after a write.
   */
  async loadInventory(objectId: string, opts: { silent?: boolean } = {}): Promise<void> {
    if (!opts.silent) this.loading.set(true);
    this.error.set(null);

    const since = windowStart();

    const [inv, mov] = await Promise.all([
      supabase
        .from('inventory')
        .select('*, product:products ( name, sku, category )')
        .eq('object_id', objectId),
      supabase
        .from('stock_movements')
        .select('product_id, event, quantity, created_at')
        .eq('object_id', objectId)
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: false })
        .limit(5000),
    ]);

    if (inv.error) {
      this.error.set(this.friendly(inv.error.message));
      this.loading.set(false);
      return;
    }

    const rows = (inv.data ?? []) as unknown as InventoryRow[];
    const movs = mov.error ? [] : ((mov.data ?? []) as WindowMovement[]);

    this.rows.set(rows);
    this.items.set(buildItems(rows, movs, since));
    this.loading.set(false);
  }

  /** Paginated movement history for one object + product. */
  async loadMovements(
    objectId: string,
    productId: string,
    params: Partial<MovementsQuery> = {}
  ): Promise<void> {
    const page = params.page ?? this.movementsPage();
    const pageSize = params.pageSize ?? this.movementsPageSize();
    const event = params.event ?? '';
    const search = (params.search ?? '').trim();

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    this.movementsLoading.set(true);
    this.movementsError.set(null);

    let query = supabase
      .from('stock_movements')
      .select('*, product:products ( name, sku )', { count: 'exact' })
      .eq('object_id', objectId)
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (event) query = query.eq('event', event);
    if (search) {
      const safe = search.replace(/,/g, ' ');
      query = query.or(`note.ilike.%${safe}%,reference.ilike.%${safe}%`);
    }

    const { data, error, count } = await query;

    if (error) {
      this.movementsError.set(this.friendly(error.message));
      this.movements.set([]);
      this.movementsTotal.set(0);
      this.movementsLoading.set(false);
      return;
    }

    this.movements.set((data ?? []) as unknown as StockMovement[]);
    this.movementsPage.set(page);
    this.movementsPageSize.set(pageSize);
    this.movementsTotal.set(count ?? 0);
    this.movementsLoading.set(false);
  }

  /** Balance after every movement, from the existing stock_level_history RPC. */
  async loadBalances(objectId: string, productId: string): Promise<void> {
    this.balances.set(new Map());
    const { data, error } = await supabase.rpc('stock_level_history', {
      p_object_id: objectId,
      p_product_id: productId,
      p_from: null,
      p_to: null,
    });
    if (error || !data) return;

    const m = new Map<string, number>();
    for (const r of data as { movement_id: string | null; balance: number | string }[]) {
      if (r.movement_id) m.set(r.movement_id, Number(r.balance));
    }
    this.balances.set(m);
  }

  async nextMovements(
    objectId: string,
    productId: string,
    params: Omit<Partial<MovementsQuery>, 'page'> = {}
  ): Promise<void> {
    if (this.movementsPage() >= this.movementsTotalPages()) return;
    await this.loadMovements(objectId, productId, { ...params, page: this.movementsPage() + 1 });
  }

  async previousMovements(
    objectId: string,
    productId: string,
    params: Omit<Partial<MovementsQuery>, 'page'> = {}
  ): Promise<void> {
    if (this.movementsPage() <= 1) return;
    await this.loadMovements(objectId, productId, { ...params, page: this.movementsPage() - 1 });
  }

  /** Record a movement. `signedQty` is already signed by the caller. */
  async recordMovement(
    objectId: string,
    productId: string,
    event: MovementEvent,
    signedQty: number,
    createdBy: string,
    note: string | null
  ): Promise<string | null> {
    if (signedQty === 0) return 'Quantity cannot be zero.';

    const { error } = await supabase.from('stock_movements').insert({
      object_id: objectId,
      product_id: productId,
      event,
      quantity: signedQty,
      reference: 'manual',
      note,
      created_by: createdBy,
    });

    if (error) return this.friendly(error.message);

    await this.loadInventory(objectId, { silent: true });
    return null;
  }

  private friendly(msg: string): string {
    if (msg.includes('DEMO_READONLY')) return 'This action is disabled in the demo account.';
    if (msg.includes('Insufficient stock')) return msg;
    if (msg.includes('violates row-level security'))
      return "You don't have permission to record a movement for this object.";
    if (msg.includes('violates foreign key'))
      return 'That product or object no longer exists. Please refresh and try again.';
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError'))
      return 'Network issue - check your connection and try again.';
    return 'Could not record the movement. Please try again.';
  }
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

/** Local midnight, INSIGHT_DAYS - 1 days ago → window includes today. */
function windowStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (INSIGHT_DAYS - 1));
  return d;
}

function buildItems(rows: InventoryRow[], movs: WindowMovement[], since: Date): InventoryItem[] {
  const byProduct = new Map<string, WindowMovement[]>();
  for (const m of movs) {
    const list = byProduct.get(m.product_id);
    if (list) list.push(m);
    else byProduct.set(m.product_id, [m]);
  }

  return rows.map((r) => {
    const list = byProduct.get(r.product_id) ?? [];   // newest first
    const net = new Array<number>(INSIGHT_DAYS).fill(0);
    let in30 = 0;
    let out30 = 0;
    let sold30 = 0;

    for (const m of list) {
      const d = new Date(m.created_at);
      d.setHours(0, 0, 0, 0);
      const i = Math.round((d.getTime() - since.getTime()) / DAY);   // round = DST-safe
      if (i >= 0 && i < INSIGHT_DAYS) net[i] += m.quantity;
      if (m.quantity > 0) in30 += m.quantity;
      else out30 += -m.quantity;
      if (m.event === 'SALE') sold30 += Math.abs(m.quantity);
    }

    // Walk back from today's balance: closing(d-1) = closing(d) - net(d)
    const series = new Array<number>(INSIGHT_DAYS).fill(0);
    series[INSIGHT_DAYS - 1] = r.quantity;
    for (let i = INSIGHT_DAYS - 1; i > 0; i--) series[i - 1] = series[i] - net[i];

    const dailyRate = sold30 / INSIGHT_DAYS;
    const daysLeft = dailyRate > 0 ? r.quantity / dailyRate : null;

    let urgency: Urgency;
    if (r.quantity <= 0) urgency = 'out';
    else if (daysLeft === null) urgency = 'idle';
    else if (daysLeft <= CRITICAL_DAYS) urgency = 'critical';
    else if (daysLeft <= WARNING_DAYS) urgency = 'warning';
    else urgency = 'healthy';

    const { line, area } = spark(series);
    const top = list[0];

    return {
      ...r,
      series,
      sparkLine: line,
      sparkArea: area,
      in30,
      out30,
      sold30,
      dailyRate,
      daysLeft,
      urgency,
      last: top ? { event: top.event, quantity: top.quantity, created_at: top.created_at } : null,
    };
  });
}

/** Stepped sparkline — stock changes at events, it doesn't glide. */
function spark(series: number[]): { line: string; area: string } {
  const n = series.length;
  const max = Math.max(1, ...series);
  const x = (i: number) => (n <= 1 ? SPARK_W : (i / (n - 1)) * SPARK_W);
  const y = (v: number) => SPARK_H - 2 - (Math.max(0, v) / max) * (SPARK_H - 4);

  let line = `M0 ${y(series[0]).toFixed(2)}`;
  for (let i = 1; i < n; i++) {
    line += ` H${x(i).toFixed(2)} V${y(series[i]).toFixed(2)}`;
  }
  return { line, area: `${line} V${SPARK_H} H0 Z` };
}