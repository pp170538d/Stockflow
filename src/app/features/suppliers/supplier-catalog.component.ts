import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Supplier, SupplierCatalogCandidate, SupplierCatalogPatch, SupplierCatalogRow, SupplierCatalogStatus, SupplierPerformance } from './supplier.model';
import { SuppliersService } from './suppliers.service';
import { ToastService } from '../../shared/ui/toast.service';
import { ConfirmService } from '../../shared/ui/confirm.service';

const PAGE = 50;

@Component({
  selector: 'app-supplier-catalog',
  standalone: true,
  imports: [DatePipe, DecimalPipe, PercentPipe, FormsModule, RouterLink],
  templateUrl: './supplier-catalog.component.html',
})
export class SupplierCatalogComponent implements OnInit {
  readonly supplier = signal<Supplier | null>(null);
  private route = inject(ActivatedRoute);

  readonly svc = inject(SuppliersService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly rows = signal<SupplierCatalogRow[]>([]);
  readonly total = signal(0);
  readonly counts = signal({ active: 0, inactive: 0, preferred: 0 });
  readonly performance = signal<SupplierPerformance | null>(null);
  readonly performanceLoading = signal(false);
  readonly performanceDays = signal(90);
  readonly status = signal<SupplierCatalogStatus>('active');
  readonly search = signal('');
  readonly page = signal(1);
  readonly selected = signal<Set<string>>(new Set());
  readonly editingId = signal<string | null>(null);
  readonly editSupplierSku = signal('');
  readonly editLead = signal<number | null>(null);
  readonly editMinPacks = signal(1);
  readonly editPack = signal(1);
  readonly saving = signal(false);

  // Assign-products panel
  readonly assignOpen = signal(false);
  readonly candidateLoading = signal(false);
  readonly candidates = signal<SupplierCatalogCandidate[]>([]);
  readonly candidateTotal = signal(0);
  readonly candidateCategories = signal<string[]>([]);
  readonly candidateSearch = signal('');
  readonly candidateCategory = signal<string>('');
  readonly candidatePage = signal(1);
  readonly candidateSelected = signal<Set<string>>(new Set());
  readonly selectAllMatching = signal(false);
  readonly assigning = signal(false);

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private candidateTimer: ReturnType<typeof setTimeout> | null = null;

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / PAGE)));
  readonly candidatePages = computed(() => Math.max(1, Math.ceil(this.candidateTotal() / PAGE)));
  readonly allPageSelected = computed(() =>
    this.rows().length > 0 && this.rows().every((r) => this.selected().has(r.id))
  );
  readonly allCandidatePageSelected = computed(() =>
    this.candidates().length > 0 && this.candidates().every((r) => this.candidateSelected().has(r.product_id))
  );

  async ngOnInit(): Promise<void> {
    const supplierId = this.route.snapshot.paramMap.get('id');
    if (!supplierId) {
      this.error.set('Supplier not found.');
      return;
    }

    if (!this.svc.suppliers().length) {
      await this.svc.load();
    }

    const supplier = this.svc.suppliers().find((x) => x.id === supplierId) ?? null;
    if (!supplier) {
      this.error.set('Supplier not found.');
      return;
    }

    this.supplier.set(supplier);
    await Promise.all([this.loadCatalog(), this.loadPerformance()]);
  }

  async loadPerformance(): Promise<void> {
    const s = this.supplier(); if (!s) return;
    this.performanceLoading.set(true);
    const result = await this.svc.performance(s.id, this.performanceDays());
    this.performanceLoading.set(false);
    if (result.error) { this.toast.error(result.error); return; }
    this.performance.set(result.data);
  }
  setPerformanceDays(days: number): void { this.performanceDays.set(days); void this.loadPerformance(); }
  priceTrendClass(value: number | null): string {
    if (value === null || Math.abs(value) < 0.05) return 'text-slate-500';
    return value > 0 ? 'text-red-600' : 'text-green-700';
  }
  priceTrendText(value: number | null): string {
    if (value === null) return '—';
    if (Math.abs(value) < 0.05) return '→ 0.0%';
    return `${value > 0 ? '↑' : '↓'} ${Math.abs(value).toFixed(1)}%`;
  }

  async loadCatalog(): Promise<void> {
    const s = this.supplier();
    if (!s) return;
    this.loading.set(true);
    this.error.set(null);
    const result = await this.svc.catalog(s.id, this.search(), this.status(), PAGE, (this.page() - 1) * PAGE);
    this.loading.set(false);
    if (result.error || !result.data) {
      this.error.set(result.error ?? 'Could not load supplier catalog.');
      return;
    }
    this.rows.set(result.data.rows);
    this.total.set(result.data.total);
    this.counts.set(result.data.counts);
    this.selected.set(new Set());
  }

  setStatus(status: SupplierCatalogStatus): void {
    this.status.set(status);
    this.page.set(1);
    void this.loadCatalog();
  }

  onSearch(value: string): void {
    this.search.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page.set(1);
      void this.loadCatalog();
    }, 250);
  }

  goPage(page: number): void {
    this.page.set(Math.max(1, Math.min(this.totalPages(), page)));
    void this.loadCatalog();
  }

  toggle(id: string): void {
    this.selected.update((old) => {
      const next = new Set(old);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  togglePage(): void {
    const ids = this.rows().map((r) => r.id);
    this.selected.update((old) => {
      const next = new Set(old);
      const remove = ids.every((id) => next.has(id));
      ids.forEach((id) => remove ? next.delete(id) : next.add(id));
      return next;
    });
  }

  startEdit(r: SupplierCatalogRow): void {
    this.editingId.set(r.id);
    this.editSupplierSku.set(r.supplier_sku ?? '');
    this.editLead.set(r.lead_time_days);
    this.editMinPacks.set(r.minimum_packs);
    this.editPack.set(r.pack_size);
  }

  /** "24 units · 2 × 12" — the rule in one line. */
  ruleText(packSize: number, minPacks: number): string {
    const units = packSize * minPacks;
    if (packSize === 1 && minPacks === 1) return 'Any quantity';
    if (packSize === 1) return `Min ${units} units`;
    return `Min ${units} units · ${minPacks} × ${packSize}`;
  }

  /** Valid quantities preview: 24, 36, 48 … */
  stepsText(packSize: number, minPacks: number): string {
    if (packSize === 1) return '';
    const start = packSize * minPacks;
    return `Orders in steps of ${packSize}: ${start}, ${start + packSize}, ${start + 2 * packSize}…`;
  }

  cancelEdit(): void { this.editingId.set(null); }

  async saveEdit(r: SupplierCatalogRow): Promise<void> {
    if (this.editMinPacks() < 1 || this.editPack() < 1 || (this.editLead() !== null && (this.editLead()! < 0 || this.editLead()! > 365))) {
      this.toast.error('Pack size and minimum packs must be at least 1; lead time must be 0–365 days.');
      return;
    }
    const patch: SupplierCatalogPatch = {
      supplier_sku: this.editSupplierSku().trim() || null,
      lead_time_days: this.editLead(),
      minimum_packs: this.editMinPacks(),
      pack_size: this.editPack(),
    };
    this.saving.set(true);
    const err = await this.svc.updateCatalogProduct(r.id, patch);
    this.saving.set(false);
    if (err) { this.toast.error(err); return; }
    this.editingId.set(null);
    this.toast.success(`${r.product_name} updated.`);
    await this.loadCatalog();
  }

  async makePreferred(r: SupplierCatalogRow): Promise<void> {
    if (r.preferred) return;
    if (r.other_preferred_supplier) {
      const ok = await this.confirm.ask({
        title: 'Change preferred supplier?',
        message: `${r.other_preferred_supplier} is currently preferred for ${r.product_name}. This will move the preference to ${this.supplier()?.name}.`,
        confirmLabel: 'Make preferred',
      });
      if (!ok) return;
    }
    const err = await this.svc.setCatalogPreferred([r.id], true);
    if (err) { this.toast.error(err); return; }
    this.toast.success(`${this.supplier()?.name} is now preferred for ${r.product_name}.`);
    await this.loadCatalog();
  }

  async bulkPreferred(): Promise<void> {
    const ids = [...this.selected()];
    if (!ids.length) return;
    const err = await this.svc.setCatalogPreferred(ids, true);
    if (err) { this.toast.error(err); return; }
    this.toast.success(`${ids.length} product${ids.length === 1 ? '' : 's'} updated.`);
    await this.loadCatalog();
  }

  async bulkActive(active: boolean): Promise<void> {
    const ids = [...this.selected()];
    if (!ids.length) return;
    if (!active) {
      const ok = await this.confirm.ask({
        title: `Deactivate ${ids.length} catalog ${ids.length === 1 ? 'product' : 'products'}?`,
        message: 'Products stay in purchase-order history but will not be offered for new supplier assignments.',
        confirmLabel: 'Deactivate',
        tone: 'danger',
      });
      if (!ok) return;
    }
    const err = await this.svc.setCatalogActive(ids, active);
    if (err) { this.toast.error(err); return; }
    this.toast.success(`${ids.length} catalog ${ids.length === 1 ? 'product' : 'products'} ${active ? 'activated' : 'deactivated'}.`);
    await this.loadCatalog();
  }

  // ---------- Assign products ----------
  async openAssign(): Promise<void> {
    this.assignOpen.set(true);
    this.candidateSearch.set('');
    this.candidateCategory.set('');
    this.candidatePage.set(1);
    this.candidateSelected.set(new Set());
    this.selectAllMatching.set(false);
    await this.loadCandidates();
  }

  closeAssign(): void {
    this.assignOpen.set(false);
    this.candidateSelected.set(new Set());
    this.selectAllMatching.set(false);
  }

  async loadCandidates(): Promise<void> {
    const s = this.supplier(); if (!s) return;
    this.candidateLoading.set(true);
    const result = await this.svc.catalogCandidates(
      s.id, this.candidateSearch(), this.candidateCategory() || null, PAGE, (this.candidatePage() - 1) * PAGE
    );
    this.candidateLoading.set(false);
    if (result.error || !result.data) { this.toast.error(result.error ?? 'Could not load products.'); return; }
    this.candidates.set(result.data.rows);
    this.candidateTotal.set(result.data.total);
    this.candidateCategories.set(result.data.categories);
    if (!this.selectAllMatching()) this.candidateSelected.set(new Set());
  }

  onCandidateSearch(value: string): void {
    this.candidateSearch.set(value);
    this.selectAllMatching.set(false);
    if (this.candidateTimer) clearTimeout(this.candidateTimer);
    this.candidateTimer = setTimeout(() => { this.candidatePage.set(1); void this.loadCandidates(); }, 250);
  }

  setCandidateCategory(value: string): void {
    this.candidateCategory.set(value);
    this.selectAllMatching.set(false);
    this.candidatePage.set(1);
    void this.loadCandidates();
  }

  candidateGoPage(page: number): void {
    this.candidatePage.set(Math.max(1, Math.min(this.candidatePages(), page)));
    void this.loadCandidates();
  }

  toggleCandidate(id: string): void {
    this.selectAllMatching.set(false);
    this.candidateSelected.update((old) => {
      const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next;
    });
  }

  toggleCandidatePage(): void {
    this.selectAllMatching.set(false);
    const ids = this.candidates().map((r) => r.product_id);
    this.candidateSelected.update((old) => {
      const next = new Set(old); const remove = ids.every((id) => next.has(id));
      ids.forEach((id) => remove ? next.delete(id) : next.add(id)); return next;
    });
  }

  chooseAllMatching(): void {
    this.candidateSelected.set(new Set());
    this.selectAllMatching.set(true);
  }

  selectedCandidateCount(): number {
    return this.selectAllMatching() ? this.candidateTotal() : this.candidateSelected().size;
  }

  async assign(): Promise<void> {
    const s = this.supplier(); if (!s || !this.selectedCandidateCount()) return;
    this.assigning.set(true);
    const err = await this.svc.assignCatalogProducts(s.id, [...this.candidateSelected()], {
      allMatching: this.selectAllMatching(), search: this.candidateSearch(), category: this.candidateCategory() || null,
    });
    this.assigning.set(false);
    if (err) { this.toast.error(err); return; }
    const n = this.selectedCandidateCount();
    this.toast.success(`${n} product${n === 1 ? '' : 's'} assigned to ${s.name}.`);
    this.closeAssign();
    await this.loadCatalog();
  }
}
