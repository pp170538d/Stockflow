import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { Product, ProductInput } from './product.model';

@Injectable({ providedIn: 'root' })
export class ProductsService {
  readonly products = signal<Product[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) this.error.set(error.message);
    else this.products.set((data ?? []) as Product[]);
    this.loading.set(false);
  }

  async create(input: ProductInput): Promise<string | null> {
    const { error } = await supabase.from('products').insert(input);
    if (error) return this.friendly(error.message);
    await this.load();
    return null;
  }

  async update(id: string, input: ProductInput): Promise<string | null> {
    const { error } = await supabase.from('products').update(input).eq('id', id);
    if (error) return this.friendly(error.message);
    await this.load();
    return null;
  }

  async deactivate(id: string): Promise<string | null> {
    const { error } = await supabase.from('products').update({ active: false }).eq('id', id);
    if (error) return error.message;
    await this.load();
    return null;
  }

  async activate(id: string): Promise<string | null> {
    const { error } = await supabase.from('products').update({ active: true }).eq('id', id);
    if (error) return error.message;
    await this.load();
    return null;
  }

  /** Turn Postgres unique-violation into a human message. */
  private friendly(msg: string): string {
    if (msg.includes('duplicate key') || msg.includes('products_sku_key')) {
      return 'A product with this SKU already exists. SKUs must be unique.';
    }
    return msg;
  }
}