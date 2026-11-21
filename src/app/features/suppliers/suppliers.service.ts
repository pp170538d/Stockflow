import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import {
  Supplier, SupplierInput, SupplierCatalogStatus, SupplierCatalogResult,
  SupplierCatalogCandidatesResult, SupplierCatalogPatch, SupplierPerformance,
} from './supplier.model';

@Injectable({ providedIn: 'root' })
export class SuppliersService {
  readonly suppliers = signal<Supplier[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const { data, error } = await supabase
      .from('suppliers')
      .select('id, name, address, city, postal_code, country, tax_id, registration_number, order_email, phone, contact_name, active, created_at, updated_at')
      .order('active', { ascending: false })
      .order('name');
    this.loading.set(false);

    if (error) {
      this.error.set(friendly(error.message));
      return;
    }
    this.suppliers.set((data ?? []) as Supplier[]);
  }

  async save(id: string | null, input: SupplierInput): Promise<string | null> {
    const { error } = await supabase.rpc('save_supplier', {
      p_id: id,
      p_data: input,
    });
    if (error) return friendly(error.message);
    await this.load();
    return null;
  }

  async setActive(supplier: Supplier, active: boolean): Promise<string | null> {
    return this.save(supplier.id, {
      name: supplier.name,
      address: supplier.address,
      city: supplier.city,
      postal_code: supplier.postal_code,
      country: supplier.country,
      tax_id: supplier.tax_id,
      registration_number: supplier.registration_number,
      order_email: supplier.order_email,
      phone: supplier.phone,
      contact_name: supplier.contact_name,
      active,
    });
  }

  async catalog(supplierId: string, search = '', status: SupplierCatalogStatus = 'active', limit = 50, offset = 0): Promise<{ data: SupplierCatalogResult | null; error: string | null }> {
    const { data, error } = await supabase.rpc('supplier_catalog', { p_supplier_id: supplierId, p_search: search.trim() || null, p_status: status, p_limit: limit, p_offset: offset });
    return error ? { data: null, error: friendly(error.message) } : { data: data as SupplierCatalogResult, error: null };
  }

  async catalogCandidates(supplierId: string, search = '', category: string | null = null, limit = 50, offset = 0): Promise<{ data: SupplierCatalogCandidatesResult | null; error: string | null }> {
    const { data, error } = await supabase.rpc('supplier_catalog_candidates', { p_supplier_id: supplierId, p_search: search.trim() || null, p_category: category || null, p_limit: limit, p_offset: offset });
    return error ? { data: null, error: friendly(error.message) } : { data: data as SupplierCatalogCandidatesResult, error: null };
  }

  async assignCatalogProducts(supplierId: string, productIds: string[], opts?: { allMatching?: boolean; search?: string; category?: string | null }): Promise<string | null> {
    const { error } = await supabase.rpc('assign_supplier_products', { p_supplier_id: supplierId, p_product_ids: productIds.length ? productIds : null, p_all_matching: !!opts?.allMatching, p_search: opts?.search?.trim() || null, p_category: opts?.category || null, p_preferred_if_none: true });
    return error ? friendly(error.message) : null;
  }

  async updateCatalogProduct(id: string, patch: SupplierCatalogPatch): Promise<string | null> {
    const { error } = await supabase.rpc('update_supplier_product', { p_id: id, p_patch: patch });
    return error ? friendly(error.message) : null;
  }

  async setCatalogActive(ids: string[], active: boolean): Promise<string | null> {
    const { error } = await supabase.rpc('set_supplier_products_active', { p_ids: ids, p_active: active });
    return error ? friendly(error.message) : null;
  }

  async setCatalogPreferred(ids: string[], preferred: boolean): Promise<string | null> {
    const { error } = await supabase.rpc('set_preferred_supplier_products', { p_ids: ids, p_preferred: preferred });
    return error ? friendly(error.message) : null;
  }


  async performance(
    supplierId: string,
    days = 90
  ): Promise<{ data: SupplierPerformance | null; error: string | null }> {
    const { data, error } = await supabase.rpc('supplier_performance', {
      p_supplier_id: supplierId,
      p_days: days,
    });

    return error
      ? { data: null, error: friendly(error.message) }
      : { data: data as SupplierPerformance, error: null };
  }

}

function friendly(message: string): string {
  if (message.includes('suppliers_name_key') || message.includes('duplicate key')) {
    return 'A supplier with this name already exists.';
  }
  if (message.includes('Demo account')) return 'Supplier changes are disabled in the demo account.';
  if (message.includes('Only admin')) return 'Only an admin can manage suppliers.';
  return message;
}
