import {
  Component,
  ElementRef,
  HostListener,
  computed,
  input,
  output,
  signal,
} from '@angular/core';

export interface LocationPickerItem {
  id: string;
  name: string;
}

type LocationPickerTone = 'source' | 'destination' | 'neutral';

@Component({
  selector: 'app-location-picker',
  standalone: true,
  template: `
    <div class="relative">

      <!-- ======================= TRIGGER ======================= -->
      <button
        type="button"
        (click)="toggle()"
        (keydown.arrowdown)="openWithKeyboard($event)"
        [attr.aria-expanded]="open()"
        aria-haspopup="listbox"
        class="flex h-11 w-full items-center gap-3 rounded-xl border bg-white px-3 text-left text-sm outline-none transition"
        [class]="triggerClass()">

        <span
          class="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
          [class]="iconClass()">

          <svg
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round">

            <path d="M3 21V9l9-5 9 5v12M2 21h20M8 21v-7h8v7"/>
          </svg>
        </span>

        <span class="min-w-0 flex-1">
          @if (selectedLocation(); as selectedLocation) {
            <span class="block truncate font-semibold text-slate-900">
              {{ selectedLocation.name }}
            </span>
          } @else {
            <span class="text-slate-400">
              Select location
            </span>
          }
        </span>

        <svg
          class="h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200"
          [class.rotate-180]="open()"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round">

          <path d="m6 9 6 6 6-6"/>
        </svg>

      </button>


      <!-- ======================= DROPDOWN ======================= -->
      @if (open()) {

        <div
          class="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl bg-white shadow-xl shadow-slate-900/10 ring-1 ring-slate-200"
          role="listbox">

          <!-- Search stays visible while the results scroll -->
          <div class="sticky top-0 z-10 border-b border-slate-100 bg-white p-2">

            <div class="relative">

              <svg
                class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round">

                <circle cx="11" cy="11" r="7"/>
                <path d="m21 21-4.3-4.3"/>
              </svg>

              <input
                #searchInput
                type="text"
                autocomplete="off"
                [value]="search()"
                (input)="onSearch($any($event.target).value)"
                (keydown.arrowdown)="moveActive(1, $event)"
                (keydown.arrowup)="moveActive(-1, $event)"
                (keydown.enter)="chooseActive($event)"
                (keydown.escape)="close($event)"
                placeholder="Search locations..."
                class="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none transition focus:border-brand-500 focus:bg-white focus:ring-2 focus:ring-brand-500/10" />

            </div>

          </div>


          <!-- Results -->
          <div class="max-h-64 overflow-y-auto p-1.5">

            @if (filteredLocations().length === 0) {

              <div class="px-3 py-8 text-center">

                <div class="text-sm font-medium text-slate-700">
                  No locations found
                </div>

                <div class="mt-1 text-xs text-slate-400">
                  Try another search term.
                </div>

              </div>

            } @else {

              @for (location of filteredLocations(); track location.id; let i = $index) {

                <button
                  type="button"
                  role="option"
                  [attr.aria-selected]="location.id === selectedId()"
                  [id]="'location-option-' + location.id"
                  (mouseenter)="activeIndex.set(i)"
                  (click)="choose(location.id)"
                  class="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition"
                  [class]="rowClass(location.id, i)">

                  <span
                    class="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                    [class]="rowIconClass(location.id)">

                    <svg
                      class="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round">

                      <path d="M3 21V9l9-5 9 5v12M2 21h20M8 21v-7h8v7"/>
                    </svg>

                  </span>


                  <span class="min-w-0 flex-1">

                    <span class="block truncate text-sm font-medium text-slate-800">
                      {{ location.name }}
                    </span>

                    @if (location.id === selectedId()) {
                      <span class="mt-0.5 block text-[10px] font-medium uppercase tracking-wide"
                        [class]="selectedTextClass()">
                        Selected
                      </span>
                    }

                  </span>


                  @if (location.id === selectedId()) {

                    <svg
                      class="h-4 w-4 shrink-0"
                      [class]="checkClass()"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.2"
                      stroke-linecap="round"
                      stroke-linejoin="round">

                      <path d="M5 12l4 4L19 6"/>
                    </svg>

                  } @else if (i === activeIndex()) {

                    <svg
                      class="h-4 w-4 shrink-0 text-slate-300"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round">

                      <path d="m9 18 6-6-6-6"/>
                    </svg>

                  }

                </button>

              }

            }

          </div>


          <!-- Footer -->
          <div class="border-t border-slate-100 bg-slate-50 px-3 py-2">

            <div class="flex items-center justify-between gap-3 text-[11px] text-slate-400">

              <span>
                @if (search().trim()) {
                  Showing
                  <b class="font-semibold text-slate-600">
                    {{ filteredLocations().length }}
                  </b>
                  of
                  <b class="font-semibold text-slate-600">
                    {{ availableLocations().length }}
                  </b>
                  locations
                } @else {
                  {{ availableLocations().length }}
                  {{ availableLocations().length === 1 ? 'location' : 'locations' }}
                }
              </span>

              <span class="hidden items-center gap-2 sm:flex">
                <kbd class="rounded border border-slate-200 bg-white px-1 py-0.5 text-[9px]">
                  ↑↓
                </kbd>
                navigate

                <kbd class="rounded border border-slate-200 bg-white px-1 py-0.5 text-[9px]">
                  ↵
                </kbd>
                select
              </span>

            </div>

          </div>

        </div>

      }

    </div>
  `,
})
export class LocationPickerComponent {

  readonly locations = input.required<LocationPickerItem[]>();
  readonly selectedId = input<string>('');
  readonly excludeId = input<string>('');
  readonly tone = input<LocationPickerTone>('neutral');

  readonly selected = output<string>();

  readonly open = signal(false);
  readonly search = signal('');
  readonly activeIndex = signal(0);

  constructor(
    private host: ElementRef<HTMLElement>
  ) {}


  // -------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------

  readonly selectedLocation = computed(() =>
    this.locations().find(
      location => location.id === this.selectedId()
    ) ?? null
  );


  readonly availableLocations = computed(() => {
    const excluded = this.excludeId();

    return this.locations().filter(
      location => location.id !== excluded
    );
  });


  readonly filteredLocations = computed(() => {
    const q = this.search().trim().toLowerCase();

    return this.availableLocations()
      .filter(location =>
        !q ||
        location.name.toLowerCase().includes(q)
      );
  });


  // -------------------------------------------------------------------
  // Styling
  // -------------------------------------------------------------------

  readonly triggerClass = computed(() => {
    switch (this.tone()) {
      case 'source':
        return 'border-rose-200 hover:border-rose-300 focus:border-rose-400 focus:ring-4 focus:ring-rose-100';

      case 'destination':
        return 'border-emerald-200 hover:border-emerald-300 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100';

      default:
        return 'border-slate-300 hover:border-slate-400 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10';
    }
  });


  readonly iconClass = computed(() => {
    switch (this.tone()) {
      case 'source':
        return 'bg-rose-50 text-rose-500';

      case 'destination':
        return 'bg-emerald-50 text-emerald-600';

      default:
        return 'bg-slate-100 text-slate-500';
    }
  });


  readonly checkClass = computed(() => {
    switch (this.tone()) {
      case 'source':
        return 'text-rose-500';

      case 'destination':
        return 'text-emerald-600';

      default:
        return 'text-brand-600';
    }
  });


  readonly selectedTextClass = computed(() => {
    switch (this.tone()) {
      case 'source':
        return 'text-rose-500';

      case 'destination':
        return 'text-emerald-600';

      default:
        return 'text-brand-600';
    }
  });


  rowClass(locationId: string, index: number): string {
    if (locationId === this.selectedId()) {
      switch (this.tone()) {
        case 'source':
          return 'bg-rose-50 hover:bg-rose-50';

        case 'destination':
          return 'bg-emerald-50 hover:bg-emerald-50';

        default:
          return 'bg-brand-50 hover:bg-brand-50';
      }
    }

    if (index === this.activeIndex()) {
      return 'bg-slate-100';
    }

    return 'hover:bg-slate-50';
  }


  rowIconClass(locationId: string): string {
    if (locationId === this.selectedId()) {
      switch (this.tone()) {
        case 'source':
          return 'bg-rose-100 text-rose-600';

        case 'destination':
          return 'bg-emerald-100 text-emerald-600';

        default:
          return 'bg-brand-100 text-brand-600';
      }
    }

    return 'bg-slate-100 text-slate-500';
  }


  // -------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------

  toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }

    this.openPicker();
  }


  openWithKeyboard(event: Event): void {
    event.preventDefault();

    if (!this.open()) {
      this.openPicker();
    }
  }


  private openPicker(): void {
    this.search.set('');

    const selectedIndex =
      this.filteredLocations().findIndex(
        location => location.id === this.selectedId()
      );

    this.activeIndex.set(
      selectedIndex >= 0 ? selectedIndex : 0
    );

    this.open.set(true);

    setTimeout(() => {
      this.host.nativeElement
        .querySelector<HTMLInputElement>('input')
        ?.focus();

      this.scrollActiveIntoView();
    });
  }


  close(event?: Event): void {
    event?.preventDefault();

    this.open.set(false);
    this.search.set('');
    this.activeIndex.set(0);
  }


  // -------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------

  onSearch(value: string): void {
    this.search.set(value);
    this.activeIndex.set(0);
  }


  // -------------------------------------------------------------------
  // Keyboard navigation
  // -------------------------------------------------------------------

  moveActive(
    direction: 1 | -1,
    event: Event
  ): void {
    event.preventDefault();

    const list = this.filteredLocations();

    if (!list.length) return;

    let next =
      this.activeIndex() + direction;

    if (next < 0) {
      next = list.length - 1;
    }

    if (next >= list.length) {
      next = 0;
    }

    this.activeIndex.set(next);

    this.scrollActiveIntoView();
  }


  chooseActive(event: Event): void {
    event.preventDefault();

    const location =
      this.filteredLocations()[
        this.activeIndex()
      ];

    if (!location) return;

    this.choose(location.id);
  }


  private scrollActiveIntoView(): void {
    setTimeout(() => {
      const location =
        this.filteredLocations()[
          this.activeIndex()
        ];

      if (!location) return;

      document
        .getElementById(
          `location-option-${location.id}`
        )
        ?.scrollIntoView({
          block: 'nearest',
        });
    });
  }


  // -------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------

  choose(id: string): void {
    this.selected.emit(id);
    this.close();
  }


  // -------------------------------------------------------------------
  // Outside click
  // -------------------------------------------------------------------

  @HostListener(
    'document:click',
    ['$event']
  )
  onDocumentClick(event: MouseEvent): void {
    const target =
      event.target as Node | null;

    if (
      target &&
      !this.host.nativeElement.contains(target)
    ) {
      this.close();
    }
  }

}