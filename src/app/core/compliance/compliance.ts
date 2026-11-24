import { Injectable, computed, signal } from '@angular/core';
import { supabase } from '../supabase/supabase.client';

/**
 * Compliance profile = country-specific layer on top of the universal
 * receiving model. It only changes labels, allowed document types and
 * (later) deadlines/connectors. Business logic never branches on country
 * anywhere else in the app.
 */
export type ComplianceProfile = 'NONE' | 'SERBIA';
export type DispatchDocumentType = 'E_OTPREMNICA' | 'DELIVERY_NOTE' | 'ASN' | 'OTHER';

export const COMPLIANCE_PROFILES: { value: ComplianceProfile; label: string; hint: string }[] = [
  { value: 'NONE', label: 'None (generic)', hint: 'Delivery notes and receiving confirmations, no statutory deadlines.' },
  { value: 'SERBIA', label: 'Serbia', hint: 'e-Otpremnica / e-Prijemnica references and Serbian deadlines.' },
];

const TYPE_LABELS: Record<DispatchDocumentType, string> = {
  E_OTPREMNICA: 'e-Otpremnica',
  DELIVERY_NOTE: 'Delivery note',
  ASN: 'ASN (advance shipping notice)',
  OTHER: 'Other',
};

export function dispatchTypeLabel(t: string | null | undefined): string {
  return t ? TYPE_LABELS[t as DispatchDocumentType] ?? t : 'No external document';
}

export function dispatchTypesFor(p: ComplianceProfile): DispatchDocumentType[] {
  return p === 'SERBIA'
    ? ['E_OTPREMNICA', 'DELIVERY_NOTE', 'ASN', 'OTHER']
    : ['DELIVERY_NOTE', 'ASN', 'OTHER'];
}

export function receiptAckLabelFor(p: ComplianceProfile | string | null | undefined): string {
  return p === 'SERBIA' ? 'e-Prijemnica' : 'Receipt acknowledgement';
}

export function legalSystemHintFor(p: ComplianceProfile | string | null | undefined): string {
  return p === 'SERBIA'
    ? 'Reference only · the legal document lives in SEO or your e-document system.'
    : 'Reference only · Stockflow does not issue the legal document.';
}

@Injectable({ providedIn: 'root' })
export class ComplianceService {
  readonly profile = signal<ComplianceProfile>('NONE');
  private loaded = false;

  readonly isSerbia = computed(() => this.profile() === 'SERBIA');
  readonly receiptAckLabel = computed(() => receiptAckLabelFor(this.profile()));
  readonly legalHint = computed(() => legalSystemHintFor(this.profile()));
  readonly dispatchTypes = computed(() =>
    dispatchTypesFor(this.profile()).map((value) => ({ value, label: TYPE_LABELS[value] })));

  async ensureLoaded(force = false): Promise<void> {
    if (this.loaded && !force) return;
    const { data, error } = await supabase.rpc('app_compliance_profile');
    if (!error && (data === 'NONE' || data === 'SERBIA')) this.profile.set(data);
    this.loaded = true;
  }

  /** Called by Settings right after a successful save. */
  set(p: ComplianceProfile): void {
    this.profile.set(p);
    this.loaded = true;
  }
}
