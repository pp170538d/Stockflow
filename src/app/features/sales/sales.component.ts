import { Component, inject, signal, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { supabase } from '../../core/supabase/supabase.client';
import { SalesService } from './sales.service';
import { BusinessObject } from '../objects/object.model';

interface RangeOption {
  label: string;
  days: number | null;
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
  readonly selectedObjectId = signal<string>('');
  readonly rangeDays = signal<number | null>(30);
  readonly search = signal<string>('');

  readonly ranges: RangeOption[] = [
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
    { label: 'All', days: null },
  ];

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  async ngOnInit(): Promise<void> {
    const { data } = await supabase
      .from('objects')
      .select('*')
      .eq('active', true)
      .order('name');

    this.objects.set((data ?? []) as BusinessObject[]);
    await this.reload(1);
  }

  async reload(page = 1): Promise<void> {
    await this.svc.load({
      page,
      objectId: this.selectedObjectId(),
      rangeDays: this.rangeDays(),
      search: this.search(),
    });
  }

  onObjectChange(objectId: string): void {
    this.selectedObjectId.set(objectId);
    void this.reload(1);
  }

  onRangeChange(days: number | null): void {
    this.rangeDays.set(days);
    void this.reload(1);
  }

  onSearch(value: string): void {
    this.search.set(value);

    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }

    this.searchTimer = setTimeout(() => {
      void this.reload(1);
    }, 250);
  }

  previous(): void {
    void this.svc.previous({
      objectId: this.selectedObjectId(),
      rangeDays: this.rangeDays(),
      search: this.search(),
    });
  }

  next(): void {
    void this.svc.next({
      objectId: this.selectedObjectId(),
      rangeDays: this.rangeDays(),
      search: this.search(),
    });
  }
}