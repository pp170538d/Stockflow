import { Injectable, signal } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { Order } from '../orders/order.model';

export interface DashboardStats {
  objects: number;
  products: number;
  pending: number;
  approved: number;
  delivered: number;
  rejected: number;
  totalOrders: number;
}

@Injectable({ providedIn: 'root' })
export class DashboardService {
  readonly stats = signal<DashboardStats>({
    objects: 0, products: 0, pending: 0, approved: 0,
    delivered: 0, rejected: 0, totalOrders: 0,
  });
  readonly recentOrders = signal<Order[]>([]);
  readonly loading = signal<boolean>(false);

  async load(): Promise<void> {
    this.loading.set(true);

    // Counts run in parallel — head:true fetches count only (no rows = fast)
    const [objectsC, productsC, pendingC, approvedC, deliveredC, rejectedC, ordersC, recent] =
      await Promise.all([
        supabase.from('objects').select('*', { count: 'exact', head: true }).eq('active', true),
        supabase.from('products').select('*', { count: 'exact', head: true }).eq('active', true),
        supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'PENDING'),
        supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'APPROVED'),
        supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'DELIVERED'),
        supabase.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'REJECTED'),
        supabase.from('orders').select('*', { count: 'exact', head: true }),
        supabase
          .from('orders')
          .select('*, object:objects ( name ), order_items ( id, quantity, product:products ( name ) )')
          .order('created_at', { ascending: false })
          .limit(5),
      ]);

    this.stats.set({
      objects: objectsC.count ?? 0,
      products: productsC.count ?? 0,
      pending: pendingC.count ?? 0,
      approved: approvedC.count ?? 0,
      delivered: deliveredC.count ?? 0,
      rejected: rejectedC.count ?? 0,
      totalOrders: ordersC.count ?? 0,
    });

    this.recentOrders.set((recent.data ?? []) as unknown as Order[]);
    this.loading.set(false);
  }
}