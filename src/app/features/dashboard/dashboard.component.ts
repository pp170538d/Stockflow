import { Component, computed, inject, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { DashboardService } from './dashboard.service';
import { Order, OrderStatus } from '../orders/order.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [DatePipe, RouterLink, BadgeComponent, EmptyStateComponent],
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent implements OnInit {
  readonly auth = inject(AuthService);
  readonly svc = inject(DashboardService);

  ngOnInit(): void {
    this.svc.load();
  }

  // For the status bar chart — each segment's % of total orders
  readonly chart = computed(() => {
    const s = this.svc.stats();
    const total = s.totalOrders || 1; // avoid divide-by-zero
    return [
      { label: 'Pending',   value: s.pending,   pct: (s.pending / total) * 100,   color: 'bg-amber-400',  text: 'text-amber-600' },
      { label: 'Approved',  value: s.approved,  pct: (s.approved / total) * 100,  color: 'bg-blue-400',   text: 'text-blue-600' },
      { label: 'Delivered', value: s.delivered, pct: (s.delivered / total) * 100, color: 'bg-green-400',  text: 'text-green-600' },
      { label: 'Rejected',  value: s.rejected,  pct: (s.rejected / total) * 100,  color: 'bg-red-400',    text: 'text-red-600' },
    ];
  });

  tone(status: OrderStatus): 'warning' | 'info' | 'success' | 'error' {
    return { PENDING: 'warning' as const, APPROVED: 'info' as const,
             DELIVERED: 'success' as const, REJECTED: 'error' as const }[status];
  }

  itemCount(o: Order): number {
    return o.order_items?.reduce((sum, i) => sum + i.quantity, 0) ?? 0;
  }
}