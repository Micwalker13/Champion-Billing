import { describe, expect, it } from "vitest";
import { billedPeriodForMonth, computeRentalCharge, nominalPeriod, periodsThrough, ProrationNotApprovedError, LineWindow } from "@/lib/billing";
import { daysInclusive } from "@/lib/dates";
import { validatePoFormat, similarUnits } from "@/lib/po";
import { parseMoney } from "@/lib/money";

const rpm = { po_pattern: "[456][0-9]{5}", po_pattern_description: "6 digits starting 4/5/6" };

describe("calendar-month periods", () => {
  it("uses real month lengths, including leap February", () => {
    expect(nominalPeriod("calendar_month", "2026-08-14", "2026-11-17")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(nominalPeriod("calendar_month", "2026-08-14", "2026-12-01")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
    expect(nominalPeriod("calendar_month", "2026-08-14", "2027-02-10")).toEqual({ start: "2027-02-01", end: "2027-02-28" });
    expect(nominalPeriod("calendar_month", "2026-08-14", "2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });
  it("is independent of the rental start date", () => {
    const w: LineWindow = { method: "calendar_month", onRentDate: "2026-08-14", billingStartDate: "2026-11-01", billOffRentDay: true };
    expect(billedPeriodForMonth(w, "2026-11-01")).toMatchObject({ start: "2026-11-01", end: "2026-11-30" });
  });
  it("covers every day exactly once across months (no gaps, no double billing)", () => {
    const w: LineWindow = { method: "calendar_month", onRentDate: "2026-08-14", billingStartDate: "2026-08-14", offRentDate: "2027-03-09", billOffRentDay: true };
    const ps = periodsThrough(w, "2027-12-31");
    expect(ps[0]).toMatchObject({ start: "2026-08-14", end: "2026-08-31" });
    expect(ps.at(-1)).toMatchObject({ start: "2027-03-01", end: "2027-03-09" });
    for (let i = 1; i < ps.length; i++) expect(daysInclusive(ps[i - 1].end, ps[i].start)).toBe(2);
    const total = ps.reduce((s, p) => s + daysInclusive(p.start, p.end), 0);
    expect(total).toBe(daysInclusive("2026-08-14", "2027-03-09"));
  });
  it("does not treat a 28-day cycle as a calendar month", () => {
    const w: LineWindow = { method: "cycle_28", onRentDate: "2026-10-06", billingStartDate: "2026-10-06", billOffRentDay: true };
    const ps = periodsThrough(w, "2026-12-31");
    expect(ps.map((p) => [p.start, p.end])).toEqual([["2026-10-06", "2026-11-02"], ["2026-11-03", "2026-11-30"], ["2026-12-01", "2026-12-28"], ["2026-12-29", "2027-01-25"]]);
  });
  it("honours the off-rent-day setting", () => {
    const w: LineWindow = { method: "daily", onRentDate: "2026-11-01", billingStartDate: "2026-11-01", offRentDate: "2026-11-10", billOffRentDay: false };
    expect(periodsThrough(w, "2026-12-31").length).toBe(9);
  });
});

describe("rental charge", () => {
  const full = { start: "2026-11-01", end: "2026-11-30" };
  it("bills a full calendar month at the monthly rate", () => {
    const c = computeRentalCharge({ rateAmount: "1924.25", rateBasis: "monthly", method: "calendar_month", proration: "unapproved", billed: full, nominal: full });
    expect(c.amount).toBe("1924.25");
    expect(c.isPartial).toBe(false);
  });
  it("refuses to prorate until a policy is approved", () => {
    expect(() => computeRentalCharge({ rateAmount: "1924.25", rateBasis: "monthly", method: "calendar_month", proration: "unapproved", billed: { start: "2026-11-15", end: "2026-11-30" }, nominal: full }))
      .toThrow(ProrationNotApprovedError);
  });
  it("prorates per the configured options with decimal rounding", () => {
    const part = { start: "2026-11-21", end: "2026-11-30" }; // 10 days
    const base = { rateAmount: "1924.25", rateBasis: "monthly" as const, method: "calendar_month" as const, billed: part, nominal: full };
    expect(computeRentalCharge({ ...base, proration: "actual_days" }).amount).toBe("641.42");      // 1924.25*10/30
    expect(computeRentalCharge({ ...base, proration: "thirty_day_capped" }).amount).toBe("641.42");
    expect(computeRentalCharge({ ...base, proration: "full_period" }).amount).toBe("1924.25");
    const dec = { start: "2026-12-01", end: "2026-12-31" };
    const decPart = { start: "2026-12-01", end: "2026-12-10" };
    expect(computeRentalCharge({ ...base, billed: decPart, nominal: dec, proration: "actual_days" }).amount).toBe("620.73"); // 1924.25*10/31
  });
  it("uses exact decimal math (no float drift)", () => {
    const c = computeRentalCharge({ rateAmount: "0.10", rateBasis: "daily", method: "daily", proration: "unapproved", billed: { start: "2026-11-01", end: "2026-11-03" }, nominal: { start: "2026-11-01", end: "2026-11-01" } });
    expect(c.amount).toBe("0.30");
  });
});

describe("PO validation", () => {
  it("enforces RPM's format", () => {
    for (const ok of ["459186", "500000", "699999"]) expect(validatePoFormat(ok, rpm).ok).toBe(true);
    for (const bad of ["359186", "45918", "4591860", "45918A", "", " 459186"]) expect(validatePoFormat(bad, rpm).ok).toBe(false);
  });
  it("allows any PO for customers without a rule", () => {
    expect(validatePoFormat("ABC-1", { po_pattern: null, po_pattern_description: null }).ok).toBe(true);
  });
  it("suggests near-miss units but never auto-matches", () => {
    expect(similarUnits("MUR002035", ["MUR02035", "MUR002101"])).toContain("MUR02035");
  });
  it("parses money strictly", () => {
    expect(parseMoney("$2,083.00")!.toFixed(2)).toBe("2083.00");
    expect(parseMoney(1562.25)!.toFixed(2)).toBe("1562.25");
    expect(() => parseMoney("12abc")).toThrow();
  });
});
