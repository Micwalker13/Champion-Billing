/**
 * Deterministic rental billing engine. Pure functions only: no database, no clock.
 *
 * Vocabulary
 *  - nominal period: the full billing period a date falls in (e.g. Nov 1–30 for calendar_month).
 *  - billable window: [billing_start_date, last billable day] for a rental line.
 *  - billed period: nominal period clipped to the billable window. Billed periods for one line never
 *    overlap and leave no gaps, so the union of all billed periods == the billable window exactly.
 */
import { D, Dec, cents } from "./money";
import { addDays, addMonths, daysInclusive, diffDays, maxDate, minDate, monthEnd, monthStart } from "./dates";

export type BillingMethod = "daily" | "weekly" | "cycle_28" | "cycle_30" | "calendar_month";
export type RateBasis = "daily" | "weekly" | "cycle_28" | "cycle_30" | "monthly";
export type ProrationPolicy = "unapproved" | "actual_days" | "thirty_day_capped" | "full_period";

export const BILLING_METHOD_LABELS: Record<BillingMethod, string> = {
  daily: "Daily",
  weekly: "Weekly (7-day cycles)",
  cycle_28: "28-day cycles",
  cycle_30: "30-day cycles",
  calendar_month: "Calendar month (1st – last day)",
};
export const RATE_BASIS_LABELS: Record<RateBasis, string> = {
  daily: "per day", weekly: "per week", cycle_28: "per 28 days", cycle_30: "per 30 days", monthly: "per calendar month",
};
export const PRORATION_LABELS: Record<ProrationPolicy, string> = {
  unapproved: "Not approved yet — partial periods are blocked",
  actual_days: "Actual days: rate × days on rent ÷ days in that period",
  thirty_day_capped: "Fixed divisor: rate × days ÷ 30 (÷ cycle length for cycles), capped at one full rate",
  full_period: "No proration: any day in a period bills the full rate",
};

export interface Period { start: string; end: string }

const CYCLE_LEN: Record<Exclude<BillingMethod, "calendar_month">, number> = { daily: 1, weekly: 7, cycle_28: 28, cycle_30: 30 };

/** The full nominal period containing `date`. Cycle methods are anchored on the rental's on-rent date. */
export function nominalPeriod(method: BillingMethod, anchor: string, date: string): Period {
  if (method === "calendar_month") return { start: monthStart(date), end: monthEnd(date) };
  const len = CYCLE_LEN[method];
  const k = Math.floor(diffDays(anchor, date) / len);
  const start = addDays(anchor, k * len);
  return { start, end: addDays(start, len - 1) };
}

export interface LineWindow {
  method: BillingMethod;
  onRentDate: string;
  billingStartDate: string;
  offRentDate?: string | null;
  billOffRentDay: boolean;
}

/** Last billable day of the line, or null when still on rent. */
export function lastBillableDay(w: Pick<LineWindow, "offRentDate" | "billOffRentDay">): string | null {
  if (!w.offRentDate) return null;
  return w.billOffRentDay ? w.offRentDate : addDays(w.offRentDate, -1);
}

/** The billed period for a line that contains `date`, or null if the line is not billable on that date. */
export function billedPeriodFor(w: LineWindow, date: string): (Period & { nominal: Period }) | null {
  const last = lastBillableDay(w);
  if (date < w.billingStartDate || (last && date > last)) return null;
  const nominal = nominalPeriod(w.method, w.onRentDate, date);
  const start = maxDate(nominal.start, w.billingStartDate);
  const end = last ? minDate(nominal.end, last) : nominal.end;
  return { start, end, nominal };
}

/** Billed period for a calendar month (first-of-month ISO). Only meaningful for calendar_month billing. */
export function billedPeriodForMonth(w: LineWindow, monthFirst: string) {
  const ms = monthStart(monthFirst), me = monthEnd(monthFirst);
  const last = lastBillableDay(w);
  const start = maxDate(ms, w.billingStartDate);
  const end = last ? minDate(me, last) : me;
  if (start > end) return null;
  if (w.method !== "calendar_month") return billedPeriodFor(w, start);
  return { start, end, nominal: { start: ms, end: me } };
}

/** All billed periods from the billing start through `through` (inclusive). Contiguous, non-overlapping. */
export function periodsThrough(w: LineWindow, through: string): Array<Period & { nominal: Period }> {
  const out: Array<Period & { nominal: Period }> = [];
  let cursor = w.billingStartDate;
  for (let guard = 0; guard < 5000 && cursor <= through; guard++) {
    const p = billedPeriodFor(w, cursor);
    if (!p) break;
    out.push(p);
    cursor = addDays(p.end, 1);
  }
  return out;
}

export class ProrationNotApprovedError extends Error {
  code = "proration_not_approved";
  constructor(public period: Period) {
    super(`Period ${period.start} – ${period.end} is a partial period and this customer's proration policy has not been approved. Approve a proration policy on the customer's billing profile first.`);
  }
}
export class RateBasisMismatchError extends Error {
  code = "rate_basis_mismatch";
}

export interface RentalChargeInput {
  rateAmount: string;
  rateBasis: RateBasis;
  method: BillingMethod;
  proration: ProrationPolicy;
  billed: Period;
  nominal: Period;
}
export interface RentalCharge {
  amount: string;
  quantity: string;     // e.g. "1.0000" full period, "0.3333" partial
  unit: string;         // "month", "day", "28-day cycle"
  unitPrice: string;
  billedDays: number;
  periodDays: number;
  isPartial: boolean;
  explanation: string;
}

const BASIS_FOR_METHOD: Record<BillingMethod, RateBasis> = {
  daily: "daily", weekly: "weekly", cycle_28: "cycle_28", cycle_30: "cycle_30", calendar_month: "monthly",
};
const UNIT_NAME: Record<RateBasis, string> = { daily: "day", weekly: "week", cycle_28: "28-day cycle", cycle_30: "30-day cycle", monthly: "month" };

export function computeRentalCharge(i: RentalChargeInput): RentalCharge {
  const rate = new D(i.rateAmount);
  const billedDays = daysInclusive(i.billed.start, i.billed.end);
  const periodDays = daysInclusive(i.nominal.start, i.nominal.end);

  if (i.rateBasis === "daily") {
    const amount = cents(rate.mul(billedDays));
    return {
      amount: amount.toFixed(2), quantity: new D(billedDays).toFixed(4), unit: "day", unitPrice: rate.toFixed(4),
      billedDays, periodDays, isPartial: false, explanation: `${billedDays} day(s) × ${rate.toFixed(2)}/day`,
    };
  }
  if (BASIS_FOR_METHOD[i.method] !== i.rateBasis) {
    throw new RateBasisMismatchError(`A ${UNIT_NAME[i.rateBasis]} rate cannot be billed on ${BILLING_METHOD_LABELS[i.method]}. Use a matching rate basis or a daily rate.`);
  }
  const isPartial = billedDays < periodDays;
  let amount: Dec;
  let explanation: string;
  let qty: Dec;
  if (!isPartial) {
    amount = cents(rate);
    qty = new D(1);
    explanation = `Full ${UNIT_NAME[i.rateBasis]} (${billedDays} days)`;
  } else {
    switch (i.proration) {
      case "unapproved":
        throw new ProrationNotApprovedError(i.billed);
      case "actual_days":
        qty = new D(billedDays).div(periodDays);
        amount = cents(rate.mul(billedDays).div(periodDays));
        explanation = `Prorated: ${billedDays} of ${periodDays} days × ${rate.toFixed(2)}`;
        break;
      case "thirty_day_capped": {
        const divisor = i.method === "calendar_month" ? 30 : periodDays;
        const raw = rate.mul(billedDays).div(divisor);
        amount = cents(D.min(raw, rate));
        qty = D.min(new D(billedDays).div(divisor), new D(1));
        explanation = `Prorated: ${billedDays} ÷ ${divisor} days × ${rate.toFixed(2)}${raw.gt(rate) ? " (capped at full rate)" : ""}`;
        break;
      }
      case "full_period":
        amount = cents(rate);
        qty = new D(1);
        explanation = `Partial period (${billedDays} of ${periodDays} days) billed at full rate per policy`;
        break;
    }
  }
  return {
    amount: amount.toFixed(2), quantity: qty.toFixed(4), unit: UNIT_NAME[i.rateBasis], unitPrice: rate.toFixed(4),
    billedDays, periodDays, isPartial, explanation,
  };
}

export function computeTax(taxable: Dec | string, rate: string): string {
  return cents(new D(taxable).mul(new D(rate))).toFixed(2);
}

/** Next month first-of-month after the given date's month. */
export const nextMonth = (d: string) => addMonths(monthStart(d), 1);
