// =====================================================================
// Stock runway — ONE place for the forecast used by Inventory, Reports,
// New order and the Sales checkout. Change a rule here, it changes everywhere.
// =====================================================================

/** Sales window the pace is measured over. */
export const WINDOW_DAYS = 30;
/** At or below → "Reorder now" (red). */
export const CRITICAL_DAYS = 7;
/** At or below → "Reorder soon" (amber). */
export const WARNING_DAYS = 14;
/** A reorder suggestion tops the shelf up to this many days. */
export const TARGET_DAYS = 21;
/** Fewer sales than this in the window = rough guess, shown with "~". */
export const MIN_SALES = 3;

export type Urgency = 'out' | 'critical' | 'warning' | 'healthy' | 'idle';

export interface Runway {
  /** Average units sold per day over the window. */
  dailyRate: number;
  /** Shelf ÷ pace. null = no sales, so no forecast. */
  daysLeft: number | null;
  urgency: Urgency;
  /** Too few sales to trust the number. */
  lowData: boolean;
  /** Units to order to reach TARGET_DAYS, after what is already on the way. 0 = nothing. */
  suggest: number;
}

/**
 * @param onHand   units on the shelf now
 * @param sold     units sold in the window
 * @param days     window length (default 30)
 * @param incoming units already on PENDING / APPROVED orders
 */
export function runway(onHand: number, sold: number, days = WINDOW_DAYS, incoming = 0): Runway {
  const shelf = Math.max(0, onHand);
  const dailyRate = sold > 0 ? sold / days : 0;
  const daysLeft = dailyRate > 0 ? shelf / dailyRate : null;

  let urgency: Urgency;
  if (onHand <= 0) urgency = 'out';
  else if (daysLeft === null) urgency = 'idle';
  else if (daysLeft <= CRITICAL_DAYS) urgency = 'critical';
  else if (daysLeft <= WARNING_DAYS) urgency = 'warning';
  else urgency = 'healthy';

  const needs = urgency === 'out' || urgency === 'critical' || urgency === 'warning';
  const suggest = needs && dailyRate > 0
    ? Math.max(0, Math.ceil(dailyRate * TARGET_DAYS - shelf - Math.max(0, incoming)))
    : 0;

  return { dailyRate, daysLeft, urgency, lowData: sold > 0 && sold < MIN_SALES, suggest };
}

/**
 * Honest wording: exact days only where they matter (under two weeks),
 * coarser ranges beyond — nobody can promise "72 days" from a handful of sales.
 */
export function runwayLabel(onHand: number, daysLeft: number | null, lowData = false): string {
  if (onHand <= 0) return 'Empty';
  if (daysLeft === null) return 'No sales';
  const p = lowData ? '~' : '';
  if (daysLeft < 1) return `${p}< 1 day`;
  if (daysLeft < 14) {
    const d = Math.round(daysLeft);
    return `${p}${d} ${d === 1 ? 'day' : 'days'}`;
  }
  if (daysLeft < 30) return `${p}2–4 weeks`;
  if (daysLeft < 60) return `${p}1–2 months`;
  return `${p}2+ months`;
}
