import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { supabase } from '../../core/supabase/supabase.client';
import { ReportsService, RunwayRow } from './reports.service';
import { BusinessObject } from '../objects/object.model';
import { BadgeComponent } from '../../shared/ui/badge.component';

export interface RangeOption {
  label: string;
  days: number;
}

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [DecimalPipe, BadgeComponent],
  templateUrl: './reports.component.html',
})
export class ReportsComponent implements OnInit {
  readonly svc = inject(ReportsService);

  readonly objects = signal<BusinessObject[]>([]);
  readonly selectedObjectId = signal<string>(''); // '' = all objects

  readonly ranges: RangeOption[] = [
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
  ];
  readonly rangeDays = signal<number>(30);

  async ngOnInit(): Promise<void> {
    const { data } = await supabase.from('objects').select('*').eq('active', true).order('name');
    this.objects.set((data ?? []) as BusinessObject[]);
    this.reload();
  }

  private reload(): void {
    this.svc.load(this.selectedObjectId() || null, this.rangeDays());
  }

  onObjectChange(id: string): void {
    this.selectedObjectId.set(id);
    this.reload();
  }

  onRangeChange(days: number): void {
    this.rangeDays.set(days);
    this.reload();
  }

  readonly scopeLabel = computed(() => {
    const id = this.selectedObjectId();
    if (!id) return 'All objects';
    return this.objects().find((o) => o.id === id)?.name ?? 'Object';
  });

  readonly maxUnits = computed(() =>
    Math.max(1, ...this.svc.topProducts().map((p) => p.unitsOut))
  );

  readonly bars = computed(() => {
    const data = this.svc.buckets();
    const max = Math.max(1, ...data.map((d) => d.count));
    const today = new Date().toISOString().slice(0, 10);
    const CHART_H = 140;
    const n = data.length;
    const step = Math.max(1, Math.round(n / 12));
    return data.map((d, i) => {
      const showLabel = i === n - 1 || i % step === 0;
      return {
        date: d.date,
        count: d.count,
        px: d.count === 0 ? 4 : Math.max(6, Math.round((d.count / max) * CHART_H)),
        label: showLabel ? d.label : '',
        isLast: i === n - 1,
        isToday: d.date === today,
      };
    });
  });

  readonly totalThroughput = computed(() =>
    this.svc.buckets().reduce((s, d) => s + d.count, 0)
  );

  readonly rangeLabel = computed(() => `last ${this.rangeDays()} days`);

  // ===== V7: Runway helpers =====

  /** Map an urgency level to a badge tone. */
  runwayTone(u: RunwayRow['urgency']): 'error' | 'warning' | 'success' | 'neutral' {
    return {
      out: 'error' as const,
      critical: 'error' as const,
      warning: 'warning' as const,
      healthy: 'success' as const,
      idle: 'neutral' as const,
    }[u] ?? 'neutral';
  }

  /** Actionable label — tells the user what to DO, not just a colour. */
  runwayLabel(u: RunwayRow['urgency']): string {
    return {
      out: 'Out of stock',
      critical: 'Reorder now',
      warning: 'Reorder soon',
      healthy: 'Healthy',
      idle: 'No recent sales',
    }[u] ?? '—';
  }
}