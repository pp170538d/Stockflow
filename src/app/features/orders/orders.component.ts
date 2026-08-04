import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AuthService } from '../../core/auth/auth.service';
import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-orders',
  standalone: true,
  imports: [DatePipe, RouterLink, BadgeComponent, EmptyStateComponent],
  templateUrl: './orders.component.html',
})
export class OrdersComponent implements OnInit {
  readonly svc = inject(OrdersService);
  readonly auth = inject(AuthService);

  readonly statusFilter = signal<OrderStatus | ''>('');
  readonly statuses: OrderStatus[] = ['PENDING', 'APPROVED', 'DELIVERED', 'REJECTED'];

  readonly filtered = computed(() => {
    const s = this.statusFilter();
    const list = this.svc.orders();
    return s ? list.filter((o) => o.status === s) : list;
  });

  ngOnInit(): void {
    this.svc.load();
  }

  tone(status: OrderStatus): 'warning' | 'info' | 'success' | 'error' {
    return {
      PENDING: 'warning' as const,
      APPROVED: 'info' as const,
      DELIVERED: 'success' as const,
      REJECTED: 'error' as const,
    }[status];
  }

  itemCount(o: Order): number {
    return o.order_items?.reduce((sum, i) => sum + i.quantity, 0) ?? 0;
  }

  async setStatus(o: Order, status: OrderStatus): Promise<void> {
    await this.svc.setStatus(o.id, status);
  }
}