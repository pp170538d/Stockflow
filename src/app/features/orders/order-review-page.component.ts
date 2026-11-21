import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { RequestSplitComponent } from './request-split.component';
import { ApproveRequestResult } from './request-split.model';

interface ReviewLine {
  order_item_id: string | null;
  product_id: string;
  sku: string;
  name: string;
  requested_qty: number;
  quantity: number;
  unit_cost: number | null;
  cost_price: number | null;
  last_price: number | null;
  last_order: string | null;
}
interface SupplierOption { id: string; name: string; }
interface ProductOption { id: string; sku: string; name: string; cost_price: number | null; }

@Component({
  selector: 'app-order-review-page',
  standalone: true,
  imports: [ RouterLink, RequestSplitComponent],
  templateUrl: './order-review-page.component.html',
})
export class OrderReviewPageComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly orderId = signal('');
  readonly orderNumber = signal('');
  readonly objectId = signal<string | null>(null);
  readonly objectName = signal('');
  readonly requestedBy = signal('');
  readonly createdAt = signal<string | null>(null);
  readonly currency = signal('RSD');
  readonly comment = signal('');
  readonly supplierId = signal('');
  readonly suppliers = signal<SupplierOption[]>([]);
  readonly lines = signal<ReviewLine[]>([]);

  readonly addOpen = signal(false);
  readonly addSearch = signal('');
  readonly catalog = signal<ProductOption[]>([]);

  readonly totals = computed(() => {
    let units = 0, value = 0, missing = 0, changedQty = 0, aboveLast = 0, belowLast = 0;
    for (const l of this.lines()) {
      units += l.quantity;
      if (l.unit_cost === null) missing++;
      else value += l.quantity * l.unit_cost;
      if (l.quantity !== l.requested_qty) changedQty++;
      if (l.last_price !== null && l.unit_cost !== null) {
        if (l.unit_cost > l.last_price) aboveLast++;
        if (l.unit_cost < l.last_price) belowLast++;
      }
    }
    const requestedUnits = this.lines().reduce((s,l)=>s+l.requested_qty,0); return { units, requestedUnits, value, missing, changedQty, aboveLast, belowLast };
  });

  onSplitApproved(result: ApproveRequestResult): void {
  void this.router.navigate(['/orders'], {
    queryParams: {
      status: 'APPROVED',
    },
  });
}

  readonly canSave = computed(() =>
    !this.saving() && this.lines().length > 0 &&
    this.lines().every(l => l.quantity > 0 && l.unit_cost !== null && l.unit_cost >= 0)
  );

  readonly addResults = computed(() => {
    const q = this.addSearch().trim().toLowerCase();
    const used = new Set(this.lines().map(l => l.product_id));
    return this.catalog()
      .filter(p => !used.has(p.id))
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
      .slice(0, 12);
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) { this.error.set('Order id is missing.'); return; }
    this.orderId.set(id);
    await this.load(id);
  }

  private async load(orderId: string): Promise<void> {
    this.loading.set(true); this.error.set(null); this.addOpen.set(false); this.addSearch.set('');

    const [orderRes, supRes] = await Promise.all([
      supabase.from('orders').select(`id, order_number, status, comment, created_at, currency, supplier_id, object_id,
        object:objects ( name ),
        order_items ( id, product_id, quantity, requested_qty, unit_cost,
          product:products ( sku, name, cost_price ) )`).eq('id', orderId).single(),
      supabase.from('suppliers').select('id, name').eq('active', true).order('name'),
    ]);

    if (orderRes.error) { this.error.set(orderRes.error.message); this.loading.set(false); return; }
    const order: any = orderRes.data;
    if (order.status !== 'PENDING') {
      await this.router.navigate(['/orders'], { queryParams: { focus: orderId } });
      return;
    }

    this.suppliers.set((supRes.data ?? []) as SupplierOption[]);
    this.orderNumber.set(order.order_number);
    this.objectId.set(order.object_id);
    this.objectName.set(order.object?.name ?? '');
    this.createdAt.set(order.created_at);
    this.currency.set(order.currency || 'RSD');
    this.comment.set(order.comment ?? '');
    this.supplierId.set(order.supplier_id ?? '');
    this.lines.set((order.order_items ?? []).map((i: any): ReviewLine => ({
      order_item_id: i.id,
      product_id: i.product_id,
      sku: i.product?.sku ?? '',
      name: i.product?.name ?? 'Product',
      requested_qty: i.requested_qty ?? i.quantity,
      quantity: i.quantity,
      unit_cost: i.unit_cost ?? i.product?.cost_price ?? null,
      cost_price: i.product?.cost_price ?? null,
      last_price: null,
      last_order: null,
    })));
    await this.loadLastPrices(true);
    this.loading.set(false);
  }

  private async loadLastPrices(prefill: boolean): Promise<void> {
    const supplier = this.supplierId();
    const ids = this.lines().map(l => l.product_id);
    if (!supplier || !ids.length) {
      this.lines.update(ls => ls.map(l => ({ ...l, last_price: null, last_order: null })));
      return;
    }
    const { data } = await supabase.rpc('last_purchase_prices', { p_supplier_id: supplier, p_product_ids: ids });
    const map = new Map<string, { unit_cost: number; order_number: string }>();
    for (const r of (data ?? []) as { product_id: string; unit_cost: number; order_number: string }[]) map.set(r.product_id, r);
    this.lines.update(ls => ls.map(l => {
      const last = map.get(l.product_id);
      return {
        ...l,
        last_price: last ? Number(last.unit_cost) : null,
        last_order: last?.order_number ?? null,
        unit_cost: prefill && last && l.unit_cost === l.cost_price ? Number(last.unit_cost) : l.unit_cost,
      };
    }));
  }

  onSupplierChange(id: string): void { this.supplierId.set(id); void this.loadLastPrices(true); }
  setQty(l: ReviewLine, value: string): void { this.patch(l, { quantity: Math.max(0, Math.floor(Number(value) || 0)) }); }
  setPrice(l: ReviewLine, value: string): void {
    const s = value.trim().replace(',', '.'); const n = s === '' ? null : Number(s);
    this.patch(l, { unit_cost: n === null || !Number.isFinite(n) || n < 0 ? null : Math.round(n * 100) / 100 });
  }
  useLastPrice(l: ReviewLine): void { if (l.last_price !== null) this.patch(l, { unit_cost: l.last_price }); }
  resetQty(l: ReviewLine): void { this.patch(l, { quantity: l.requested_qty }); }
  remove(l: ReviewLine): void { this.lines.update(ls => ls.filter(x => x.product_id !== l.product_id)); }
  private patch(l: ReviewLine, change: Partial<ReviewLine>): void {
    this.lines.update(ls => ls.map(x => x.product_id === l.product_id ? { ...x, ...change } : x));
  }

  async openAdd(): Promise<void> {
    this.addOpen.set(!this.addOpen());
    if (!this.addOpen() || this.catalog().length || !this.objectId()) return;
    const { data } = await supabase.from('object_products')
      .select('product:products ( id, sku, name, cost_price, active )').eq('object_id', this.objectId()!);
    this.catalog.set(((data ?? []) as any[]).map(r => r.product).filter(p => p && p.active !== false).sort((a,b) => a.name.localeCompare(b.name)));
  }

  add(p: ProductOption): void {
    this.lines.update(ls => [...ls, {
      order_item_id: null, product_id: p.id, sku: p.sku, name: p.name,
      requested_qty: 0, quantity: 1, unit_cost: p.cost_price, cost_price: p.cost_price,
      last_price: null, last_order: null,
    }]);
    this.addSearch.set(''); void this.loadLastPrices(false);
  }

  async save(approve: boolean): Promise<void> {
    if (!this.canSave()) { this.toast.error('Every line needs a quantity and a purchase price.'); return; }
    if (approve && !this.supplierId()) { this.toast.error('Select a supplier before approving.'); return; }
    if (approve) {
      const t = this.totals();
      const ok = await this.confirm.ask({
        title: `Approve ${this.orderNumber()}?`,
        message: `${this.lines().length} lines · ${t.units} units · ${t.value.toFixed(2)} ${this.currency()}. Prices and quantities are locked after approval.`,
        confirmLabel: 'Approve order',
      });
      if (!ok) return;
    }
    this.saving.set(true);
    const { error } = await supabase.rpc('review_order', {
      p_order_id: this.orderId(), p_supplier_id: this.supplierId() || null,
      p_comment: this.comment(),
      p_lines: this.lines().map(l => ({ order_item_id: l.order_item_id, product_id: l.product_id, quantity: l.quantity, unit_cost: l.unit_cost })),
      p_approve: approve,
    });
    this.saving.set(false);
    if (error) { this.toast.error(error.message); return; }
    this.toast.success(approve ? `${this.orderNumber()} approved.` : 'Changes saved.');
    if (approve) await this.router.navigate(['/orders'], { queryParams: { focus: this.orderId() } });
    else await this.load(this.orderId());
  }

  signedDiff(l: ReviewLine): string { const d=l.quantity-l.requested_qty; return d>0?`+${d}`:`${d}`; }
}
