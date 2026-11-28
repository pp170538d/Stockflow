export interface AppError {
  code: string;
  title: string;
  message: string;
  retryable: boolean;
  referenceId: string;
  technicalDetail?: string;
}

export function mapAppError(error: unknown, fallbackTitle = 'Something went wrong'): AppError {
  const source = error as { message?: string; details?: string; hint?: string; code?: string } | null;
  const technicalDetail = [source?.message, source?.details, source?.hint].filter(Boolean).join(' | ');
  const text = technicalDetail.toLowerCase();
  const detailCode = extractCode(technicalDetail);
  const known: Record<string, Omit<AppError, 'referenceId' | 'technicalDetail'>> = {
    ORDER_NOT_APPROVED: { code: 'ORDER_NOT_APPROVED', title: 'Order cannot be cancelled', message: 'Only an approved purchase order can be cancelled.', retryable: false },
    ORDER_ALREADY_RECEIVED: { code: 'ORDER_ALREADY_RECEIVED', title: 'Order cannot be cancelled', message: 'A goods receipt already exists. Open the receipt and resolve any remaining difference there.', retryable: false },
    ORDER_HAS_ACTIVE_CHILDREN: { code: 'ORDER_HAS_ACTIVE_CHILDREN', title: 'Order cannot be cancelled', message: 'This order has an active child backorder that must be resolved first.', retryable: false },
    ORDER_LINKED_TO_ACTIVE_CLAIM: { code: 'ORDER_LINKED_TO_ACTIVE_CLAIM', title: 'Order cannot be cancelled', message: 'This order belongs to an active replacement claim.', retryable: false },
    ORDER_NOT_FOUND: { code: 'ORDER_NOT_FOUND', title: 'Order not found', message: 'The order may have been removed or is no longer available to this account.', retryable: false },
    CANCEL_REASON_REQUIRED: { code: 'CANCEL_REASON_REQUIRED', title: 'Choose a reason', message: 'Select why this purchase order is being cancelled.', retryable: false },
    CANCEL_NOTE_REQUIRED: { code: 'CANCEL_NOTE_REQUIRED', title: 'Add a note', message: 'A note is required when the reason is Other.', retryable: false },
    ADMIN_REQUIRED: { code: 'ADMIN_REQUIRED', title: 'Permission required', message: 'Only an administrator can cancel purchase orders.', retryable: false },
    DEMO_READ_ONLY: { code: 'DEMO_READ_ONLY', title: 'Demo is read-only', message: 'This action is disabled in the demo account.', retryable: false },
  };
  const matched = detailCode ? known[detailCode] : undefined;
  if (matched) return { ...matched, referenceId: referenceId(), technicalDetail };
  if (text.includes('failed to fetch') || text.includes('network') || text.includes('timeout')) {
    return { code: 'NETWORK_ERROR', title: 'Connection lost', message: 'No changes were recorded. Check the connection and try again.', retryable: true, referenceId: referenceId(), technicalDetail };
  }
  return { code: source?.code ?? 'UNKNOWN', title: fallbackTitle, message: 'The action was not completed. No inventory was changed.', retryable: true, referenceId: referenceId(), technicalDetail };
}

function extractCode(value: string): string | null {
  const codes = ['ORDER_NOT_APPROVED','ORDER_ALREADY_RECEIVED','ORDER_HAS_ACTIVE_CHILDREN','ORDER_LINKED_TO_ACTIVE_CLAIM','ORDER_NOT_FOUND','CANCEL_REASON_REQUIRED','CANCEL_NOTE_REQUIRED','ADMIN_REQUIRED','DEMO_READ_ONLY'];
  return codes.find(code => value.includes(code)) ?? null;
}
function referenceId(): string { return `ERR-${crypto.randomUUID().slice(0, 6).toUpperCase()}`; }
