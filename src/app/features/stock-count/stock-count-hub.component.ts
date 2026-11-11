import {
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { StockCountService } from './stock-count.service';
import { StockCountSummary } from './stock-count.model';
import { BusinessObject } from '../objects/object.model';
import { LocationPickerComponent } from '../../shared/ui/location-picker.component';

@Component({
  selector: 'app-stock-count-hub',
  standalone: true,
  imports: [
    DatePipe,
    RouterLink,
    LocationPickerComponent,
  ],
  templateUrl: './stock-count-hub.component.html',
})
export class StockCountHubComponent implements OnInit {
  readonly svc = inject(StockCountService);
  readonly auth = inject(AuthService);

  readonly objects = signal<BusinessObject[]>([]);
  readonly objectId = signal<string | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly isAdmin = computed(() => this.auth.isAdmin());

  readonly selectedObject = computed(() =>
    this.objects().find(
      (object) => object.id === this.objectId()
    ) ?? null
  );

  readonly objectName = computed(() =>
    this.selectedObject()?.name ?? 'Your location'
  );

  readonly recentCounts = computed(() =>
    this.svc.summaries().slice(0, 3)
  );

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    const profile = this.auth.profile();

    if (this.isAdmin()) {
      const { data, error } = await supabase
        .from('objects')
        .select('*')
        .eq('active', true)
        .order('name');

      if (error) {
        this.error.set(error.message);
        this.loading.set(false);
        return;
      }

      const objects = (data ?? []) as BusinessObject[];

      this.objects.set(objects);

      const initialObjectId =
        objects[0]?.id ?? null;

      if (initialObjectId) {
        await this.selectObject(initialObjectId);
      }
    } else {
      const ownObjectId =
        profile?.object_id ?? null;

      if (ownObjectId) {
        /*
         * Seller normally does not need the complete list.
         * Load the seller's own location so the hub can display its name.
         */
        const { data } = await supabase
          .from('objects')
          .select('*')
          .eq('id', ownObjectId)
          .maybeSingle();

        if (data) {
          this.objects.set([
            data as BusinessObject,
          ]);
        }

        await this.selectObject(ownObjectId);
      }
    }

    this.loading.set(false);
  }

  async selectObject(
    objectId: string
  ): Promise<void> {
    if (!objectId) return;

    this.objectId.set(objectId);
    this.loading.set(true);
    this.error.set(null);

    await this.svc.loadSummaries(objectId);

    this.loading.set(false);
  }

  hasVariance(
    count: StockCountSummary
  ): boolean {
    return count.discrepancies > 0;
  }

  countStatus(
    count: StockCountSummary
  ): string {
    if (count.discrepancies === 0) {
      return 'Everything matched';
    }

    return `${count.discrepancies} ${
      count.discrepancies === 1
        ? 'difference'
        : 'differences'
    }`;
  }

  countedBy(
    count: StockCountSummary
  ): string {
    return (
      count.counted_by?.trim() ||
      'Unknown counter'
    );
  }

  ago(iso: string): string {
    const seconds = Math.max(
      0,
      (
        Date.now() -
        new Date(iso).getTime()
      ) / 1000
    );

    if (seconds < 60) {
      return 'just now';
    }

    if (seconds < 3600) {
      return `${Math.floor(seconds / 60)}m ago`;
    }

    if (seconds < 86400) {
      return `${Math.floor(seconds / 3600)}h ago`;
    }

    if (seconds < 604800) {
      return `${Math.floor(seconds / 86400)}d ago`;
    }

    return new Date(iso).toLocaleDateString(
      'en-GB',
      {
        day: 'numeric',
        month: 'short',
        year:
          new Date(iso).getFullYear() !==
          new Date().getFullYear()
            ? 'numeric'
            : undefined,
      }
    );
  }
}