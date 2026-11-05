// Extra hours over the included hours (hour meter), and add-on charges.
import { beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { computeOvertime } from "@/lib/billing";
import { assignPo } from "@/lib/services/pos";
import { approveInvoice, generateInvoice, overrideCheck, submitForReview, validateInvoice } from "@/lib/services/invoices";
import { saveUsage, setDamageWaiverWaived, updateUsageSettings, usageForm } from "@/lib/services/usage";
import { createEquipment } from "@/lib/services/records";
import { exchangeUnit } from "@/lib/services/inventory";
import { RPM_SAMPLE_UNITS } from "@/lib/sample-data";
import { lineForUnit, resetDb, userByRole } from "./helpers";

let admin: SessionUser, manager: SessionUser, clerk: SessionUser, rpmId: string;
const base = { rateBasis: "monthly" as const, billedDays: 30, isPartial: false, hoursPerDay: "8", hoursPerWeek: "40", hoursPerMonth: "160", multiplier: "1.5" };
const settings = { overtime_enabled: true, hours_per_day: "8", hours_per_week: "40", hours_per_month: "160", overtime_multiplier: "1.5", damage_waiver_pct: "", environmental_pct: "", fuel_price_per_gallon: "" };

async function draftFor(i: number, lineId?: string) {
  const u = RPM_SAMPLE_UNITS[i];
  const line = lineId ?? await lineForUnit(u.unit);
  await assignPo(clerk, { lineId: line, period: "2026-11-01", poNumber: u.po, estimatedTotal: u.poTotal, jobNumber: u.job, workOrderNumber: u.wo });
  return { line, inv: await generateInvoice(clerk, line, "2026-11-01") };
}
const linesOf = (id: string) => q(`SELECT kind, description, quantity, unit_price, amount FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no`, [id]);

beforeAll(async () => {
  const seeded = await resetDb();
  rpmId = seeded.rpmId;
  [admin, manager, clerk] = await Promise.all(["admin", "billing_manager", "billing_clerk"].map(userByRole));
});

describe("Extra-hours math", () => {
  it("bills each hour over 160 at the monthly rate / 160 x 1.5", () => {
    const r = computeOvertime({ ...base, rateAmount: "3250.00", readings: [{ unit: "A", start: "1000.0", end: "1180.0" }] });
    expect(r).toMatchObject({ status: "ok", used: "180.0", included: "160.0", over: "20.0", amount: "609.38" });
    expect(computeOvertime({ ...base, rateAmount: "3250.00", readings: [{ unit: "A", start: "1000", end: "1150" }] })).toMatchObject({ status: "ok", over: "0.0", amount: "0.00" });
  });
  it("adds up hours across exchanged units, and uses 8 a day for daily rates and 40 a week for weekly", () => {
    expect(computeOvertime({ ...base, rateAmount: "3200", readings: [{ unit: "A", start: "100", end: "200" }, { unit: "B", start: "50", end: "120" }] })).toMatchObject({ used: "170.0", over: "10.0", amount: "300.00" });
    expect(computeOvertime({ ...base, rateBasis: "daily", billedDays: 3, rateAmount: "400", readings: [{ unit: "A", start: "0", end: "30" }] })).toMatchObject({ included: "24.0", over: "6.0", amount: "450.00" });
    expect(computeOvertime({ ...base, rateBasis: "weekly", billedDays: 7, rateAmount: "1000", readings: [{ unit: "A", start: "0", end: "44" }] })).toMatchObject({ included: "40.0", amount: "150.00" });
  });
  it("needs both readings, refuses a meter that went backwards, and leaves partial months alone", () => {
    expect(computeOvertime({ ...base, rateAmount: "3250", readings: [{ unit: "A", start: "100", end: null }] })).toEqual({ status: "missing", units: ["A"] });
    expect(computeOvertime({ ...base, rateAmount: "3250", readings: [{ unit: "A", start: "100", end: "90" }] })).toEqual({ status: "invalid", units: ["A"] });
    expect(computeOvertime({ ...base, isPartial: true, rateAmount: "3250", readings: [] })).toEqual({ status: "partial" });
  });
});

describe("Extra hours on invoices", () => {
  it("is off until the customer is set up for it", async () => {
    const { inv } = await draftFor(0);
    expect((await linesOf(inv.id)).map((l) => l.kind)).toEqual(["rental"]);
    expect((await validateInvoice(inv.id)).find((c) => c.rule === "hour_meter")).toBeUndefined();
    await expect(updateUsageSettings(manager, rpmId, settings)).rejects.toThrow(/permission/);
  });

  it("asks for readings, then bills the extra hours and records the unit's hour meter", async () => {
    await updateUsageSettings(admin, rpmId, settings);
    const { line, inv } = await draftFor(1);
    const rate = (await one(`SELECT rate_amount FROM rental_contract_lines WHERE id=$1`, [line])).rate_amount;
    const check = (await validateInvoice(inv.id)).find((c) => c.rule === "hour_meter")!;
    expect(check.status).toBe("fail");
    const [row] = await usageForm(inv.id);
    expect(row.unit_number).toBe(RPM_SAMPLE_UNITS[1].unit);
    await expect(saveUsage(clerk, inv.id, [{ equipment_id: row.equipment_id, start_hours: "2000.0", end_hours: "1990.0" }])).rejects.toThrow(/lower than the start/);
    const after = await saveUsage(clerk, inv.id, [{ equipment_id: row.equipment_id, start_hours: "2000.0", end_hours: "2180.0" }]);
    const ot = (await linesOf(inv.id)).find((l) => l.kind === "overtime")!;
    const expected = (Math.round(20 * (Number(rate) / 160) * 1.5 * 100) / 100).toFixed(2);
    expect(ot.amount).toBe(expected);
    expect(ot.quantity).toBe("20.0000");
    expect(ot.description).toContain("meter 2,000.0 to 2,180.0");
    expect(Number(after.subtotal)).toBeCloseTo(Number(rate) + Number(expected), 2);
    expect((await validateInvoice(inv.id)).find((c) => c.rule === "hour_meter")!.status).toBe("pass");
    expect((await one(`SELECT hour_meter FROM equipment WHERE id=$1`, [row.equipment_id])).hour_meter).toBe("2180.0");
    // Next month starts where this one ended.
    const ev = await one(`SELECT hours, event_date FROM equipment_events WHERE equipment_id=$1 AND kind='hours' ORDER BY id DESC LIMIT 1`, [row.equipment_id]);
    expect(ev).toEqual({ hours: "2180.0", event_date: "2026-11-30" });
  });

  it("locks the readings once the invoice is approved", async () => {
    const inv = await one(`SELECT i.id FROM invoices i JOIN period_usage u ON u.billing_period_id=i.billing_period_id LIMIT 1`);
    await submitForReview(clerk, inv.id);
    for (const c of (await validateInvoice(inv.id)).filter((c) => (c.status === "fail" || c.status === "warn") && c.overridable && !c.override)) await overrideCheck(manager, inv.id, c.rule, "Test: accepted");
    await approveInvoice(manager, inv.id);
    await expect(saveUsage(clerk, inv.id, [])).rejects.toThrow(/only be changed while the invoice is a draft/);
    await expect(q(`UPDATE period_usage SET end_hours=9999 WHERE billing_period_id=(SELECT billing_period_id FROM invoices WHERE id=$1)`, [inv.id])).rejects.toThrow(/approved invoice/);
  });

  it("follows an exchange: the old unit's reading out and the new unit's reading in", async () => {
    await createEquipment(clerk, { unit_number: "OTSWAP", description: "Swap unit", category: "Test" });
    const line = await lineForUnit(RPM_SAMPLE_UNITS[2].unit);
    await exchangeUnit(clerk, line, { in_unit: "OTSWAP", exchange_date: "2026-11-16", reason: "Swap for test", out_hours: "3100.0", in_hours: "500.0" });
    const { inv } = await draftFor(2, line);
    const rows = await usageForm(inv.id);
    expect(rows.map((r) => r.unit_number)).toEqual([RPM_SAMPLE_UNITS[2].unit, "OTSWAP"]);
    expect(rows[0].end_hint).toBe("3100.0");
    expect(rows[1].start_hint).toBe("500.0");
    await saveUsage(clerk, inv.id, [
      { equipment_id: rows[0].equipment_id, start_hours: "3000.0", end_hours: "3100.0" },
      { equipment_id: rows[1].equipment_id, start_hours: "500.0", end_hours: "590.0" },
    ]);
    const ot = (await linesOf(inv.id)).find((l) => l.kind === "overtime")!;
    expect(ot.quantity).toBe("30.0000"); // 100 + 90 - 160
    expect(ot.description).toContain("OTSWAP meter 500.0 to 590.0");
  });
});

describe("Add-on charges", () => {
  it("adds damage waiver and environmental as a percent of rental, and fuel by the gallon", async () => {
    await updateUsageSettings(admin, rpmId, { ...settings, overtime_enabled: false, damage_waiver_pct: "15", environmental_pct: "2.5", fuel_price_per_gallon: "4.25" });
    const { line, inv } = await draftFor(3);
    const rental = Number((await linesOf(inv.id))[0].amount);
    const [row] = await usageForm(inv.id);
    await saveUsage(clerk, inv.id, [{ equipment_id: row.equipment_id, start_hours: "", end_hours: "", fuel_gallons: "20.0" }]);
    const ls = await linesOf(inv.id);
    expect(ls.map((l) => l.kind)).toEqual(["rental", "damage_waiver", "environmental", "fuel"]);
    expect(ls[1].amount).toBe((Math.round(rental * 0.15 * 100) / 100).toFixed(2));
    expect(ls[2].amount).toBe((Math.round(rental * 0.025 * 100) / 100).toFixed(2));
    expect(ls[3].amount).toBe("85.00");
    // A rental with the customer's own insurance is excused from the waiver.
    await expect(setDamageWaiverWaived(clerk, line, true, "")).rejects.toThrow(/why/);
    await setDamageWaiverWaived(clerk, line, true, "Insurance certificate on file");
    await saveUsage(clerk, inv.id, [{ equipment_id: row.equipment_id, start_hours: "", end_hours: "", fuel_gallons: "20.0" }]);
    expect((await linesOf(inv.id)).map((l) => l.kind)).toEqual(["rental", "environmental", "fuel"]);
  });

  it("warns when fuel is entered but no price is set", async () => {
    await updateUsageSettings(admin, rpmId, settings);
    const { inv } = await draftFor(4);
    const [row] = await usageForm(inv.id);
    await saveUsage(clerk, inv.id, [{ equipment_id: row.equipment_id, start_hours: "10", end_hours: "100", fuel_gallons: "5" }]);
    expect((await linesOf(inv.id)).map((l) => l.kind)).toEqual(["rental"]);
    expect((await validateInvoice(inv.id)).find((c) => c.rule === "fuel_price")!.status).toBe("warn");
  });
});
