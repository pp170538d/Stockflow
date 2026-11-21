import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RequestSplitService } from './request-split.service';
import {
  Allocation, ApproveRequestResult, PlanGroup, PlanLine, SupplierOption,
} from './request-split.model';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';

let seq = 0;
const key = () => `a${++seq}`;

/**
 * Purchase plan for a PENDING request: supplier per line (optionally split),
 * pack-size aware quantities, price trend, and one atomic approval that
 * creates one purchase order per supplier.
 */
@Component({
  selector: 'app-request-split',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './request-split.component.html',
})
export class RequestSplitComponent {
  private svc = inject(RequestSplitService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly orderId = input.required<string>();
  readonly currency = input<string>('RSD');
  /** Emitted after a successful approval with the created purchase orders. */
  readonly approved = output<ApproveRequestResult>();

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly approving = signal(false);
  readonly lines = signal<PlanLine[]>([]);
  readonly options = signal<Map<string, SupplierOption[]>>(new Map());
  readonly prices = signal<Map<string, number>>(new Map());
  /** Lines whose supplier picker is open (resolved lines show plain text). */
  readonly editing = signal<Set<string>>(new Set());
  readonly view = signal<'all' | 'ready' | 'attention'>('all');

  constructor() {
    effect(() => {
      const id = this.orderId();
      untracked(() => void this.load(id));
    });
  }

  async load(orderId: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const s = await this.svc.suggestions(orderId);
    if (s.error) {
      this.error.set(s.error);
      this.loading.set(false);
      return;
    }

    const productIds = [...new Set(s.data.map((x) => x.product_id))];
    const [opts, prices] = await Promise.all([
      this.svc.options(productIds),
      this.svc.lastPrices(productIds),
    ]);
    if (opts.error) this.error.set(opts.error);

    this.options.set(opts.byProduct);
    this.prices.set(prices);
    this.lines.set(
      s.data.map((x) => ({
        s: x,
        included: true,
        allocations: [{
          key: key(),
          supplierId: x.supplier_id,
          quantity: x.supplier_id ? x.suggested_qty : x.quantity,
        }],
      }))
    );
    this.editing.set(new Set());
    this.view.set(this.attentionCount() > 0 ? 'attention' : 'all');
    this.loading.set(false);
  }

  // ---------- line state ----------
  isEditing(line: PlanLine): boolean {
    return this.editing().has(line.s.order_item_id) || line.allocations.length > 1;
  }

  toggleEdit(line: PlanLine): void {
    this.editing.update((set) => {
      const next = new Set(set);
      next.has(line.s.order_item_id) ? next.delete(line.s.order_item_id) : next.add(line.s.order_item_id);
      return next;
    });
  }

  /** Every allocation has a supplier, a positive quantity and fits the pack rule. */
  lineReady(line: PlanLine): boolean {
    if (!line.included) return true;
    const ids = line.allocations.map((a) => a.supplierId);
    if (new Set(ids).size !== ids.length) return false;
    return line.allocations.every((a) => !!a.supplierId && a.quantity > 0 && !this.packIssue(line, a));
  }

  readonly readyCount = computed(() => this.lines().filter((l) => l.included && this.lineReady(l)).length);
  readonly attentionCount = computed(() => this.lines().filter((l) => l.included && !this.lineReady(l)).length);

  readonly visibleLines = computed(() => {
    const v = this.view();
    if (v === 'ready') return this.lines().filter((l) => l.included && this.lineReady(l));
    if (v === 'attention') return this.lines().filter((l) => !l.included || !this.lineReady(l));
    return this.lines();
  });

  /** 'up-big' > 25 %, 'up' > 0, 'down', 'same', or null when unknown. */
  priceLevel(change: number | null): 'up-big' | 'up' | 'down' | 'same' | null {
    if (change === null) return null;
    if (change > 25) return 'up-big';
    if (change > 0.05) return 'up';
    if (change < -0.05) return 'down';
    return 'same';
  }

  // ---------- lookups ----------
  optionsFor(productId: string): SupplierOption[] {
    return this.options().get(productId) ?? [];
  }

  catalogOptions(productId: string): SupplierOption[] {
    return this.optionsFor(productId).filter((o) => o.in_catalog);
  }

  otherOptions(productId: string): SupplierOption[] {
    return this.optionsFor(productId).filter((o) => !o.in_catalog);
  }

  option(productId: string, supplierId: string | null): SupplierOption | null {
    if (!supplierId) return null;
    return this.optionsFor(productId).find((o) => o.supplier_id === supplierId) ?? null;
  }

  lastPrice(supplierId: string | null, productId: string): number | null {
    if (!supplierId) return null;
    return this.prices().get(`${supplierId}:${productId}`) ?? null;
  }

  /** % change of today's cost vs the last price from this supplier. */
  priceChange(line: PlanLine, a: Allocation): number | null {
    const last = this.lastPrice(a.supplierId, line.s.product_id);
    const now = line.s.current_cost;
    if (last === null || now === null || last === 0) return null;
    return ((now - last) / last) * 100;
  }

  allocated(line: PlanLine): number {
    return line.allocations.reduce((sum, a) => sum + (a.quantity || 0), 0);
  }

  /** Pack-rule hint for one allocation, or null when it fits. */
  packIssue(line: PlanLine, a: Allocation): string | null {
    const o = this.option(line.s.product_id, a.supplierId);
    if (!o || !a.quantity) return null;
    const min = o.pack_size * o.minimum_packs;
    if (a.quantity < min) return `Supplier minimum is ${min} units (${o.minimum_packs} × ${o.pack_size}).`;
    if (o.pack_size > 1 && a.quantity % o.pack_size !== 0) {
      return `Supplier ships in packs of ${o.pack_size}.`;
    }
    return null;
  }

  /** Nearest valid quantity for the button label. */
  validQty(line: PlanLine, a: Allocation): number {
    const o = this.option(line.s.product_id, a.supplierId);
    if (!o) return a.quantity;
    const min = o.pack_size * o.minimum_packs;
    return Math.max(min, Math.ceil(a.quantity / o.pack_size) * o.pack_size);
  }

  roundToPack(line: PlanLine, a: Allocation): void {
    const o = this.option(line.s.product_id, a.supplierId);
    if (!o) return;
    const min = o.pack_size * o.minimum_packs;
    const qty = Math.max(min, Math.ceil(a.quantity / o.pack_size) * o.pack_size);
    this.patch(line, a, { quantity: qty });
  }

  // ---------- edits ----------
  private update(line: PlanLine, fn: (l: PlanLine) => PlanLine): void {
    this.lines.update((all) => all.map((l) => (l === line ? fn(l) : l)));
  }

  patch(line: PlanLine, a: Allocation, p: Partial<Allocation>): void {
    this.update(line, (l) => ({
      ...l,
      allocations: l.allocations.map((x) => (x.key === a.key ? { ...x, ...p } : x)),
    }));
  }

  setSupplier(line: PlanLine, a: Allocation, supplierId: string): void {
    const o = this.option(line.s.product_id, supplierId || null);
    // Single allocation: re-round the request to the new supplier's pack rule
    let quantity = a.quantity;
    if (o && line.allocations.length === 1) {
      const min = o.pack_size * o.minimum_packs;
      quantity = Math.max(min, Math.ceil(line.s.quantity / o.pack_size) * o.pack_size);
    }
    this.patch(line, a, { supplierId: supplierId || null, quantity });
    // Picked a supplier for a single line: fold the picker back to plain text
    if (supplierId && line.allocations.length === 1) {
      this.editing.update((set) => {
        const next = new Set(set);
        next.delete(line.s.order_item_id);
        return next;
      });
    }
  }

  setQty(line: PlanLine, a: Allocation, value: string): void {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    this.patch(line, a, { quantity: n });
  }

  split(line: PlanLine): void {
    const used = new Set(line.allocations.map((a) => a.supplierId));
    const next = this.optionsFor(line.s.product_id).find((o) => !used.has(o.supplier_id)) ?? null;
    const remaining = Math.max(0, line.s.quantity - this.allocated(line));
    this.update(line, (l) => ({
      ...l,
      allocations: [...l.allocations, { key: key(), supplierId: next?.supplier_id ?? null, quantity: remaining }],
    }));
  }

  removeAllocation(line: PlanLine, a: Allocation): void {
    if (line.allocations.length === 1) return;
    this.update(line, (l) => ({ ...l, allocations: l.allocations.filter((x) => x.key !== a.key) }));
  }

  toggleIncluded(line: PlanLine): void {
    this.update(line, (l) => ({ ...l, included: !l.included }));
  }

  // ---------- plan ----------
  readonly included = computed(() => this.lines().filter((l) => l.included));

  readonly blockers = computed(() => {
    const msgs: string[] = [];
    if (!this.included().length) msgs.push('Keep at least one line.');
    for (const l of this.included()) {
      if (l.allocations.some((a) => !a.supplierId)) msgs.push(`${l.s.product_name}: choose a supplier.`);
      if (l.allocations.some((a) => !a.quantity || a.quantity <= 0)) msgs.push(`${l.s.product_name}: quantity must be above 0.`);
      const ids = l.allocations.map((a) => a.supplierId).filter(Boolean);
      if (new Set(ids).size !== ids.length) msgs.push(`${l.s.product_name}: the same supplier is used twice.`);
      if (l.allocations.some((a) => this.packIssue(l, a))) msgs.push(`${l.s.product_name}: quantity does not fit the supplier's pack rule.`);
    }
    return msgs;
  });

  /** Lines with a price increase above 25 % vs the last order (warning only). */
  readonly warnings = computed(() => {
    let n = 0;
    for (const l of this.included())
      for (const a of l.allocations) if (this.priceLevel(this.priceChange(l, a)) === 'up-big') n++;
    return n;
  });

  readonly plan = computed<PlanGroup[]>(() => {
    const map = new Map<string, PlanGroup>();
    for (const l of this.included()) {
      for (const a of l.allocations) {
        if (!a.supplierId || !a.quantity) continue;
        const o = this.option(l.s.product_id, a.supplierId);
        const g = map.get(a.supplierId) ?? {
          supplierId: a.supplierId,
          supplierName: o?.supplier_name ?? 'Supplier',
          lines: 0, units: 0, value: 0, missingCost: 0,
        };
        g.lines++;
        g.units += a.quantity;
        if (l.s.current_cost === null) g.missingCost++;
        else g.value += a.quantity * l.s.current_cost;
        map.set(a.supplierId, g);
      }
    }
    return [...map.values()].sort((a, b) => b.units - a.units);
  });

  readonly totals = computed(() => {
    const p = this.plan();
    return {
      orders: p.length,
      units: p.reduce((s, g) => s + g.units, 0),
      value: p.reduce((s, g) => s + g.value, 0),
      skipped: this.lines().length - this.included().length,
    };
  });

  // ---------- approve ----------
  async approve(): Promise<void> {
    if (this.blockers().length || this.approving()) return;

    const t = this.totals();
    const names = this.plan().map((g) => g.supplierName).join(', ');
    const ok = await this.confirm.ask({
      title: t.orders === 1 ? 'Approve request?' : `Approve and create ${t.orders} purchase orders?`,
      message:
        (t.orders === 1
          ? `One purchase order for ${names}.`
          : `The request is split by supplier: ${names}. Each supplier gets its own approved purchase order.`) +
        (t.skipped ? ` ${t.skipped} skipped line(s) will not be ordered.` : '') +
        (this.warnings() ? ` ${this.warnings()} line(s) cost more than 25% above the last order.` : ''),
      confirmLabel: t.orders === 1 ? 'Approve' : `Create ${t.orders} orders`,
    });
    if (!ok) return;

    const payload = this.included().flatMap((l) =>
      l.allocations.map((a) => ({
        order_item_id: l.s.order_item_id,
        supplier_id: a.supplierId as string,
        quantity: a.quantity,
      }))
    );

    this.approving.set(true);
    const res = await this.svc.approve(this.orderId(), payload);
    this.approving.set(false);

    if (res.error || !res.data) {
      this.toast.error(res.error ?? 'Approval failed.');
      return;
    }

    const numbers = res.data.orders.map((o) => o.order_number).join(', ');
    this.toast.success(
      res.data.orders.length === 1 ? `${numbers} approved.` : `${res.data.orders.length} purchase orders created: ${numbers}.`
    );
    this.approved.emit(res.data);
  }
}
