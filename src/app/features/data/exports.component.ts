import { Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { supabase } from '../../core/supabase/supabase.client';
import {
  EVENT_LABELS, MovementEvent, PeriodKey,
  customRange, exportMovements, exportSales, periodRange,
} from '../../core/data/export-io';

interface Loc { id: string; name: string; }

@Component({
  selector: 'app-exports',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './exports.component.html',
})
export class ExportsComponent implements OnInit {
  readonly periods: { key: PeriodKey; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: '7d', label: 'Last 7 days' },
    { key: 'month', label: 'This month' },
    { key: 'last-month', label: 'Last month' },
    { key: 'custom', label: 'Custom' },
  ];
  readonly events = Object.entries(EVENT_LABELS) as [MovementEvent, string][];

  readonly period = signal<PeriodKey>('month');
  readonly customFrom = signal('');
  readonly customTo = signal('');
  readonly objectId = signal<string>('');           // '' = all locations
  readonly selectedEvents = signal<Set<MovementEvent>>(new Set());
  readonly locations = signal<Loc[]>([]);

  readonly busy = signal<'sales' | 'movements' | null>(null);
  readonly error = signal<string | null>(null);
  readonly done = signal<string | null>(null);

  readonly range = computed(() =>
    this.period() === 'custom'
      ? customRange(this.customFrom(), this.customTo())
      : periodRange(this.period() as Exclude<PeriodKey, 'custom'>)
  );

  readonly rangeLabel = computed(() => {
    const r = this.range();
    if (!r) return 'Pick both dates';
    const last = new Date(r.to.getTime() - 1);
    const f = (d: Date) => d.toLocaleDateString('sr-Latn-RS');
    return f(r.from) === f(last) ? f(r.from) : `${f(r.from)} – ${f(last)}`;
  });

  async ngOnInit(): Promise<void> {
    const { data } = await supabase.from('objects').select('id, name').order('name');
    this.locations.set((data ?? []) as Loc[]);
  }

  toggleEvent(e: MovementEvent): void {
    const next = new Set(this.selectedEvents());
    next.has(e) ? next.delete(e) : next.add(e);
    this.selectedEvents.set(next);
  }

  async run(kind: 'sales' | 'movements'): Promise<void> {
    const r = this.range();
    if (!r || this.busy()) return;

    this.busy.set(kind);
    this.error.set(null);
    this.done.set(null);

    const objectId = this.objectId() || null;
    const filter = {
      from: r.from,
      to: r.to,
      objectId,
      objectName: this.locations().find((l) => l.id === objectId)?.name ?? null,
      events: [...this.selectedEvents()],
    };

    const err = kind === 'sales' ? await exportSales(filter) : await exportMovements(filter);
    this.busy.set(null);

    if (err) this.error.set(err);
    else this.done.set(kind === 'sales' ? 'Sales exported.' : 'Movements exported.');
  }
}
