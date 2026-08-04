import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { BusinessObject, ObjectInput } from './object.model';

@Injectable({ providedIn: 'root' })
export class ObjectsService {
  readonly objects = signal<BusinessObject[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  /** Load all objects (admin sees all via RLS). */
  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const { data, error } = await supabase
      .from('objects')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      this.error.set(error.message);
    } else {
      this.objects.set((data ?? []) as BusinessObject[]);
    }
    this.loading.set(false);
  }

  /** Create a new object. */
  async create(input: ObjectInput): Promise<string | null> {
    const { error } = await supabase.from('objects').insert(input);
    if (error) return error.message;
    await this.load();
    return null;
  }

  /** Update an existing object. */
  async update(id: string, input: ObjectInput): Promise<string | null> {
    const { error } = await supabase.from('objects').update(input).eq('id', id);
    if (error) return error.message;
    await this.load();
    return null;
  }

  /** Soft-delete: flip active to false. */
  async deactivate(id: string): Promise<string | null> {
    const { error } = await supabase.from('objects').update({ active: false }).eq('id', id);
    if (error) return error.message;
    await this.load();
    return null;
  }

  /** Reactivate an object. */
  async activate(id: string): Promise<string | null> {
    const { error } = await supabase.from('objects').update({ active: true }).eq('id', id);
    if (error) return error.message;
    await this.load();
    return null;
  }
}