import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { Supplier, SupplierInput } from './supplier.model';

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
}

function friendly(message: string): string {
  if (message.includes('suppliers_name_key') || message.includes('duplicate key')) {
    return 'A supplier with this name already exists.';
  }
  if (message.includes('Demo account')) return 'Supplier changes are disabled in the demo account.';
  if (message.includes('Only admin')) return 'Only an admin can manage suppliers.';
  return message;
}
