import {
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { supabase } from '../../core/supabase/supabase.client';
import { AuthService } from '../../core/auth/auth.service';
import { BusinessObject } from '../objects/object.model';
import {
  StockTransferService,
  TransferProduct,
} from './stock-transfer.service';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { LocationPickerComponent } from '../../shared/ui/location-picker.component';

interface TransferBasketLine extends TransferProduct {
  quantity: number;
  sourceAfter: number;
  destinationAfter: number;
}

interface CompletedTransfer {
  reference: string | null;
  sourceObjectId: string;
  sourceName: string;
  destinationObjectId: string;
  destinationName: string;
  reason: string;
  units: number;
  lines: TransferBasketLine[];
}

@Component({
  selector: 'app-stock-transfer',
  standalone: true,
  imports: [LocationPickerComponent],
  templateUrl: './stock-transfer.component.html',
  styles: [`
    @keyframes rowIn {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }

    .row-in {
      animation: rowIn .45s cubic-bezier(.2,.8,.2,1) backwards;
    }

    @keyframes pop {
      0% {
        transform: scale(.6);
        opacity: 0;
      }
      60% {
        transform: scale(1.10);
      }
      100% {
        transform: scale(1);
        opacity: 1;
      }
    }

    .pop {
      animation: pop .3s cubic-bezier(.2,.8,.2,1);
    }

    @keyframes bump {
      0% {
        transform: scale(1);
      }
      40% {
        transform: scale(1.22);
      }
      100% {
        transform: scale(1);
      }
    }

    .bump {
      animation: bump .25s ease-out;
    }

    .sk {
      position: relative;
      overflow: hidden;
      background: #f1f5f9;
      border-radius: .5rem;
    }

    .sk::after {
      content: '';
      position: absolute;
      inset: 0;
      transform: translateX(-100%);
      background: linear-gradient(
        90deg,
        transparent,
        rgba(255,255,255,.7),
        transparent
      );
      animation: shimmer 1.3s infinite;
    }

    @keyframes shimmer {
      100% {
        transform: translateX(100%);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .row-in,
      .pop,
      .bump,
      .sk::after {
        animation: none;
      }
    }
  `],
})
export class StockTransferComponent implements OnInit {
  readonly svc = inject(StockTransferService);
  readonly auth = inject(AuthService);

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly isAdmin = computed(() => this.auth.isAdmin());

  // -------------------------------------------------------------------
  // Stores
  // -------------------------------------------------------------------

  readonly objects = signal<BusinessObject[]>([]);
  readonly sourceObjectId = signal('');
  readonly destinationObjectId = signal('');

  readonly sourceObject = computed(() =>
    this.objects().find(
      (object) => object.id === this.sourceObjectId()
    ) ?? null
  );

  readonly destinationObject = computed(() =>
    this.objects().find(
      (object) => object.id === this.destinationObjectId()
    ) ?? null
  );

  readonly sourceName = computed(() =>
    this.sourceObject()?.name ?? 'Source store'
  );

  readonly destinationName = computed(() =>
    this.destinationObject()?.name ?? 'Destination store'
  );

  readonly destinationObjects = computed(() =>
    this.objects().filter(
      (object) => object.id !== this.sourceObjectId()
    )
  );

  // -------------------------------------------------------------------
  // Transfer state
  // -------------------------------------------------------------------

  readonly step = signal<'basket' | 'done'>('basket');
  readonly cart = signal<Record<string, number>>({});
  readonly reason = signal('');
  readonly productSearch = signal('');
  readonly transferError = signal<string | null>(null);
  readonly bumpId = signal<string | null>(null);
  readonly completedTransfer =
    signal<CompletedTransfer | null>(null);

  // -------------------------------------------------------------------
  // Initial load
  // -------------------------------------------------------------------

  async ngOnInit(): Promise<void> {
    const requestedSource =
      this.route.snapshot.queryParamMap.get('from');

    const { data, error } = await supabase
      .from('objects')
      .select('*')
      .eq('active', true)
      .order('name');

    if (error) {
      this.transferError.set(error.message);
      return;
    }

    const objects = (data ?? []) as BusinessObject[];
    this.objects.set(objects);

    const profile = this.auth.profile();

    const sourceId = this.isAdmin()
      ? (
          objects.find(
            (object) => object.id === requestedSource
          )?.id ??
          objects[0]?.id ??
          ''
        )
      : (
          profile?.object_id ??
          ''
        );

    this.sourceObjectId.set(sourceId);

    const destinationId =
      objects.find(
        (object) => object.id !== sourceId
      )?.id ?? '';

    this.destinationObjectId.set(destinationId);

    if (sourceId && destinationId) {
      await this.loadProducts();
    }

    this.focusScanner();
  }

  // -------------------------------------------------------------------
  // Store selection
  // -------------------------------------------------------------------

  async changeSource(objectId: string): Promise<void> {
    if (!this.isAdmin()) return;
    if (!objectId || objectId === this.sourceObjectId()) return;

    this.sourceObjectId.set(objectId);

    if (this.destinationObjectId() === objectId) {
      const nextDestination =
        this.objects().find(
          (object) => object.id !== objectId
        )?.id ?? '';

      this.destinationObjectId.set(nextDestination);
    }

    this.resetBasket();

    await this.loadProducts();

    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        from: objectId,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });

    this.focusScanner();
  }

  async changeDestination(objectId: string): Promise<void> {
    if (!objectId || objectId === this.destinationObjectId()) {
      return;
    }

    

    if (objectId === this.sourceObjectId()) {
      this.transferError.set(
        'Source and destination stores must be different.'
      );
      return;
    }

    this.destinationObjectId.set(objectId);
    this.resetBasket();

    await this.loadProducts();

    this.focusScanner();
  }

  async swapLocations(): Promise<void> {
  const sourceId = this.sourceObjectId();
  const destinationId = this.destinationObjectId();

  if (!sourceId || !destinationId) return;

  // Seller ne sme da promeni source sa svoje prodavnice.
  if (!this.isAdmin()) return;

  this.sourceObjectId.set(destinationId);
  this.destinationObjectId.set(sourceId);

  this.resetBasket();

  await this.loadProducts();

  void this.router.navigate([], {
    relativeTo: this.route,
    queryParams: {
      from: destinationId,
    },
    queryParamsHandling: 'merge',
    replaceUrl: true,
  });

  this.focusScanner();
}

  private async loadProducts(): Promise<void> {
    const sourceId = this.sourceObjectId();
    const destinationId = this.destinationObjectId();

    if (!sourceId || !destinationId) {
      this.svc.clear();
      return;
    }

    await this.svc.loadTransferableProducts(
      sourceId,
      destinationId
    );

    if (this.svc.error()) {
      this.transferError.set(this.svc.error());
    }
  }

  // -------------------------------------------------------------------
  // Product picker and barcode
  // -------------------------------------------------------------------

  readonly filteredProducts = computed(() => {
    const query =
      this.productSearch()
        .trim()
        .toLowerCase();

    const products = this.svc.products().filter((product) =>
      !query ||
      product.name.toLowerCase().includes(query) ||
      product.sku.toLowerCase().includes(query) ||
      (product.barcode ?? '').includes(query)
    );

    return [...products].sort((a, b) =>
      Number(b.sourceQty > 0) -
        Number(a.sourceQty > 0) ||
      b.sourceQty - a.sourceQty ||
      a.name.localeCompare(b.name)
    );
  });

  onProductSearch(value: string): void {
    this.productSearch.set(value);
    this.transferError.set(null);
  }

  /**
   * USB/Bluetooth scanners behave like keyboards:
   * barcode characters followed by Enter.
   *
   * Exact SKU/barcode wins. A partial name/SKU search uses the first
   * matching product with available stock.
   */
  onProductEnter(event: Event): void {
    event.preventDefault();

    const raw = this.productSearch().trim();
    const normalized = raw.toLowerCase();

    if (!raw) return;

    const list = this.filteredProducts();

    const target =
      list.find(
        (product) =>
          (
            product.sku.toLowerCase() === normalized ||
            product.barcode === raw
          ) &&
          this.quantity(product) < product.sourceQty
      ) ??
      list.find(
        (product) =>
          this.quantity(product) < product.sourceQty
      );

    if (!target) {
      this.transferError.set(
        `No transferable stock found for "${raw}".`
      );

      this.productSearch.set('');
      this.focusScanner();
      return;
    }

    this.addProduct(target, 1);
    this.productSearch.set('');
    this.focusScanner();
  }

  private focusScanner(): void {
    setTimeout(() => {
      document
        .getElementById('transfer-scan')
        ?.focus();
    }, 60);
  }

  // -------------------------------------------------------------------
  // Basket
  // -------------------------------------------------------------------

  quantity(product: TransferProduct): number {
    return this.cart()[product.productId] ?? 0;
  }

  addProduct(
    product: TransferProduct,
    delta: number
  ): void {
    const current = this.quantity(product);

    const next = Math.max(
      0,
      Math.min(
        product.sourceQty,
        current + delta
      )
    );

    if (next === current) {
      if (
        delta > 0 &&
        current >= product.sourceQty
      ) {
        this.transferError.set(
          `Only ${product.sourceQty} units of ${product.name} are available at ${this.sourceName()}.`
        );
      }

      return;
    }

    this.cart.update((currentCart) => ({
      ...currentCart,
      [product.productId]: next,
    }));

    this.transferError.set(null);
    this.bumpId.set(null);

    setTimeout(() => {
      this.bumpId.set(product.productId);
    });
  }

  removeProduct(productId: string): void {
    this.cart.update((currentCart) => ({
      ...currentCart,
      [productId]: 0,
    }));

    this.transferError.set(null);
  }

  clearBasket(): void {
    this.cart.set({});
    this.transferError.set(null);
    this.productSearch.set('');
    this.focusScanner();
  }

  readonly basketLines = computed<TransferBasketLine[]>(() => {
    const cart = this.cart();

    return this.svc.products()
      .filter(
        (product) =>
          (cart[product.productId] ?? 0) > 0
      )
      .map((product) => {
        const quantity =
          cart[product.productId];

        return {
          ...product,
          quantity,
          sourceAfter:
            product.sourceQty - quantity,
          destinationAfter:
            product.destinationQty + quantity,
        };
      })
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name)
      );
  });

  readonly totalProducts = computed(() =>
    this.basketLines().length
  );

  readonly totalUnits = computed(() =>
    this.basketLines().reduce(
      (total, line) =>
        total + line.quantity,
      0
    )
  );

  readonly canSubmit = computed(() =>
    !!this.sourceObjectId() &&
    !!this.destinationObjectId() &&
    this.sourceObjectId() !==
      this.destinationObjectId() &&
    this.totalUnits() > 0 &&
    !!this.reason().trim() &&
    !this.svc.saving()
  );

  // -------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------

  async submit(): Promise<void> {
    if (this.svc.saving()) return;

    const sourceId =
      this.sourceObjectId();

    const destinationId =
      this.destinationObjectId();

    if (!sourceId || !destinationId) {
      this.transferError.set(
        'Select both source and destination stores.'
      );
      return;
    }

    if (sourceId === destinationId) {
      this.transferError.set(
        'Source and destination stores must be different.'
      );
      return;
    }

    const lines = this.basketLines();

    if (!lines.length) {
      this.transferError.set(
        'Add at least one product to the transfer.'
      );
      return;
    }

    const cleanReason =
      this.reason().trim();

    if (!cleanReason) {
      this.transferError.set(
        'A reason is required for a stock transfer.'
      );
      return;
    }

    const confirmed = await this.confirm.ask({
      title: 'Transfer stock?',
      message:
        `${this.totalUnits()} unit(s) across ` +
        `${this.totalProducts()} product(s) will move from ` +
        `${this.sourceName()} to ${this.destinationName()}.`,
      confirmLabel: 'Transfer stock',
      tone: 'default',
    });

    if (!confirmed) return;

    this.transferError.set(null);

    const snapshot = lines.map(
      (line) => ({ ...line })
    );

    const { reference, error } =
      await this.svc.recordTransfer(
        sourceId,
        destinationId,
        cleanReason,
        snapshot.map((line) => ({
          product_id: line.productId,
          quantity: line.quantity,
        }))
      );

    if (error) {
      this.transferError.set(error);
      this.toast.error(error);
      return;
    }

    this.completedTransfer.set({
      reference,
      sourceObjectId: sourceId,
      sourceName: this.sourceName(),
      destinationObjectId: destinationId,
      destinationName:
        this.destinationName(),
      reason: cleanReason,
      units: snapshot.reduce(
        (total, line) =>
          total + line.quantity,
        0
      ),
      lines: snapshot,
    });

    this.step.set('done');

    this.toast.success(
      `${this.totalUnits()} unit(s) transferred to ${this.destinationName()}.`
    );
  }

  // -------------------------------------------------------------------
  // After completion
  // -------------------------------------------------------------------

  async newTransfer(): Promise<void> {
    this.step.set('basket');
    this.completedTransfer.set(null);
    this.resetBasket();

    await this.loadProducts();

    this.focusScanner();
  }

  referenceLabel(reference: string | null): string {
    if (!reference) return '';

    const id = reference.startsWith('transfer:')
      ? reference.slice('transfer:'.length)
      : reference;

    return id.slice(0, 8);
  }

  cancel(): void {
    void this.router.navigate(
      ['/inventory'],
      {
        queryParams: this.sourceObjectId()
          ? {
              object:
                this.sourceObjectId(),
            }
          : {},
      }
    );
  }

  openDestinationInventory(): void {
    const destinationId =
      this.destinationObjectId();

    void this.router.navigate(
      ['/inventory'],
      {
        queryParams: destinationId
          ? {
              object: destinationId,
            }
          : {},
      }
    );
  }

  private resetBasket(): void {
    this.cart.set({});
    this.reason.set('');
    this.productSearch.set('');
    this.transferError.set(null);
    this.bumpId.set(null);
  }
}