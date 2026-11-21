// =====================================================================
// Standardized variance reasons (mirrors the DB check constraints).
// The code drives reporting; the free-text note is optional context.
// =====================================================================

export type CountReasonCode =
  | 'FOUND_STOCK' | 'MISSING' | 'DAMAGED' | 'THEFT' | 'COUNT_ERROR' | 'OPENING_BALANCE' | 'OTHER';

export type DeliveryReasonCode =
  | 'SUPPLIER_SHORT' | 'SUPPLIER_OVER' | 'DAMAGED' | 'WRONG_ITEM' | 'OTHER';

export type ReasonCode = CountReasonCode | DeliveryReasonCode;

export interface ReasonOption<T extends string = ReasonCode> {
  code: T;
  label: string;
  hint: string;
}

export const REASON_LABELS: Record<ReasonCode, string> = {
  FOUND_STOCK: 'Found stock',
  MISSING: 'Missing',
  DAMAGED: 'Damaged',
  THEFT: 'Theft',
  COUNT_ERROR: 'Count error',
  OPENING_BALANCE: 'Opening balance',
  SUPPLIER_SHORT: 'Supplier short',
  SUPPLIER_OVER: 'Supplier over',
  WRONG_ITEM: 'Wrong item',
  OTHER: 'Other',
};

/** Shelf count: fewer units than the system expected. */
export const COUNT_SHORT_REASONS: ReasonOption<CountReasonCode>[] = [
  { code: 'MISSING', label: 'Missing', hint: 'Gone, cause unknown' },
  { code: 'DAMAGED', label: 'Damaged', hint: 'Broken or expired' },
  { code: 'THEFT', label: 'Theft', hint: 'Confirmed or suspected' },
  { code: 'COUNT_ERROR', label: 'Count error', hint: 'Earlier count was wrong' },
  { code: 'OTHER', label: 'Other', hint: 'Explain in the note' },
];

/** Shelf count: more units than the system expected. */
export const COUNT_OVER_REASONS: ReasonOption<CountReasonCode>[] = [
  { code: 'FOUND_STOCK', label: 'Found stock', hint: 'Back room, misplaced' },
  { code: 'COUNT_ERROR', label: 'Count error', hint: 'Earlier count was wrong' },
  { code: 'OTHER', label: 'Other', hint: 'Explain in the note' },
];

/** Delivery: fewer units than ordered. */
export const DELIVERY_SHORT_REASONS: ReasonOption<DeliveryReasonCode>[] = [
  { code: 'SUPPLIER_SHORT', label: 'Supplier short', hint: 'Short-shipped or backordered' },
  { code: 'DAMAGED', label: 'Damaged', hint: 'Arrived broken, refused' },
  { code: 'WRONG_ITEM', label: 'Wrong item', hint: 'Different product delivered' },
  { code: 'OTHER', label: 'Other', hint: 'Explain in the note' },
];

/** Delivery: more units than ordered. */
export const DELIVERY_OVER_REASONS: ReasonOption<DeliveryReasonCode>[] = [
  { code: 'SUPPLIER_OVER', label: 'Supplier over', hint: 'Extra units delivered' },
  { code: 'WRONG_ITEM', label: 'Wrong item', hint: 'Counted under this product' },
  { code: 'OTHER', label: 'Other', hint: 'Explain in the note' },
];

export function reasonLabel(code: string | null | undefined): string {
  return code ? (REASON_LABELS as Record<string, string>)[code] ?? code : '—';
}

/** Codes that represent real loss (used for shrinkage). */
export const LOSS_CODES: ReasonCode[] = ['MISSING', 'THEFT', 'DAMAGED'];
