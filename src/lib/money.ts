import Decimal from "decimal.js";

// Dedicated Decimal clone for currency: 40 significant digits, half-up rounding.
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export const dec = (v: Decimal.Value | null | undefined): Dec => new D(v == null || v === "" ? 0 : v);
export const cents = (v: Decimal.Value): Dec => new D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export const money = (v: Decimal.Value): string => cents(v).toFixed(2);

export function fmtUSD(v: Decimal.Value | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = cents(v);
  const neg = n.isNegative();
  const [i, f] = n.abs().toFixed(2).split(".");
  const withCommas = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${withCommas}.${f}`;
}

/** Strictly parse a user/import-supplied money string ("$2,083.00" ok). Returns null if blank, throws on garbage. */
export function parseMoney(input: unknown): Dec | null {
  if (input == null) return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`Invalid amount: ${input}`);
    // Excel cells arrive as JS numbers; go through a fixed string to avoid binary artifacts.
    return cents(new D(input.toFixed(6)));
  }
  const s = String(input).trim().replace(/[$,\s]/g, "");
  if (s === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${input}`);
  return cents(s);
}
