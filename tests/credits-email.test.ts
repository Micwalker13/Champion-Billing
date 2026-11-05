// Credit memos, emailing invoices, and the utilization report.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { assignPo } from "@/lib/services/pos";
import { approveInvoice, generateInvoice, issueInvoice, overrideCheck, recordPayment, submitForReview, validateInvoice, voidInvoice } from "@/lib/services/invoices";
import { creditPdf, issueCredit } from "@/lib/services/credits";
import { emailEnabled, emailInvoice, emailMonth, mailSettings, parseAddresses, setInvoiceEmails, setTestSender } from "@/lib/services/email";
import { agingReport, customerStatement, utilization } from "@/lib/services/reports";
import { createEquipment } from "@/lib/services/records";
import { exchangeUnit } from "@/lib/services/inventory";
import { RPM_SAMPLE_UNITS } from "@/lib/sample-data";
import { lineForUnit, pdfText, resetDb, userByRole } from "./helpers";

let manager: SessionUser, clerk: SessionUser, rpmId: string;
const ids: string[] = [];
const sent: any[] = [];

async function approveFor(i: number) {
  const u = RPM_SAMPLE_UNITS[i];
  const line = await lineForUnit(u.unit);
  await assignPo(clerk, { lineId: line, period: "2026-11-01", poNumber: u.po, estimatedTotal: u.poTotal, jobNumber: u.job, workOrderNumber: u.wo });
  const inv = await generateInvoice(clerk, line, "2026-11-01");
  await submitForReview(clerk, inv.id);
  for (const c of (await validateInvoice(inv.id)).filter((c) => (c.status === "fail" || c.status === "warn") && c.overridable && !c.override)) await overrideCheck(manager, inv.id, c.rule, "Test: accepted");
  await approveInvoice(manager, inv.id);
  return inv.id as string;
}

beforeAll(async () => {
  const seeded = await resetDb();
  rpmId = seeded.rpmId;
  [manager, clerk] = await Promise.all(["billing_manager", "billing_clerk"].map(userByRole));
  for (const i of [0, 1, 2, 3]) ids.push(await approveFor(i));
  setTestSender(async (m) => { sent.push(m); return { messageId: `<test-${sent.length}@local>` }; });
});
afterAll(() => setTestSender(null));

describe("Credit memos", () => {
  it("credits part of an invoice with tax, keeps the original unchanged, and lowers the balance", async () => {
    await issueInvoice(manager, ids[0]);
    const before = await one(`SELECT * FROM invoices WHERE id=$1`, [ids[0]]);
    await expect(issueCredit(clerk, ids[0], { amount: "100.00", reason: "Unit down one day" })).rejects.toThrow(/permission/);
    const c = await issueCredit(manager, ids[0], { amount: "100.00", creditTax: true, reason: "Unit down one day for repair" });
    expect(c.credit_number).toBe(`${before.invoice_number}-CM1`);
    const tax = (100 * Number(before.tax_rate)).toFixed(2);
    expect(c.total).toBe((100 + Number(tax)).toFixed(2));
    const after = await one(`SELECT * FROM invoices WHERE id=$1`, [ids[0]]);
    expect(after.total).toBe(before.total);
    expect(after.pdf_sha256).toBe(before.pdf_sha256);
    expect(after.amount_credited).toBe(c.total);
    expect(after.status).toBe("issued");
    const pdf = pdfText((await creditPdf(c.id)).pdf);
    expect(pdf).toContain("CREDIT MEMO");
    expect(pdf).toContain(before.po_number);
    expect(pdf).toContain(before.invoice_number);
    // Permanent, and counted in money owed and on the statement.
    await expect(q(`UPDATE credit_memos SET total=1 WHERE id=$1`, [c.id])).rejects.toThrow();
    const row = (await agingReport("2030-01-01")).invoices.find((i) => i.id === ids[0])!;
    expect(row.balance).toBe((Number(before.total) - Number(c.total)).toFixed(2));
    const st = await customerStatement(rpmId, after.invoice_date);
    expect(st.payments.map((p) => p.reference)).toContain(c.credit_number);
    // A credited invoice can't be voided or revised away.
    await expect(voidInvoice(manager, ids[0], "Trying to void")).rejects.toThrow(/Credits were issued/);
  });

  it("won't credit more than is owed, and a full credit closes the invoice", async () => {
    const inv = await one(`SELECT * FROM invoices WHERE id=$1`, [ids[1]]);
    await expect(issueCredit(manager, ids[1], { amount: (Number(inv.subtotal) + 1).toFixed(2), reason: "Too much credit" })).rejects.toThrow(/can't exceed/);
    await issueInvoice(manager, ids[1]);
    await recordPayment(manager, ids[1], { amount: "500.00", paid_on: "2026-11-20" });
    await expect(issueCredit(manager, ids[1], { amount: inv.subtotal, reason: "Whole month disputed" })).rejects.toThrow(/open balance/);
    // Credit the rest exactly: balance after payment, split back into before-tax and tax.
    const c3 = await issueCredit(manager, ids[2], { amount: (await one(`SELECT subtotal FROM invoices WHERE id=$1`, [ids[2]])).subtotal, reason: "Billed in error, machine was returned" });
    const closed = await one(`SELECT status, amount_credited, total FROM invoices WHERE id=$1`, [ids[2]]);
    expect(closed.amount_credited).toBe(closed.total);
    expect(closed.status).toBe("credited");
    expect(c3.total).toBe(closed.total);
    expect((await agingReport("2030-01-01")).invoices.find((i) => i.id === ids[2])).toBeUndefined();
  });
});

describe("Emailing invoices", () => {
  it("is off without mail settings", () => {
    expect(mailSettings({})).toBeNull();
    expect(mailSettings({ SMTP_HOST: "smtp.office365.com", SMTP_USER: "b@x.com", SMTP_PASS: "p", INVOICE_FROM: "b@x.com" })?.port).toBe(587);
    expect(emailEnabled()).toBe(true); // the test stub is in place
    expect(() => parseAddresses("ap@rpm.com, not-an-email")).toThrow(/not-an-email/);
  });

  it("sends each invoice with the PO in the subject and the stored PDF attached, logs it, and marks it issued", async () => {
    const email = (await one(`SELECT email FROM customers WHERE id=$1`, [rpmId])).email;
    await q(`UPDATE customers SET email=NULL WHERE id=$1`, [rpmId]);
    await expect(emailInvoice(manager, ids[3])).rejects.toThrow(/no invoice email/);
    await q(`UPDATE customers SET email=$2 WHERE id=$1`, [rpmId, email]);
    await setInvoiceEmails(clerk, rpmId, "AP@rpmx.example.com; billing@rpmx.example.com");
    const inv = await one(`SELECT * FROM invoices WHERE id=$1`, [ids[3]]);
    expect(inv.status).toBe("approved");
    const r = await emailInvoice(manager, ids[3]);
    expect(r.to).toEqual(["ap@rpmx.example.com", "billing@rpmx.example.com"]);
    const m = sent.at(-1);
    expect(m.subject).toContain(`Invoice ${inv.invoice_number}`);
    expect(m.subject).toContain(`PO ${inv.po_number}`);
    expect(m.subject).toContain(RPM_SAMPLE_UNITS[3].unit);
    expect(m.attachments[0].filename).toBe(`${inv.invoice_number}.pdf`);
    const doc = await one(`SELECT pdf FROM invoice_documents WHERE invoice_id=$1`, [ids[3]]);
    expect(Buffer.compare(m.attachments[0].content, doc.pdf)).toBe(0);
    expect((await one(`SELECT status FROM invoices WHERE id=$1`, [ids[3]])).status).toBe("issued");
    expect((await q(`SELECT status FROM document_emails WHERE doc_kind='invoice' AND doc_id=$1`, [ids[3]])).map((x) => x.status)).toEqual(["sent"]);
  });

  it("emails the month's approved invoices that weren't sent yet, and logs failures", async () => {
    const before = sent.length;
    const r = await emailMonth(manager, rpmId, "2026-11-01");
    expect(r.every((x) => x.ok)).toBe(true);
    expect(r).toHaveLength(3); // ids[0..2]; ids[3] was already emailed
    expect(sent.length - before).toBe(3);
    expect(await emailMonth(manager, rpmId, "2026-11-01")).toEqual([]);
    setTestSender(async () => { throw new Error("535 Authentication unsuccessful"); });
    await expect(emailInvoice(manager, ids[0])).rejects.toThrow(/did not go out: 535/);
    expect((await one(`SELECT status, error FROM document_emails WHERE doc_id=$1 ORDER BY id DESC LIMIT 1`, [ids[0]]))).toEqual({ status: "failed", error: "535 Authentication unsuccessful" });
    setTestSender(async (m) => { sent.push(m); return {}; });
  });
});

describe("Utilization", () => {
  it("counts days on rent per unit, follows exchanges, and splits billed rental between units", async () => {
    await createEquipment(clerk, { unit_number: "IDLE01", description: "Idle unit", category: "Test" });
    await createEquipment(clerk, { unit_number: "SWAP01", description: "Swap unit", category: "Test" });
    const line = await lineForUnit(RPM_SAMPLE_UNITS[0].unit);
    await exchangeUnit(clerk, line, { in_unit: "SWAP01", exchange_date: "2026-11-21", reason: "Swap for test" });
    const r = await utilization("2026-11-01");
    const get = (u: string) => r.rows.find((x: any) => x.unit_number === u)!;
    expect(get("IDLE01").days_on_rent).toBe(0);
    expect(get(RPM_SAMPLE_UNITS[0].unit).days_on_rent).toBe(20);
    expect(get("SWAP01").days_on_rent).toBe(10);
    const rental = Number((await one(`SELECT amount FROM invoice_lines WHERE invoice_id=$1 AND kind='rental'`, [ids[0]])).amount);
    expect(Number(get(RPM_SAMPLE_UNITS[0].unit).revenue) + Number(get("SWAP01").revenue)).toBeCloseTo(rental, 1);
    expect(get(RPM_SAMPLE_UNITS[1].unit).days_on_rent).toBe(30);
    expect(r.totals.idle).toBeGreaterThanOrEqual(1);
    expect(r.categories.find((c) => c.category === "Test")!.units).toBe(2);
  });
});
