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
    // INSERT is different from UPDATE: a failing WITH CHECK does raise 42501,
    // so a null error here really means the row was written.
    const { error } = await supabase.from('products').insert(input);
    if (error) return this.friendly(error.message);
    await this.load();
    return null;
  }

  async update(id: string, input: ProductInput): Promise<string | null> {
    const { data, error } = await supabase
      .from('products')
      .update(input)
      .eq('id', id)
      .select('id');

    if (error) return this.friendly(error.message);
    if (!data || data.length === 0) return this.BLOCKED;

    await this.load();
    return null;
  }

  async deactivate(id: string): Promise<string | null> {
    const { data, error } = await supabase
      .from('products')
      .update({ active: false })
      .eq('id', id)
      .select('id');

    if (error) return this.friendly(error.message);
    if (!data || data.length === 0) return this.BLOCKED;

    await this.load();
    return null;
  }

  async activate(id: string): Promise<string | null> {
    const { data, error } = await supabase
      .from('products')
      .update({ active: true })
      .eq('id', id)
      .select('id');

    if (error) return this.friendly(error.message);
    if (!data || data.length === 0) return this.BLOCKED;

    await this.load();
    return null;
  }

  /**
   * An UPDATE blocked by a row-level security policy does NOT raise an error
   * in PostgREST — the policy acts as a filter, so the statement simply
   * matches zero rows and returns success. Asking for the updated rows back
   * with .select() is the only way to tell "blocked" apart from "written".
   *
   * An empty result can also mean the row was deleted by someone else, but
   * for this catalogue the demo lockdown is by far the likelier cause.
   */
  private readonly BLOCKED = 'This action is disabled in the demo account.';

  /** Turn Postgres errors into human messages. */
  private friendly(msg: string): string {
    if (msg.includes('DEMO_READONLY') || msg.includes('row-level security')) {
      return this.BLOCKED;
    }
    if (msg.includes('duplicate key') || msg.includes('products_sku_key')) {
      return 'A product with this SKU already exists. SKUs must be unique.';
    }
    return msg;
  }
}
