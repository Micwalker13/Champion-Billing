// Rent-to-own: only rental charges paid in full within 30 days count; buyout is a staff-confirmed draft sale.
import { beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { assignPo } from "@/lib/services/pos";
import { approveInvoice, generateInvoice, issueInvoice, overrideCheck, recordPayment, submitForReview, validateInvoice } from "@/lib/services/invoices";
import { changeLineStatus } from "@/lib/services/records";
import { cancelPurchaseOption, exercisePurchaseOption, plusMonths, purchaseOptionStatus, purchaseOptionsReady, setUpPurchaseOption } from "@/lib/services/rent-to-own";
import { addDays, todayCentral } from "@/lib/dates";
import { RPM_SAMPLE_UNITS } from "@/lib/sample-data";
import { lineForUnit, resetDb, userByRole } from "./helpers";

let manager: SessionUser, clerk: SessionUser;
let lineA: string, lineB: string, invA: any, invB: any, rentA: number;

async function issued(i: number) {
  const u = RPM_SAMPLE_UNITS[i];
  const line = await lineForUnit(u.unit);
  await assignPo(clerk, { lineId: line, period: "2026-11-01", poNumber: u.po, estimatedTotal: u.poTotal, jobNumber: u.job, workOrderNumber: u.wo });
  const inv = await generateInvoice(clerk, line, "2026-11-01");
  await submitForReview(clerk, inv.id);
  for (const c of (await validateInvoice(inv.id)).filter((c) => (c.status === "fail" || c.status === "warn") && c.overridable && !c.override)) await overrideCheck(manager, inv.id, c.rule, "Test: accepted");
  await approveInvoice(manager, inv.id);
  await issueInvoice(manager, inv.id);
  return { line, inv: await one(`SELECT * FROM invoices WHERE id=$1`, [inv.id]) };
}

beforeAll(async () => {
  await resetDb();
  [manager, clerk] = await Promise.all(["billing_manager", "billing_clerk"].map(userByRole));
  ({ line: lineA, inv: invA } = await issued(0));
  ({ line: lineB, inv: invB } = await issued(1));
  rentA = Number((await one(`SELECT sum(amount) AS s FROM invoice_lines WHERE invoice_id=$1 AND kind='rental'`, [invA.id])).s);
});

describe("Setting up", () => {
  it("adds months correctly, including month ends", () => {
    expect(plusMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(plusMonths("2026-06-15", 12)).toBe("2027-06-15");
  });
  it("only a manager sets it up, with sensible numbers", async () => {
    const start = (await one(`SELECT on_rent_date FROM rental_contract_lines WHERE id=$1`, [lineA])).on_rent_date;
    await expect(setUpPurchaseOption(clerk, lineA, { purchase_price: "40000", credit_percent: "80", term_months: "12" })).rejects.toThrow(/permission/);
    await expect(setUpPurchaseOption(manager, lineA, { purchase_price: "0", credit_percent: "80", term_months: "12" })).rejects.toThrow(/price/);
    await expect(setUpPurchaseOption(manager, lineA, { purchase_price: "40000", credit_percent: "120", term_months: "12" })).rejects.toThrow(/percent/);
    await expect(setUpPurchaseOption(manager, lineA, { purchase_price: "40000", credit_percent: "80", term_months: "0" })).rejects.toThrow(/months/);
    await expect(setUpPurchaseOption(manager, lineA, { purchase_price: "40000", credit_percent: "80", term_months: "12", starts_on: "2000-01-01" })).rejects.toThrow(/before/);
    const o = await setUpPurchaseOption(manager, lineA, { purchase_price: "$40,000", credit_percent: "80%", term_months: "12" });
    expect(o).toMatchObject({ purchase_price: "40000.00", credit_pct: "0.8000", starts_on: start, ends_on: plusMonths(start, 12) });
    await expect(setUpPurchaseOption(manager, lineA, { purchase_price: "40000", credit_percent: "80", term_months: "12" })).rejects.toThrow(/already/);
  });
});

describe("What counts", () => {
  it("an unpaid invoice counts nothing yet; a partial payment counts nothing", async () => {
    let s = (await purchaseOptionStatus(lineA))!;
    expect(s.invoices).toHaveLength(1);
    expect(s.invoices[0].counted).toBe("0.00");
    expect(s.invoices[0].why).toMatch(/counts if paid by/);
    await recordPayment(clerk, invA.id, { amount: "100.00", paid_on: invA.invoice_date });
    s = (await purchaseOptionStatus(lineA))!;
    expect(s.credit).toBe("0.00");
  });
  it("paid in full within 30 days: the rental charge (not tax or extras) counts at the percent", async () => {
    const left = (Number(invA.total) - 100).toFixed(2);
    await recordPayment(clerk, invA.id, { amount: left, paid_on: addDays(invA.invoice_date, 30) });
    const s = (await purchaseOptionStatus(lineA))!;
    expect(s.invoices[0].on_time).toBe(true);
    expect(Number(s.rentCounted)).toBeCloseTo(rentA, 2);
    expect(Number(s.credit)).toBeCloseTo(Math.round(rentA * 0.8 * 100) / 100, 2);
    expect(Number(s.balance)).toBeCloseTo(40000 - Number(s.credit), 2);
    expect(s.ready).toBe(false);
  });
  it("paid on day 31 is late and earns nothing", async () => {
    await setUpPurchaseOption(manager, lineB, { purchase_price: "1000", credit_percent: "50", term_months: "6" });
    await recordPayment(clerk, invB.id, { amount: invB.total, paid_on: addDays(invB.invoice_date, 31) });
    const s = (await purchaseOptionStatus(lineB))!;
    expect(s.invoices[0].on_time).toBe(false);
    expect(s.invoices[0].why).toMatch(/Paid late/);
    expect(s.credit).toBe("0.00");
  });
  it("when the term ends it's ready, and the balloon is price less credit", async () => {
    const o = (await purchaseOptionStatus(lineB))!.option;
    const s = (await purchaseOptionStatus(lineB, o.ends_on))!;
    expect(s.termEnded).toBe(true);
    expect(s.ready).toBe(true);
    expect(s.balance).toBe("1000.00");
    expect(s.readyText).toMatch(/balloon payment of \$1,000\.00/);
  });
});

describe("Buying it", () => {
  it("is ready on the dashboard once paid off, and converts to a draft sale only after call-off", async () => {
    // Lower the price below the earned credit to make it paid off.
    await cancelPurchaseOption(manager, lineA, "Re-set at a lower price for the test");
    await setUpPurchaseOption(manager, lineA, { purchase_price: "100", credit_percent: "80", term_months: "12" });
    const s = (await purchaseOptionStatus(lineA))!;
    expect(s.paidOff).toBe(true);
    expect(s.credit).toBe("100.00");
    expect(s.balance).toBe("0.00");
    expect((await purchaseOptionsReady()).map((r: any) => String(r.contract_line_id))).toContain(String(lineA));

    await expect(exercisePurchaseOption(clerk, lineA)).rejects.toThrow(/permission/);
    await expect(exercisePurchaseOption(manager, lineA)).rejects.toThrow(/Call off the rental first/);
    const before = await q(`SELECT id, total, status FROM invoices WHERE contract_line_id=$1`, [lineA]);
    await changeLineStatus(clerk, lineA, { status: "off_rent", date: "2026-11-30" });
    const sale = await exercisePurchaseOption(manager, lineA);
    expect(sale.status).toBe("draft");
    expect(sale.price).toBe("0.00");
    expect(sale.notes).toMatch(/purchase price \$100\.00 less rent credit \$100\.00/);
    expect((await one(`SELECT status FROM rental_contract_lines WHERE id=$1`, [lineA])).status).toBe("returned");
    expect((await purchaseOptionStatus(lineA))!.option).toMatchObject({ status: "exercised", credit_at_exercise: "100.00" });
    // Invoices were not touched.
    expect(await q(`SELECT id, total, status FROM invoices WHERE contract_line_id=$1`, [lineA])).toEqual(before);
    await expect(exercisePurchaseOption(manager, lineA)).rejects.toThrow(/no active/);
  });
  it("cancel needs a reason and leaves the rental alone", async () => {
    await expect(cancelPurchaseOption(manager, lineB, "no")).rejects.toThrow(/why/);
    await cancelPurchaseOption(manager, lineB, "Customer decided not to buy");
    expect((await one(`SELECT status FROM rental_contract_lines WHERE id=$1`, [lineB])).status).toBe("active");
  });
});
