/**
 * Equipment fee and tax engine. Pure functions only: no database, no clock.
 *
 * Nothing here assumes any equipment owes HET, TERP or any other fee. A fee applies to a unit only
 * when an administrator assigned it to the unit's class or category (or explicitly to all equipment),
 * or switched it on for that unit, and did not switch it off for that unit.
 */
import { D, Dec, dec, money } from "./money";

export type FeeCategory = "regulatory_tax" | "business_surcharge";
export type FeeTxn = "rental" | "sale";

export const FEE_CATEGORY_LABELS: Record<FeeCategory, string> = {
  regulatory_tax: "Regulatory tax or assessment",
  business_surcharge: "Business surcharge",
};
export const FEE_FREQUENCY_LABELS = { per_billing_cycle: "Every billing cycle", one_time: "One time" } as const;

export interface FeeType {
  id: string; code: string; name: string; category: FeeCategory; calc_type: "percent" | "fixed";
  frequency: "per_billing_cycle" | "one_time"; applies_rentals: boolean; applies_sales: boolean;
  taxable: boolean; gl_account: string | null; allow_override: boolean; active: boolean;
}
export interface FeeRate { fee_type_id: string; effective_from: string; effective_to: string | null; percent: string | null; amount: string | null }
export interface FeeAssignment { fee_type_id: string; scope: "class" | "category" | "all"; equipment_class: string | null; category: string | null; active: boolean }
export interface UnitFeeSetting { fee_type_id: string; enabled: boolean }
export interface FeeExemption { fee_type_id: string; effective_from: string; effective_to: string | null }
export interface FeeOverride { fee_type_id: string; waived: boolean; percent: string | null; amount: string | null; reason: string }

const norm = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();

/** Why a fee does or doesn't reach a unit, for the equipment page. */
export type FeeReach = { applies: boolean; via: "unit_on" | "unit_off" | "class" | "category" | "all" | "none" };

export function feeReach(fee: Pick<FeeType, "id">, unit: { equipment_class?: string | null; category?: string | null },
  assignments: FeeAssignment[], settings: UnitFeeSetting[]): FeeReach {
  const s = settings.find((x) => String(x.fee_type_id) === String(fee.id));
  if (s) return { applies: s.enabled, via: s.enabled ? "unit_on" : "unit_off" };
  const mine = assignments.filter((a) => a.active && String(a.fee_type_id) === String(fee.id));
  if (unit.equipment_class && mine.some((a) => a.scope === "class" && norm(a.equipment_class) === norm(unit.equipment_class))) return { applies: true, via: "class" };
  if (unit.category && mine.some((a) => a.scope === "category" && norm(a.category) === norm(unit.category))) return { applies: true, via: "category" };
  if (mine.some((a) => a.scope === "all")) return { applies: true, via: "all" };
  return { applies: false, via: "none" };
}

/** Active fees of this transaction type that reach the unit. */
export function applicableFees(types: FeeType[], txn: FeeTxn, unit: { equipment_class?: string | null; category?: string | null },
  assignments: FeeAssignment[], settings: UnitFeeSetting[]): FeeType[] {
  return types.filter((t) => t.active && (txn === "rental" ? t.applies_rentals : t.applies_sales) && feeReach(t, unit, assignments, settings).applies);
}

/** The rate in force on `date`, or null. */
export function rateOn(rates: FeeRate[], feeId: string, date: string): FeeRate | null {
  return rates.find((r) => String(r.fee_type_id) === String(feeId) && r.effective_from <= date && (!r.effective_to || r.effective_to >= date)) ?? null;
}

export function isExempt(exemptions: FeeExemption[], feeId: string, date: string): boolean {
  return exemptions.some((e) => String(e.fee_type_id) === String(feeId) && e.effective_from <= date && (!e.effective_to || e.effective_to >= date));
}

export const pctLabel = (p: string | Dec) => `${dec(p).mul(100).toDecimalPlaces(4).toString()}%`;

export type FeeOutcome =
  | { status: "billed"; amount: string; description: string; rateText: string; overridden: boolean }
  | { status: "exempt" | "waived" | "no_rate" | "not_this_period" | "zero_base" };

/**
 * One fee for one billing cycle (rentals) or one sale.
 * Percent fees are a percent of `base` (the rental charge for that cycle, or the sale price).
 * Fixed fees are the flat amount each cycle, or once. Fixed amounts are not prorated for partial periods.
 */
export function computeFee(i: {
  fee: FeeType; rate: FeeRate | null; override?: FeeOverride | null; exempt: boolean; base: string; firstPeriod: boolean; baseLabel: string;
}): FeeOutcome {
  const { fee } = i;
  if (fee.frequency === "one_time" && !i.firstPeriod) return { status: "not_this_period" };
  if (i.exempt) return { status: "exempt" };
  const ov = fee.allow_override ? i.override ?? null : null;
  if (ov?.waived) return { status: "waived" };
  const percent = ov?.percent ?? (ov?.amount ? null : i.rate?.percent ?? null);
  const fixed = ov?.amount ?? (ov?.percent ? null : i.rate?.amount ?? null);
  if (!percent && !fixed) return { status: "no_rate" };
  const once = fee.frequency === "one_time" ? ", one time" : "";
  if (percent) {
    if (dec(i.base).lte(0)) return { status: "zero_base" };
    const amount = money(dec(i.base).mul(percent));
    return { status: "billed", amount, rateText: pctLabel(percent), overridden: !!ov, description: `${fee.name} (${pctLabel(percent)} of ${i.baseLabel}${once})` };
  }
  return { status: "billed", amount: money(dec(fixed!)), rateText: `$${dec(fixed!).toFixed(2)}`, overridden: !!ov, description: `${fee.name}${once ? " (one time)" : ""}` };
}

export const sumAmounts = (xs: { amount: string }[]) => xs.reduce((s, x) => s.add(dec(x.amount)), new D(0));
