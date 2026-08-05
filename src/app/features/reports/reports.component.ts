import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { supabase } from '../../core/supabase/supabase.client';
import { ReportsService } from './reports.service';
import { BusinessObject } from '../objects/object.model';

export interface RangeOption {
  label: string;
  days: number;
}

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [],
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

  /**
   * Bar-chart data: fixed PIXEL heights (percentage heights need an explicit
   * parent height). Labels are thinned so the axis never gets crowded.
   */
  readonly bars = computed(() => {
    const data = this.svc.buckets();
    const max = Math.max(1, ...data.map((d) => d.count));
    const today = new Date().toISOString().slice(0, 10);
    const CHART_H = 140; // px — the drawable bar area
    const n = data.length;
    const step = Math.max(1, Math.round(n / 12)); // ~12 labels max

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
}
