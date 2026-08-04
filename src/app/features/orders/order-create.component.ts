import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { OrdersService } from './orders.service';
import { Product } from '../products/product.model';
import { BusinessObject } from '../objects/object.model';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';

interface CartLine { product: Product; qty: number; }

@Component({
  selector: 'app-order-create',
  standalone: true,
  imports: [RouterLink, EmptyStateComponent],
  templateUrl: './order-create.component.html',
})
export class OrderCreateComponent implements OnInit {
  private auth = inject(AuthService);
  private orders = inject(OrdersService);
  private router = inject(Router);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly objects = signal<BusinessObject[]>([]);
  readonly products = signal<Product[]>([]);
  readonly selectedObjectId = signal<string | null>(null);
  readonly search = signal('');
  readonly comment = signal('');

  // cart: product_id -> line
  readonly cart = signal<Map<string, CartLine>>(new Map());

  readonly isAdmin = computed(() => this.auth.isAdmin());

  readonly filteredProducts = computed(() => {
    const q = this.search().trim().toLowerCase();
    const list = this.products();
    if (!q) return list;
    return list.filter(
      (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
    );
  });

  readonly cartLines = computed(() => Array.from(this.cart().values()));
  readonly totalItems = computed(() =>
    this.cartLines().reduce((s, l) => s + l.qty, 0)
  );

  async ngOnInit(): Promise<void> {
    const profile = this.auth.profile();

    // Admins can order for any object; sellers are locked to their own.
    if (this.isAdmin()) {
      const { data } = await supabase
        .from('objects').select('*').eq('active', true).order('name');
      this.objects.set((data ?? []) as BusinessObject[]);
    } else {
      this.selectedObjectId.set(profile?.object_id ?? null);
    }

    if (this.selectedObjectId()) {
      await this.loadProducts(this.selectedObjectId()!);
    }
    this.loading.set(false);
  }

  async onObjectChange(objectId: string): Promise<void> {
    this.selectedObjectId.set(objectId);
    this.cart.set(new Map());
    await this.loadProducts(objectId);
  }

  /** Load only products assigned to this object. */
  private async loadProducts(objectId: string): Promise<void> {
    const { data, error } = await supabase
      .from('object_products')
      .select('product:products ( id, sku, name, category, active, created_at )')
      .eq('object_id', objectId);

    if (error) { this.error.set(error.message); return; }
    const prods = (data ?? [])
      .map((r: any) => r.product)
      .filter((p: Product) => p && p.active);
    this.products.set(prods as Product[]);
  }

  inCart(id: string): boolean { return this.cart().has(id); }
  qtyOf(id: string): number { return this.cart().get(id)?.qty ?? 0; }

  add(product: Product): void {
    const m = new Map(this.cart());
    const line = m.get(product.id);
    if (line) line.qty++;
    else m.set(product.id, { product, qty: 1 });
    this.cart.set(m);
  }

  setQty(id: string, qty: number): void {
    const m = new Map(this.cart());
    const line = m.get(id);
    if (!line) return;
    if (qty <= 0) m.delete(id);
    else line.qty = qty;
    this.cart.set(m);
  }

  remove(id: string): void {
    const m = new Map(this.cart());
    m.delete(id);
    this.cart.set(m);
  }

  async submit(): Promise<void> {
    const objectId = this.selectedObjectId();
    const profile = this.auth.profile();
    if (!objectId || !profile || this.cartLines().length === 0) return;

    this.saving.set(true);
    this.error.set(null);

    const lines = this.cartLines().map((l) => ({
      product_id: l.product.id,
      quantity: l.qty,
    }));

    const err = await this.orders.create(
      objectId, profile.id, this.comment().trim() || null, lines
    );

    this.saving.set(false);
    if (err) this.error.set(err);
    else this.router.navigateByUrl('/orders');
  }
}