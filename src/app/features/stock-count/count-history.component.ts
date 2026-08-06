import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { StockCountService } from './stock-count.service';
import { StockCountSummary } from './stock-count.model';
import { BusinessObject } from '../objects/object.model';
import { BadgeComponent } from '../../shared/ui/badge.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state.component';
import { CountSummaryComponent } from './count-summary.component';

@Component({
  selector: 'app-count-history',
  standalone: true,
  imports: [DatePipe, RouterLink, BadgeComponent, EmptyStateComponent, CountSummaryComponent],
  templateUrl: './count-history.component.html',
})
export class CountHistoryComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  readonly svc = inject(StockCountService);
  readonly auth = inject(AuthService);

  readonly objects = signal<BusinessObject[]>([]);
  readonly objectId = signal<string | null>(null);
  readonly loading = signal(false);

  // Read-only detail drawer
  readonly detailOpen = signal(false);
  readonly detailCount = signal<StockCountSummary | null>(null);

  readonly isAdmin = computed(() => this.auth.isAdmin());

  async ngOnInit(): Promise<void> {
    const paramObject = this.route.snapshot.queryParamMap.get('object');
    if (this.isAdmin()) {
      const { data } = await supabase.from('objects').select('*').eq('active', true).order('name');
      this.objects.set((data ?? []) as BusinessObject[]);
      const chosen = paramObject ?? this.objects()[0]?.id ?? null;
      if (chosen) await this.selectObject(chosen);
    } else {
      const own = this.auth.profile()?.object_id ?? null;
      if (own) await this.selectObject(own);
    }
  }

  async selectObject(objectId: string): Promise<void> {
    this.objectId.set(objectId);
    this.loading.set(true);
    await this.svc.loadSummaries(objectId);
    this.loading.set(false);
  }

  hasVariance(s: StockCountSummary): boolean {
    return s.discrepancies > 0;
  }

  openDetail(s: StockCountSummary): void {
    this.detailCount.set(s);
    this.detailOpen.set(true);
  }

  closeDetail(): void {
    this.detailOpen.set(false);
    this.detailCount.set(null);
  }

  back(): void {
    this.router.navigate(['/inventory']);
  }
}
