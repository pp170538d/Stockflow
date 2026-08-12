import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { supabase } from '../../core/supabase/supabase.client';
import { SalesService } from './sales.service';
import { BusinessObject } from '../objects/object.model';

interface RangeOption {
  label: string;
  days: number | null;   // null = all time
}

@Component({
  selector: 'app-sales',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './sales.component.html',
})
export class SalesComponent implements OnInit {
  readonly svc = inject(SalesService);

  readonly objects = signal<BusinessObject[]>([]);
  readonly selectedObjectId = signal<string>('');   // '' = all objects

  readonly ranges: RangeOption[] = [
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
    { label: 'All', days: null },
  ];
  readonly rangeDays = signal<number | null>(30);

  readonly search = signal<string>('');

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

  onRangeChange(days: number | null): void {
    this.rangeDays.set(days);
    this.reload();
  }

  onSearch(value: string): void {
    this.search.set(value);
  }

  // Client-side filter across product name / sku / object / note.
  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const rows = this.svc.rows();
    if (!q) return rows;
    return rows.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      r.sku.toLowerCase().includes(q) ||
      r.objectName.toLowerCase().includes(q) ||
      (r.note ?? '').toLowerCase().includes(q)
    );
  });

  readonly scopeLabel = computed(() => {
    const id = this.selectedObjectId();
    if (!id) return 'All objects';
    return this.objects().find((o) => o.id === id)?.name ?? 'Object';
  });

  readonly rangeLabel = computed(() => {
    const d = this.rangeDays();
    return d === null ? 'all time' : `last ${d} days`;
  });
}
