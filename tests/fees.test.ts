// Equipment fees and taxes: setup, which units they reach, invoices, sales, exemptions, overrides, reporting.
import { beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { assignPo } from "@/lib/services/pos";
import { generateInvoice, refreshInvoice, validateInvoice } from "@/lib/services/invoices";
import { createEquipment } from "@/lib/services/records";
import { createSale, finalizeSale } from "@/lib/services/sales";
import {
  addExemption, addFeeAssignment, addFeeRate, createFeeType, endFeeRate, feeReport, removeExemption, removeFeeOverride,
  setEquipmentClass, setFeeOverride, setFeeTypeActive, setUnitFee,
} from "@/lib/services/fees";
import { quoteLineFees } from "@/lib/services/dispatch";
import { computeFee, feeReach, rateOn, FeeType } from "@/lib/fees";
import { RPM_SAMPLE_UNITS } from "@/lib/sample-data";
import { lineForUnit, resetDb, userByRole } from "./helpers";

let admin: SessionUser, manager: SessionUser, clerk: SessionUser, rpmId: string;
const feeLines = (id: string) => q(`SELECT description, amount, taxable, fee_category, fee_type_id FROM invoice_lines WHERE invoice_id=$1 AND kind='equipment_fee' ORDER BY line_no`, [id]);
const rentalOf = async (id: string) => (await one(`SELECT amount FROM invoice_lines WHERE invoice_id=$1 AND kind='rental'`, [id])).amount as string;
const pct = (amt: string, p: number) => (Math.round(Number(amt) * p) / 100).toFixed(2);
const fee = (o: Partial<FeeType> = {}): FeeType => ({ id: "1", code: "X", name: "Test fee", category: "regulatory_tax", calc_type: "percent", frequency: "per_billing_cycle",
  applies_rentals: true, applies_sales: false, taxable: false, gl_account: null, allow_override: true, active: true, ...o });

async function draftFor(i: number) {
  const u = RPM_SAMPLE_UNITS[i];
  const line = await lineForUnit(u.unit);
  await assignPo(clerk, { lineId: line, period: "2026-11-01", poNumber: u.po, estimatedTotal: u.poTotal, jobNumber: u.job, workOrderNumber: u.wo });
  const inv = await generateInvoice(clerk, line, "2026-11-01");
  const eq = (await one(`SELECT equipment_id FROM rental_contract_lines WHERE id=$1`, [line])).equipment_id as string;
  return { line, inv, eq };
}

beforeAll(async () => {
  const seeded = await resetDb();
  rpmId = seeded.rpmId;
  [admin, manager, clerk] = await Promise.all(["admin", "billing_manager", "billing_clerk"].map(userByRole));
});

describe("Fee rules", () => {
  it("a unit switch beats its class, class beats category, and nothing applies by default", () => {
    const a = [{ fee_type_id: "1", scope: "class" as const, equipment_class: "Excavator", category: null, active: true }];
    expect(feeReach(fee(), { equipment_class: "excavator" }, a, [])).toEqual({ applies: true, via: "class" });
    expect(feeReach(fee(), { equipment_class: "Excavator" }, a, [{ fee_type_id: "1", enabled: false }])).toEqual({ applies: false, via: "unit_off" });
    expect(feeReach(fee(), { equipment_class: "Loader" }, a, [])).toEqual({ applies: false, via: "none" });
    expect(feeReach(fee(), { equipment_class: "Loader" }, [], [{ fee_type_id: "1", enabled: true }])).toEqual({ applies: true, via: "unit_on" });
  });
  it("percent, flat, one-time, exempt, waived, override and missing rate", () => {
    const rate = { fee_type_id: "1", effective_from: "2026-01-01", effective_to: null, percent: "0.020000", amount: null };
    const base = { rate, exempt: false, base: "3250.00", firstPeriod: false, baseLabel: "rental" };
    expect(computeFee({ ...base, fee: fee() })).toMatchObject({ status: "billed", amount: "65.00", description: "Test fee (2% of rental)" });
    expect(computeFee({ ...base, fee: fee({ calc_type: "fixed" }), rate: { ...rate, percent: null, amount: "25" } })).toMatchObject({ status: "billed", amount: "25.00" });
    expect(computeFee({ ...base, fee: fee({ frequency: "one_time" }) }).status).toBe("not_this_period");
    expect(computeFee({ ...base, fee: fee({ frequency: "one_time" }), firstPeriod: true }).status).toBe("billed");
    expect(computeFee({ ...base, fee: fee(), exempt: true }).status).toBe("exempt");
    expect(computeFee({ ...base, fee: fee(), override: { fee_type_id: "1", waived: true, percent: null, amount: null, reason: "x" } }).status).toBe("waived");
    expect(computeFee({ ...base, fee: fee(), override: { fee_type_id: "1", waived: false, percent: "0.010000", amount: null, reason: "x" } })).toMatchObject({ amount: "32.50", overridden: true });
    expect(computeFee({ ...base, fee: fee({ allow_override: false }), override: { fee_type_id: "1", waived: true, percent: null, amount: null, reason: "x" } }).status).toBe("billed");
    expect(computeFee({ ...base, fee: fee(), rate: null }).status).toBe("no_rate");
    expect(rateOn([rate, { ...rate, effective_from: "2025-01-01", effective_to: "2025-12-31", percent: "0.01" }], "1", "2025-06-01")?.percent).toBe("0.01");
  });
});

describe("Fees on rental invoices", () => {
  let het: FeeType, setup: FeeType;

  it("only administrators set up fees, and no rates are built in", async () => {
    await expect(createFeeType(manager, { code: "HET", name: "HET", category: "regulatory_tax", calc_type: "percent", frequency: "per_billing_cycle", applies_rentals: true })).rejects.toThrow(/permission/);
    expect(await q(`SELECT * FROM fee_types`)).toEqual([]);
    het = await createFeeType(admin, { code: "het", name: "Heavy equipment rental tax", category: "regulatory_tax", calc_type: "percent", frequency: "per_billing_cycle", applies_rentals: true, applies_sales: true, gl_account: "2310" },
      { effective_from: "2026-01-01", value: "1.5" });
    expect(het.code).toBe("HET");
    setup = await createFeeType(admin, { code: "SETUP", name: "Setup surcharge", category: "business_surcharge", calc_type: "fixed", frequency: "one_time", applies_rentals: true, taxable: true },
      { effective_from: "2026-01-01", value: "75" });
  });

  it("a fee with no assignment charges nothing", async () => {
    const { inv } = await draftFor(0);
    expect(await feeLines(inv.id)).toEqual([]);
  });

  it("assigned to a class, it bills its own line for the cycle and records the accounting class", async () => {
    const { inv, eq } = await draftFor(1);
    await setEquipmentClass(clerk, eq, "Excavator");
    await addFeeAssignment(admin, het.id, { scope: "class", value: "Excavator" });
    await expect(addFeeAssignment(admin, het.id, { scope: "class", value: "excavator" })).rejects.toThrow(/already exists/);
    await refreshInvoice(clerk, inv.id);
    const [l] = await feeLines(inv.id);
    expect(l).toMatchObject({ description: "Heavy equipment rental tax (1.5% of rental)", amount: pct(await rentalOf(inv.id), 1.5), fee_category: "regulatory_tax", taxable: false, fee_type_id: het.id });
  });

  it("one-time fees bill on the first period only; switching a unit off removes a fee", async () => {
    const { line, inv, eq } = await draftFor(2);
    await setUnitFee(admin, eq, setup.id, true);
    await refreshInvoice(clerk, inv.id);
    const first = (await one(`SELECT billing_start_date FROM rental_contract_lines WHERE id=$1`, [line])).billing_start_date;
    const hasSetup = (await feeLines(inv.id)).some((l) => l.description.startsWith("Setup surcharge"));
    expect(hasSetup).toBe(first >= "2026-11-01");
    await setUnitFee(admin, eq, setup.id, null);
    await setEquipmentClass(clerk, eq, "Excavator");
    await expect(setUnitFee(admin, eq, het.id, false, "")).rejects.toThrow(/why/);
    await setUnitFee(admin, eq, het.id, false, "Electric unit");
    await refreshInvoice(clerk, inv.id);
    expect(await feeLines(inv.id)).toEqual([]);
  });

  it("customer exemptions, approver overrides, and turning a fee off", async () => {
    const line = await lineForUnit(RPM_SAMPLE_UNITS[1].unit);
    const inv = await one(`SELECT id FROM invoices WHERE contract_line_id=$1 ORDER BY id DESC LIMIT 1`, [line]);
    const ex = await addExemption(admin, rpmId, { fee_type_id: het.id, reason: "Exemption certificate on file", effective_from: "2026-01-01" });
    await refreshInvoice(clerk, inv.id);
    expect(await feeLines(inv.id)).toEqual([]);
    await removeExemption(admin, ex.id, "Certificate expired");

    await expect(setFeeOverride(clerk, { lineId: line }, { fee_type_id: het.id, mode: "rate", value: "1", reason: "Negotiated rate" })).rejects.toThrow(/permission/);
    const ov = await setFeeOverride(manager, { lineId: line }, { fee_type_id: het.id, mode: "rate", value: "1", reason: "Negotiated rate" });
    await refreshInvoice(clerk, inv.id);
    expect((await feeLines(inv.id))[0].amount).toBe(pct(await rentalOf(inv.id), 1));
    await removeFeeOverride(manager, ov.id);

    await setFeeTypeActive(admin, het.id, false);
    await refreshInvoice(clerk, inv.id);
    expect(await feeLines(inv.id)).toEqual([]);
    await setFeeTypeActive(admin, het.id, true);
    await refreshInvoice(clerk, inv.id);
    expect((await feeLines(inv.id))[0].amount).toBe(pct(await rentalOf(inv.id), 1.5));
    const audits = await q(`SELECT action FROM audit_log WHERE entity IN ('fee_type','fee_override','fee_exemption') ORDER BY id`);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["create", "add_rate", "assign", "override", "remove", "deactivate", "activate"]));
  });

  it("rate history: a new rate closes the old one, old rates can't be edited, and a gap is flagged", async () => {
    await expect(addFeeRate(admin, het.id, { effective_from: "2026-01-01", value: "2" })).rejects.toThrow(/must start after/);
    await addFeeRate(admin, het.id, { effective_from: "2026-12-01", value: "2" });
    const rs = await q(`SELECT effective_from, effective_to, percent FROM fee_rates WHERE fee_type_id=$1 ORDER BY effective_from`, [het.id]);
    expect(rs).toEqual([{ effective_from: "2026-01-01", effective_to: "2026-11-30", percent: "0.015000" }, { effective_from: "2026-12-01", effective_to: null, percent: "0.020000" }]);
    await expect(q(`UPDATE fee_rates SET percent=0.5 WHERE fee_type_id=$1 AND effective_to IS NOT NULL`, [het.id])).rejects.toThrow(/history/);
    await expect(q(`DELETE FROM fee_rates WHERE fee_type_id=$1`, [het.id])).rejects.toThrow(/history/);

    const terp = await createFeeType(admin, { code: "TERP", name: "TERP surcharge", category: "regulatory_tax", calc_type: "percent", frequency: "per_billing_cycle", applies_rentals: true });
    await addFeeAssignment(admin, terp.id, { scope: "class", value: "Excavator" });
    const l = await lineForUnit(RPM_SAMPLE_UNITS[1].unit);
    const inv = await one(`SELECT id FROM invoices WHERE contract_line_id=$1 ORDER BY id DESC LIMIT 1`, [l]);
    await refreshInvoice(clerk, inv.id);
    const chk = (await validateInvoice(inv.id)).find((c) => c.rule === "fee_rate")!;
    expect(chk).toMatchObject({ status: "warn" });
    expect(chk.message).toMatch(/TERP surcharge \(TERP\) applies to this unit but has no rate/);
    await endFeeRate(admin, het.id, "2026-12-31");
    await setFeeTypeActive(admin, terp.id, false);
  });
});

describe("Fees on sales and quotes, and the report", () => {
  it("adds the unit's sale fees, taxes only taxable ones, freezes them when finalized, and reports by type", async () => {
    await createEquipment(clerk, { unit_number: "SALE01", description: "Excavator for sale", category: "Excavators" });
    const unit = await one(`SELECT id FROM equipment WHERE unit_number='SALE01'`);
    await setEquipmentClass(clerk, unit.id, "Excavator");
    const env = await createFeeType(admin, { code: "ENV", name: "Environmental surcharge", category: "business_surcharge", calc_type: "fixed", frequency: "one_time", applies_rentals: false, applies_sales: true, taxable: true },
      { effective_from: "2026-01-01", value: "50" });
    await addFeeAssignment(admin, env.id, { scope: "category", value: "Excavators" });
    const sale = await createSale(clerk, { customer_id: rpmId, unit_number: "SALE01", price: "10000.00", taxable: true, tax_percent: "8.25" });
    const fees = await q(`SELECT description, amount, taxable FROM sale_fees WHERE sale_id=$1 ORDER BY id`, [sale.id]);
    expect(fees).toEqual([
      { description: "Environmental surcharge (one time)", amount: "50.00", taxable: true },
      { description: "Heavy equipment rental tax (1.5% of price)", amount: "150.00", taxable: false },
    ]);
    expect(sale.subtotal).toBe("10200.00");
    expect(sale.tax_amount).toBe("829.13"); // 8.25% of 10,050 (price + taxable surcharge)
    expect(sale.total).toBe("11029.13");
    await finalizeSale(manager, sale.id);
    await expect(q(`DELETE FROM sale_fees WHERE sale_id=$1`, [sale.id])).rejects.toThrow(/finalized/);
    const today = (await one(`SELECT sale_date FROM equipment_sales WHERE id=$1`, [sale.id])).sale_date;
    const r = await feeReport(today, today);
    expect(r.map((x: any) => [x.code, x.category, x.total])).toEqual([["ENV", "business_surcharge", "50.00"], ["HET", "regulatory_tax", "150.00"]]);
  });

  it("quotes show the fees each unit or category would carry", async () => {
    const out = await quoteLineFees(rpmId, [
      { id: "a", equipment_id: null, category: "Excavators", start_date: "2026-11-15", rate_amount: "3000.00" },
      { id: "b", equipment_id: null, category: "Lifts", start_date: "2026-11-15", rate_amount: "3000.00" },
    ]);
    expect(out.b).toEqual([]);
    expect(out.a).toEqual([]); // ENV is sales-only and HET is assigned by class, not category
  });
});
