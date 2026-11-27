import type { ComplianceProfile, DispatchDocumentType } from '../../core/compliance/compliance';
export type { DispatchDocumentType } from '../../core/compliance/compliance';

/** Legacy columns on deliveries (kept for compatibility, no longer written). */
export type EReceiptStatus =
  'NOT_CONNECTED' | 'PENDING' | 'SENT' | 'ACCEPTED' | 'PARTIALLY_ACCEPTED' | 'REJECTED' | 'DISPUTED';

/** Receipt acknowledgement (e-Prijemnica in Serbia), stored in external_documents. */
export type ReceiptAckStatus = 'SENT' | 'SUPPLIER_AGREED' | 'SUPPLIER_DISPUTED';
export type ReceiptAckOutcome = 'ACCEPTED_IN_FULL' | 'ACCEPTED_WITH_DEVIATIONS' | 'REJECTED_IN_FULL';
export type ExternalProvider = 'MANUAL' | 'SEO_SERBIA' | 'TERON' | 'SAP' | 'BUSINESS_CENTRAL' | 'OTHER';

export interface ReceiptAck {
  id: string;
  provider: ExternalProvider;
  document_number: string;
  external_id: string | null;
  status: ReceiptAckStatus;
  sent_at: string | null;
  outcome: ReceiptAckOutcome | null;
  note: string | null;
  updated_at: string;
}

export interface ReceiptAckInput {
  deliveryId: string;
  documentNumber: string;
  status: ReceiptAckStatus;
  provider: ExternalProvider;
  externalId: string | null;
  sentAt: string | null;
  note: string | null;
}

export interface OrderFulfillment {
  order_item_id: string; order_id: string; product_id: string;
  ordered_qty: number; delivered_qty: number | null;
  physical_qty: number | null; accepted_qty: number | null; rejected_qty: number | null;
  variance: number | null; reason: string | null; reason_code: string | null;
  delivery_id: string | null; delivered_at: string | null;
  product?: { name: string; sku: string };
}

export interface DeliveryLineInput {
  order_item_id: string;
  physical_qty: number;
  accepted_qty: number;

  held_qty: number;
  immediate_return_qty: number;

  rejection_reason_code:
  | 'DAMAGED'
  | 'WRONG_ITEM'
  | 'OTHER'
  | null;

  reason_code: string | null;
  reason: string | null;
}

export interface DeliveryMetaInput {
  carrier: string | null; receivedBy: string | null; note: string | null;
  dispatchDocumentType: DispatchDocumentType | null;
  dispatchDocumentNumber: string | null; dispatchExternalId: string | null;
  physicalReceiptAt: string | null;
}

export type ResolutionStatus = 'open' | 'resolved';
export type Resolution = 'BACKORDER' | 'CLOSE_SHORT' | 'CLAIM' | 'ACCEPT' | 'RETURN_TO_SUPPLIER' | 'RETURN_IMMEDIATE';

export interface ReceiptParty {
  name?: string | null; address?: string | null; city?: string | null; postal_code?: string | null;
  country?: string | null; tax_id?: string | null; registration_number?: string | null;
  email?: string | null; order_email?: string | null; phone?: string | null;
}

export interface HeldDispositionHistory {
  id: string; type: 'ACCEPT' | 'RETURN_IMMEDIATE' | 'RETURN_LATER' | 'DISPOSED'; quantity: number;
  dispatch_provider?: string | null; dispatch_document_number?: string | null; dispatch_external_id?: string | null;
  note?: string | null; disposed_at: string;
}
export interface ReceiptLine {
  line_id: string | null; order_item_id: string; product_id: string; sku: string; product_name: string;
  ordered_qty: number; physical_qty: number; accepted_qty: number; rejected_qty: number;
  held_qty: number; held_accepted_qty: number; immediate_return_qty: number; short_qty: number; over_qty: number; quality_rejected_qty: number;
  accepted_later_qty: number; total_stock_qty: number;
  held_original_qty: number; held_remaining_qty: number; held_status: 'HELD' | 'PARTIALLY_DISPOSED' | 'CLOSED' | null;
  disposition_accepted_qty: number; returned_later_qty: number; disposed_qty: number;
  held_dispositions: HeldDispositionHistory[];
  variance_reason_code: 'SUPPLIER_SHORT' | 'SUPPLIER_OVER' | null;
  rejection_reason_code: 'DAMAGED' | 'WRONG_ITEM' | 'OTHER' | null;
  received_qty: number; variance: number; shortage_qty: number;
  unit_cost: number | null; ordered_value: number | null; received_value: number | null; variance_value: number | null;
  reason_code: string | null; reason: string | null;
  resolution_status: ResolutionStatus | null; resolution: Resolution | null;
  resolution_note: string | null; resolved_at: string | null; backorder_number: string | null;
}

export interface GoodsReceipt {
  currency: string;
  compliance_profile: ComplianceProfile;
  receipt_outcome: ReceiptAckOutcome;
  receipt_ack: ReceiptAck | null;
  object_name: string;
  delivery: {
    id: string; delivery_number: string | null; delivered_at: string;
    received_by: string | null; carrier: string | null; note: string | null;
    dispatch_document_type: DispatchDocumentType | null; dispatch_document_number: string | null;
    dispatch_external_id: string | null; physical_receipt_at: string | null;
    ereceipt_status: EReceiptStatus; ereceipt_number: string | null;
    ereceipt_external_id: string | null; ereceipt_sent_at: string | null;
  };
  order: {
    id: string; order_number: string; status: string; comment: string | null; approved_at: string | null;
    company: ReceiptParty | null; supplier: ReceiptParty | null; deliver_to: ReceiptParty | null;
  };
  lines: ReceiptLine[];
}

export interface DeliveryException {
  line_id: string; delivery_id: string; delivery_number: string | null;
  order_id: string; order_number: string | null; variance: number;
  resolution_status: ResolutionStatus | null;
}

export const RECEIPT_ACK_STATUS_LABELS: Record<ReceiptAckStatus, string> = {
  SENT: 'Sent to supplier',
  SUPPLIER_AGREED: 'Supplier agreed',
  SUPPLIER_DISPUTED: 'Supplier disputed',
};

export const RECEIPT_ACK_OUTCOME_LABELS: Record<ReceiptAckOutcome, string> = {
  ACCEPTED_IN_FULL: 'Accepted in full',
  ACCEPTED_WITH_DEVIATIONS: 'Accepted with deviations',
  REJECTED_IN_FULL: 'Rejected in full',
};

export const PROVIDER_LABELS: Record<ExternalProvider, string> = {
  MANUAL: 'Entered manually',
  SEO_SERBIA: 'SEO (Serbia)',
  TERON: 'Teron',
  SAP: 'SAP',
  BUSINESS_CENTRAL: 'Business Central',
  OTHER: 'Other system',
};
