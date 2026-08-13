import {
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  computed,
  inject,
  signal,
} from '@angular/core';
import { StockHistoryPoint, StockHistoryService } from './stock-history.service';

type Preset = 7 | 30 | 90 | 365 | null | 'custom';
type Granularity = 'hour' | 'day' | 'week' | 'month';

interface TrendPoint {
  occurredAt: string;
  balance: number;
  openingBalance: number;
  netChange: number;
  movementCount: number;
  x: number;
  y: number;
}

interface AxisTick {
  value: number;
  y: number;
}

interface DateTick {
  value: string;
  label: string;
  x: number;
}

@Component({
  selector: 'app-stock-history-dialog',
  standalone: true,
  imports: [],
  templateUrl: './stock-history-dialog.component.html',
})
export class StockHistoryDialogComponent implements OnChanges {
  private readonly svc = inject(StockHistoryService);

  @Input() open = false;
  @Input() objectId: string | null = null;
  @Input() objectName = '';
  @Input() productId: string | null = null;
  @Input() productName = '';
  @Input() sku = '';
  @Output() closed = new EventEmitter<void>();

  readonly loading = this.svc.loading;
  readonly error = this.svc.error;
  readonly preset = signal<Preset>(null);
  readonly customFrom = signal('');
  readonly customTo = signal('');
  readonly dateError = signal<string | null>(null);
  readonly activePoint = signal<TrendPoint | null>(null);

  readonly width = 1000;
  readonly height = 330;
  readonly plotLeft = 76;
  readonly plotRight = 28;
  readonly plotTop = 20;
  readonly plotBottom = 52;

  readonly rawPoints = computed(() => this.svc.points());

  readonly granularity = computed<Granularity>(() => {
    const rangeDays = this.selectedRangeDays();
    if (rangeDays <= 7) return 'hour';
    if (rangeDays <= 120) return 'day';
    if (rangeDays <= 730) return 'week';
    return 'month';
  });

  readonly trendSource = computed(() =>
    this.buildContinuousSeries(this.rawPoints(), this.granularity())
  );

  readonly yDomain = computed(() => {
    const source = this.trendSource();
    if (!source.length) return { min: 0, max: 1, step: 1 };

    const balances = source.map((point) => point.balance);
    const rawMin = Math.min(0, ...balances);
    const rawMax = Math.max(0, ...balances);
    const span = Math.max(1, rawMax - rawMin);
    const padding = Math.max(1, Math.ceil(span * 0.08));
    const paddedMin = rawMin < 0 ? rawMin - padding : 0;
    const paddedMax = rawMax + padding;
    const step = this.niceStep(Math.max(1, paddedMax - paddedMin) / 4);

    return {
      min: Math.floor(paddedMin / step) * step,
      max: Math.ceil(paddedMax / step) * step,
      step,
    };
  });

  readonly points = computed<TrendPoint[]>(() => {
    const source = this.trendSource();
    if (!source.length) return [];

    const times = source.map((point) => new Date(point.occurredAt).getTime());
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const { min: minY, max: maxY } = this.yDomain();
    const plotWidth = this.width - this.plotLeft - this.plotRight;
    const plotHeight = this.height - this.plotTop - this.plotBottom;

    return source.map((point, index) => ({
      ...point,
      x:
        maxTime === minTime
          ? this.plotLeft + plotWidth / 2
          : this.plotLeft + ((times[index] - minTime) / (maxTime - minTime)) * plotWidth,
      y:
        maxY === minY
          ? this.plotTop + plotHeight / 2
          : this.plotTop + ((maxY - point.balance) / (maxY - minY)) * plotHeight,
    }));
  });

  readonly linePath = computed(() => {
    const points = this.points();
    if (!points.length) return '';
    return points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
      .join(' ');
  });

  readonly areaPath = computed(() => {
    const points = this.points();
    if (!points.length) return '';
    const baseline = this.height - this.plotBottom;
    return `${this.linePath()} L ${points.at(-1)!.x} ${baseline} L ${points[0].x} ${baseline} Z`;
  });

  readonly yTicks = computed<AxisTick[]>(() => {
    if (!this.trendSource().length) return [];
    const { min, max, step } = this.yDomain();
    const plotHeight = this.height - this.plotTop - this.plotBottom;
    const ticks: AxisTick[] = [];

    for (let value = min; value <= max + step / 2; value += step) {
      ticks.push({
        value,
        y: this.plotTop + ((max - value) / Math.max(1, max - min)) * plotHeight,
      });
    }
    return ticks;
  });

  readonly xTicks = computed<DateTick[]>(() => {
    const points = this.points();
    if (!points.length) return [];

    const start = new Date(points[0].occurredAt).getTime();
    const end = new Date(points.at(-1)!.occurredAt).getTime();
    const duration = Math.max(1, end - start);
    const plotWidth = this.width - this.plotLeft - this.plotRight;
    const count = this.axisTickCount();

    return Array.from({ length: count }, (_, index) => {
      const ratio = count === 1 ? 0 : index / (count - 1);
      const time = start + ratio * duration;
      return {
        value: new Date(time).toISOString(),
        label: this.formatAxisDate(time, duration),
        x: this.plotLeft + ratio * plotWidth,
      };
    });
  });

  readonly openingStock = computed(() => this.rawPoints()[0]?.balance ?? 0);
  readonly closingStock = computed(() => this.rawPoints().at(-1)?.balance ?? 0);
  readonly lowestStock = computed(() => {
    const values = this.rawPoints().map((point) => point.balance);
    return values.length ? Math.min(...values) : 0;
  });
  readonly highestStock = computed(() => {
    const values = this.rawPoints().map((point) => point.balance);
    return values.length ? Math.max(...values) : 0;
  });
  readonly movementCount = computed(() =>
    this.rawPoints().filter((point) => !point.isOpening).length
  );
  readonly stockLabel = computed(() =>
    this.isHistoricalEnd() ? 'Closing stock' : 'Current stock'
  );
  readonly rangeLabel = computed(() => {
    const points = this.rawPoints();
    if (!points.length) return '';

    const start = this.requestedRangeStart() ?? points[0].occurredAt;
    const end = this.requestedRangeEnd() ?? points.at(-1)!.occurredAt;
    const prefix =
      this.preset() === null
        ? 'All history'
        : this.preset() === 'custom'
          ? 'Custom range'
          : `Last ${this.preset()} days`;

    return `${prefix} · ${this.formatLongDate(start)} to ${this.formatLongDate(end)}`;
  });
  readonly granularityLabel = computed(() =>
    ({
      hour: 'Hourly stock snapshots',
      day: 'Daily stock snapshots',
      week: 'Weekly stock snapshots',
      month: 'Monthly stock snapshots',
    })[this.granularity()]
  );

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open'] && this.open) {
      this.preset.set(null);
      this.customFrom.set('');
      this.customTo.set('');
      this.dateError.set(null);
      this.activePoint.set(null);
      void this.reload();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open) this.close();
  }

  close(): void {
    this.activePoint.set(null);
    this.svc.clear();
    this.closed.emit();
  }

  async choosePreset(value: Exclude<Preset, 'custom'>): Promise<void> {
    this.preset.set(value);
    this.customFrom.set('');
    this.customTo.set('');
    this.dateError.set(null);
    this.activePoint.set(null);
    await this.reload();
  }

  async applyCustom(): Promise<void> {
    this.dateError.set(null);
    if (!this.customFrom() && !this.customTo()) return;

    if (this.customFrom() && this.customTo() && this.customFrom() > this.customTo()) {
      this.dateError.set('Start date must be before end date.');
      return;
    }

    this.preset.set('custom');
    this.activePoint.set(null);
    await this.reload();
  }

  onChartPointer(event: PointerEvent, svg: Element): void {
    const points = this.points();
    if (!points.length) return;

    const rect = svg.getBoundingClientRect();
    const viewX = ((event.clientX - rect.left) / rect.width) * this.width;
    const clampedX = Math.max(this.plotLeft, Math.min(this.width - this.plotRight, viewX));

    let nearest = points[0];
    let distance = Math.abs(points[0].x - clampedX);

    for (let index = 1; index < points.length; index += 1) {
      const nextDistance = Math.abs(points[index].x - clampedX);
      if (nextDistance < distance) {
        nearest = points[index];
        distance = nextDistance;
      }
    }

    this.activePoint.set(nearest);
  }

  clearPointer(): void {
    if (!this.isTouchDevice()) this.activePoint.set(null);
  }

  formatInspectorDate(value: string): string {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...(this.granularity() === 'hour'
        ? { hour: '2-digit', minute: '2-digit' }
        : {}),
    }).format(new Date(value));
  }

  private buildContinuousSeries(
    points: StockHistoryPoint[],
    granularity: Granularity
  ): Omit<TrendPoint, 'x' | 'y'>[] {
    if (!points.length) return [];

    const opening = points[0];
    const movements = points
      .filter((point) => !point.isOpening)
      .sort(
        (a, b) =>
          new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()
      );

    const start = this.seriesStart(opening.occurredAt);
    const end = this.seriesEnd(points.at(-1)!.occurredAt);
    const buckets = new Map<string, StockHistoryPoint[]>();

    for (const movement of movements) {
      const key = this.bucketKey(movement.occurredAt, granularity);
      const bucket = buckets.get(key) ?? [];
      bucket.push(movement);
      buckets.set(key, bucket);
    }

    const result: Omit<TrendPoint, 'x' | 'y'>[] = [];
    let currentBalance = opening.balance;
    let cursor = this.floorToBucket(start, granularity);
    const finalBucket = this.floorToBucket(end, granularity);

    while (cursor.getTime() <= finalBucket.getTime()) {
      const key = this.bucketKey(cursor.toISOString(), granularity);
      const bucket = buckets.get(key) ?? [];
      const openingBalance = currentBalance;

      if (bucket.length) {
        bucket.sort(
          (a, b) =>
            new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()
        );
        currentBalance = bucket.at(-1)!.balance;
      }

      result.push({
        occurredAt: this.bucketDisplayTime(cursor, granularity).toISOString(),
        balance: currentBalance,
        openingBalance,
        netChange: currentBalance - openingBalance,
        movementCount: bucket.length,
      });

      cursor = this.addBucket(cursor, granularity);
    }

    return result;
  }

  private seriesStart(fallback: string): string {
    return this.requestedRangeStart() ?? fallback;
  }

  private seriesEnd(fallback: string): string {
    return this.requestedRangeEnd() ?? fallback;
  }

  private requestedRangeStart(): string | null {
    const selected = this.preset();

    if (typeof selected === 'number') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - selected + 1);
      return start.toISOString();
    }

    if (selected === 'custom' && this.customFrom()) {
      return new Date(`${this.customFrom()}T00:00:00`).toISOString();
    }

    return null;
  }

  private requestedRangeEnd(): string | null {
    if (this.preset() === 'custom' && this.customTo()) {
      return new Date(`${this.customTo()}T23:59:59.999`).toISOString();
    }

    if (typeof this.preset() === 'number') {
      return new Date().toISOString();
    }

    return null;
  }

  private floorToBucket(value: string, granularity: Granularity): Date {
    const date = new Date(value);
    date.setMinutes(0, 0, 0);

    if (granularity === 'hour') return date;

    date.setHours(0, 0, 0, 0);
    if (granularity === 'day') return date;

    if (granularity === 'week') {
      const day = (date.getDay() + 6) % 7;
      date.setDate(date.getDate() - day);
      return date;
    }

    date.setDate(1);
    return date;
  }

  private addBucket(value: Date, granularity: Granularity): Date {
    const next = new Date(value);

    if (granularity === 'hour') next.setHours(next.getHours() + 1);
    else if (granularity === 'day') next.setDate(next.getDate() + 1);
    else if (granularity === 'week') next.setDate(next.getDate() + 7);
    else next.setMonth(next.getMonth() + 1);

    return next;
  }

  private bucketDisplayTime(value: Date, granularity: Granularity): Date {
    const display = new Date(value);

    if (granularity === 'hour') display.setMinutes(59, 59, 999);
    else if (granularity === 'day') display.setHours(23, 59, 59, 999);
    else if (granularity === 'week') {
      display.setDate(display.getDate() + 6);
      display.setHours(23, 59, 59, 999);
    } else {
      display.setMonth(display.getMonth() + 1, 0);
      display.setHours(23, 59, 59, 999);
    }

    return display;
  }

  private bucketKey(value: string, granularity: Granularity): string {
    const date = this.floorToBucket(value, granularity);

    if (granularity === 'hour') {
      return `${date.getFullYear()}-${this.pad(date.getMonth() + 1)}-${this.pad(
        date.getDate()
      )}T${this.pad(date.getHours())}`;
    }

    if (granularity === 'month') {
      return `${date.getFullYear()}-${this.pad(date.getMonth() + 1)}`;
    }

    return `${date.getFullYear()}-${this.pad(date.getMonth() + 1)}-${this.pad(
      date.getDate()
    )}`;
  }

  private axisTickCount(): number {
    const range = this.selectedRangeDays();
    if (range <= 7) return 7;
    return 6;
  }

  private selectedRangeDays(): number {
    const preset = this.preset();
    if (typeof preset === 'number') return preset;

    if (preset === 'custom' && (this.customFrom() || this.customTo())) {
      const start = this.customFrom()
        ? new Date(`${this.customFrom()}T00:00:00`).getTime()
        : new Date(this.rawPoints()[0]?.occurredAt ?? Date.now()).getTime();
      const end = this.customTo()
        ? new Date(`${this.customTo()}T23:59:59.999`).getTime()
        : Date.now();
      return Math.max(1, Math.ceil((end - start) / 86_400_000));
    }

    const points = this.rawPoints();
    if (points.length < 2) return 1;

    return Math.max(
      1,
      Math.ceil(
        (new Date(points.at(-1)!.occurredAt).getTime() -
          new Date(points[0].occurredAt).getTime()) /
          86_400_000
      )
    );
  }

  private async reload(): Promise<void> {
    if (!this.objectId || !this.productId) return;

    const from = this.requestedRangeStart();
    const to = this.requestedRangeEnd();

    await this.svc.load(this.objectId, this.productId, from, to);
  }

  private isHistoricalEnd(): boolean {
    if (this.preset() !== 'custom' || !this.customTo()) return false;
    return new Date(`${this.customTo()}T23:59:59.999`).getTime() < Date.now();
  }

  private formatAxisDate(time: number, duration: number): string {
    const date = new Date(time);
    const day = 86_400_000;

    if (duration <= 2 * day) {
      return new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
    }

    if (duration <= 366 * day) {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
      }).format(date);
    }

    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      year: 'numeric',
    }).format(date);
  }

  private formatLongDate(value: string): string {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(value));
  }

  private niceStep(raw: number): number {
    if (raw <= 1) return 1;
    const power = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / power;
    if (normalized <= 1) return power;
    if (normalized <= 2) return 2 * power;
    if (normalized <= 5) return 5 * power;
    return 10 * power;
  }

  private pad(value: number): string {
    return String(value).padStart(2, '0');
  }

  private isTouchDevice(): boolean {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia('(pointer: coarse)').matches
    );
  }
}
