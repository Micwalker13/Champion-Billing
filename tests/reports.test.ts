// Receivables and rental reports: aging buckets, statements, the month packet and rental activity.
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { one } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { assignPo } from "@/lib/services/pos";
import { approveInvoice, generateInvoice, issueInvoice, overrideCheck, recordPayment, submitForReview, validateInvoice } from "@/lib/services/invoices";
import { agingReport, bucketFor, customerStatement, monthPacket, rentalActivity } from "@/lib/services/reports";
import { renderStatementPdf } from "@/lib/pdf";
import { RPM_SAMPLE_UNITS } from "@/lib/sample-data";
import { addDays } from "@/lib/dates";
import { lineForUnit, pdfText, resetDb, userByRole } from "./helpers";

let manager: SessionUser, clerk: SessionUser, rpmId: string;
const ids: string[] = [];

async function approveFor(unit: string, i: number) {
  const u = RPM_SAMPLE_UNITS.find((x) => x.unit === unit)!;
  const line = await lineForUnit(unit);
  await assignPo(clerk, { lineId: line, period: "2026-11-01", poNumber: u.po, estimatedTotal: u.poTotal, jobNumber: u.job, workOrderNumber: u.wo });
  const inv = await generateInvoice(clerk, line, "2026-11-01");
  await submitForReview(clerk, inv.id);
  const checks = await validateInvoice(inv.id);
  for (const c of checks.filter((c) => (c.status === "fail" || c.status === "warn") && c.overridable && !c.override)) await overrideCheck(manager, inv.id, c.rule, `Report test ${i}: accepted`);
  await approveInvoice(manager, inv.id);
  return inv.id as string;
}

beforeAll(async () => {
  const seeded = await resetDb();
  rpmId = seeded.rpmId;
  [manager, clerk] = await Promise.all(["billing_manager", "billing_clerk"].map(userByRole));
  for (const [i, u] of RPM_SAMPLE_UNITS.slice(0, 3).entries()) ids.push(await approveFor(u.unit, i));
  for (const id of ids) await issueInvoice(manager, id);
});

describe("AR aging", () => {
  it("puts invoices in the right bucket by days past due", () => {
    expect([0, -5, 1, 30, 31, 60, 61, 90, 91, 400].map(bucketFor)).toEqual(["current", "current", "d1_30", "d1_30", "d31_60", "d31_60", "d61_90", "d61_90", "d90_plus", "d90_plus"]);
  });

  it("totals open balances exactly, nets partial payments and drops paid invoices", async () => {
    const first = await one(`SELECT invoice_date, due_date, total FROM invoices WHERE id=$1`, [ids[0]]);
    const t1 = await one(`SELECT total FROM invoices WHERE id=$1`, [ids[1]]);
    const t2 = await one(`SELECT total FROM invoices WHERE id=$1`, [ids[2]]);
    await recordPayment(manager, ids[1], { amount: "100.00", paid_on: first.invoice_date, method: "ACH", reference: "TEST-1" });
    await recordPayment(manager, ids[2], { amount: t2.total, paid_on: first.invoice_date, method: "Check", reference: "TEST-2" });

    const onTime = await agingReport(first.invoice_date);
    expect(onTime.invoices.map((i) => i.id).sort()).toEqual([ids[0], ids[1]].sort());
    const expected = (Number(first.total) + Number(t1.total) - 100).toFixed(2);
    expect(onTime.totals.total).toBe(expected);
    expect(onTime.totals.current).toBe(expected);
    expect(onTime.invoices.find((i) => i.id === ids[1])!.balance).toBe((Number(t1.total) - 100).toFixed(2));

    const late = await agingReport(addDays(first.due_date, 45));
    expect(late.totals.d31_60).toBe(expected);
    expect(late.totals.current).toBe("0.00");
    expect(late.customers).toHaveLength(1);
    expect(late.customers[0].customer_id).toBe(rpmId);
  });

  it("ignores drafts", async () => {
    const draft = await generateInvoice(clerk, await lineForUnit(RPM_SAMPLE_UNITS[5].unit), "2026-11-01");
    const r = await agingReport("2030-01-01");
    expect(r.invoices.find((i) => i.id === draft.id)).toBeUndefined();
  });
});

describe("Customer statement", () => {
  it("lists open invoices with PO, aging totals and payments", async () => {
    const asOf = (await one(`SELECT due_date FROM invoices WHERE id=$1`, [ids[0]])).due_date;
    const s = await customerStatement(rpmId, addDays(asOf, 10));
    expect(s.invoices).toHaveLength(2);
    expect(Number(s.totals.d1_30)).toBeGreaterThan(0);
    expect(s.payments.map((p) => p.reference).sort()).toEqual(["TEST-1", "TEST-2"]);
    const text = pdfText(await renderStatementPdf(s));
    expect(text).toContain("STATEMENT");
    for (const inv of s.invoices) { expect(text).toContain(inv.invoice_number); expect(text).toContain(inv.po_number!); }
    expect(text).toContain("TOTAL BALANCE DUE");
  });
});

describe("Month packet", () => {
  it("combines the stored PDFs of the month's approved invoices, in unit order, and skips drafts", async () => {
    const r = await monthPacket(rpmId, "2026-11-01");
    expect(r.count).toBe(3);
    const merged = await PDFDocument.load(r.pdf);
    let expectedPages = 0;
    for (const id of ids) {
      const doc = await one(`SELECT d.pdf FROM invoice_documents d WHERE d.invoice_id=$1`, [id]);
      expectedPages += (await PDFDocument.load(doc.pdf)).getPageCount();
    }
    expect(merged.getPageCount()).toBe(expectedPages);
    const text = pdfText(r.pdf);
    for (const n of r.invoiceNumbers) expect(text).toContain(n);
    expect(text).not.toContain("DRAFT INVOICE");
  });

  it("refuses a month with nothing approved", async () => {
    await expect(monthPacket(rpmId, "2027-03-01")).rejects.toThrow(/No approved invoices/);
  });
});

describe("Rental activity", () => {
  it("counts days on rent in the month and shows billed-through from approved invoices only", async () => {
    const r = await rentalActivity("2026-11-01", rpmId);
    const row = r.rows.find((x: any) => x.unit_number === RPM_SAMPLE_UNITS[0].unit)!;
    expect(row.days_on_rent).toBe(30);
    expect(row.billed_through).toBe("2026-11-30");
    const total = await one(`SELECT total FROM invoices WHERE id=$1`, [ids[0]]);
    expect(Number(row.billed_this_month)).toBe(Number(total.total));
    const draftOnly = r.rows.find((x: any) => x.unit_number === RPM_SAMPLE_UNITS[5].unit)!;
    expect(draftOnly.billed_through).toBeNull();
    expect(Number(draftOnly.billed_this_month)).toBe(0);
    // The returned sample unit (off rent 2026-10-15) is not in November's activity.
    expect(r.rows.find((x: any) => x.unit_number === "SSL018877")).toBeUndefined();
  });
});
