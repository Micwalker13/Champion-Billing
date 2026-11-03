/**
 * Champion's mandatory acceptance tests (section 15), run against a real PostgreSQL database.
 * Each `it` is named after the test it demonstrates. They run in order and share state, like a real month-end.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { one, pool, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { assignPo } from "@/lib/services/pos";
import { approveInvoice, DuplicateInvoiceError, generateInvoice, invoicePdf, issueInvoice, overrideCheck, refreshInvoice, reviseInvoice, submitForReview, validateInvoice, invoiceDetail, generateMonthForCustomer } from "@/lib/services/invoices";
import { applyImportBatch, approveCleanRows, createImportBatch, decideImportRow, editImportRow, importDetail } from "@/lib/services/imports";
import { approveProrationPolicy, changeLineStatus, createEquipment, createRental, updateRentalTerms } from "@/lib/services/records";
import { RPM_SAMPLE_UNITS, rpmPoCsv, decemberPo } from "@/lib/sample-data";
import { lineForUnit, pdfText, resetDb, userByRole } from "./helpers";

let admin: SessionUser, manager: SessionUser, clerk: SessionUser, viewer: SessionUser;
let rpmId: string, line2101: string;
const inv: Record<string, string> = {};

/** Clerk submits, manager documents the placeholder exception and approves. */
async function submitAndApprove(id: string, extraOverrides: Record<string, string> = {}) {
  await submitForReview(clerk, id);
  const checks = await validateInvoice(id);
  if (checks.find((c) => c.rule === "placeholders" && c.status === "warn")) await overrideCheck(manager, id, "placeholders", "Test environment: placeholder company details accepted");
  for (const [rule, reason] of Object.entries(extraOverrides)) await overrideCheck(manager, id, rule, reason);
  return approveInvoice(manager, id);
}

beforeAll(async () => {
  const seeded = await resetDb();
  rpmId = seeded.rpmId;
  [admin, manager, clerk, viewer] = await Promise.all(["admin", "billing_manager", "billing_clerk", "viewer"].map(userByRole));
  line2101 = await lineForUnit("MUR002101");
});

describe("Champion acceptance tests", () => {
  it("Test 1 — Continuous rental: Nov, Dec and Jan invoices from one rental without closing or restarting it", async () => {
    const before = await one(`SELECT c.id, c.contract_number, c.status, l.status AS line_status, l.on_rent_date FROM rental_contracts c JOIN rental_contract_lines l ON l.contract_id=c.id WHERE l.id=$1`, [line2101]);
    expect(before.on_rent_date < "2026-11-01").toBe(true);
    for (const m of ["2026-11-01", "2026-12-01", "2027-01-01"]) inv[m] = (await generateInvoice(clerk, line2101, m)).id;
    const after = await one(`SELECT c.id, c.contract_number, c.status, l.status AS line_status FROM rental_contracts c JOIN rental_contract_lines l ON l.contract_id=c.id WHERE l.id=$1`, [line2101]);
    expect(after).toEqual({ id: before.id, contract_number: "CE-10025", status: "active", line_status: "active" });
    const rows = await q(`SELECT contract_id, contract_line_id FROM invoices WHERE contract_line_id=$1`, [line2101]);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.contract_id)).size).toBe(1);
    expect((await q(`SELECT 1 FROM rental_contracts WHERE contract_number LIKE 'CE-10025%'`)).length).toBe(1);
  });

  it("Test 2 — Independent PO numbers: Nov keeps 459186 when December gets a different PO", async () => {
    await assignPo(clerk, { lineId: line2101, period: "2026-11-01", poNumber: "459186", estimatedTotal: "2083.00", jobNumber: "5276", workOrderNumber: "184139" });
    await assignPo(clerk, { lineId: line2101, period: "2026-12-01", poNumber: "512345", estimatedTotal: "2083.00", jobNumber: "5276", workOrderNumber: "184139" });
    await refreshInvoice(clerk, inv["2026-11-01"]);
    await refreshInvoice(clerk, inv["2026-12-01"]);
    const nov = await one(`SELECT po_number FROM invoices WHERE id=$1`, [inv["2026-11-01"]]);
    const dec = await one(`SELECT po_number FROM invoices WHERE id=$1`, [inv["2026-12-01"]]);
    expect(nov.po_number).toBe("459186");
    expect(dec.po_number).toBe("512345");
    // The same PO cannot be reused for another month or machine (RPM rule)
    await expect(assignPo(clerk, { lineId: line2101, period: "2027-01-01", poNumber: "459186" })).rejects.toThrow(/already assigned/);
    // Invalid formats are rejected
    await expect(assignPo(clerk, { lineId: line2101, period: "2027-01-01", poNumber: "359186" })).rejects.toThrow(/format/);
    await expect(assignPo(clerk, { lineId: line2101, period: "2027-01-01", poNumber: "45918" })).rejects.toThrow(/format/);
  });

  let novPdfSha = "";
  let novRowBefore: any;
  it("Test 3 — Historical invoice preservation: Nov PDF, PO, dates, charges and total never change", async () => {
    const res = await submitAndApprove(inv["2026-11-01"]);
    expect(res.invoice_number).toBe("CE-INV-100001");
    await issueInvoice(manager, inv["2026-11-01"]);
    const first = await invoicePdf(inv["2026-11-01"]);
    novPdfSha = createHash("sha256").update(first.pdf).digest("hex");
    novRowBefore = await one(`SELECT invoice_number, po_number, period_start, period_end, subtotal, tax_amount, total, snapshot, invoice_date, due_date FROM invoices WHERE id=$1`, [inv["2026-11-01"]]);
    const text = pdfText(first.pdf);
    expect(text).toContain("CUSTOMER PO NUMBER");
    expect(text).toContain("459186");
    expect(text).toContain("CE-10025");

    // Now change everything about the rental going forward:
    await assignPo(manager, { lineId: line2101, period: "2026-11-01", poNumber: "459999", replaceExisting: true, reason: "RPM re-issued November PO (test)" });
    await assignPo(manager, { lineId: line2101, period: "2026-12-01", poNumber: "523456", replaceExisting: true, reason: "RPM changed December PO (test)" });
    await updateRentalTerms(manager, line2101, { rate_amount: "2500.00", job_number: "9999", work_order_number: "999999", note: "Rate increase from December (test)" });
    await pool().query(`UPDATE customers SET name='RPM xConstruction RENAMED' WHERE id=$1`, [rpmId]);

    const second = await invoicePdf(inv["2026-11-01"]);
    expect(createHash("sha256").update(second.pdf).digest("hex")).toBe(novPdfSha);
    const novRowAfter = await one(`SELECT invoice_number, po_number, period_start, period_end, subtotal, tax_amount, total, snapshot, invoice_date, due_date FROM invoices WHERE id=$1`, [inv["2026-11-01"]]);
    expect(novRowAfter).toEqual(novRowBefore);
    expect(novRowAfter.po_number).toBe("459186");
    expect(novRowAfter.total).toBe("2083.00");

    // The database itself refuses to rewrite a finalized invoice, its lines or its PDF.
    await expect(pool().query(`UPDATE invoices SET po_number='459999' WHERE id=$1`, [inv["2026-11-01"]])).rejects.toThrow(/finalized/);
    await expect(pool().query(`UPDATE invoices SET total=1 WHERE id=$1`, [inv["2026-11-01"]])).rejects.toThrow(/finalized/);
    await expect(pool().query(`UPDATE invoice_lines SET amount=1 WHERE invoice_id=$1`, [inv["2026-11-01"]])).rejects.toThrow(/frozen/);
    await expect(pool().query(`DELETE FROM invoice_documents WHERE invoice_id=$1`, [inv["2026-11-01"]])).rejects.toThrow(/append-only/);
    await expect(pool().query(`DELETE FROM po_assignments`)).rejects.toThrow(/permanent/);

    // PO history is preserved with who/when/why.
    const hist = await q(`SELECT p.po_number, a.status, a.reason, a.assigned_by FROM po_assignments a JOIN purchase_orders p ON p.id=a.purchase_order_id JOIN billing_periods bp ON bp.id=a.billing_period_id
                          WHERE a.contract_line_id=$1 AND bp.period_start='2026-11-01' ORDER BY a.id`, [line2101]);
    expect(hist.map((h) => [h.po_number, h.status])).toEqual([["459186", "superseded"], ["459999", "active"]]);
    expect(hist[1].reason).toMatch(/re-issued/);
    const auditRows = await q(`SELECT action FROM audit_log WHERE entity='po_assignment' AND action='correct_po'`);
    expect(auditRows.length).toBe(2);

    // Correction happens only through an auditable revision; the original stays intact.
    const rev = await reviseInvoice(manager, inv["2026-11-01"], "Reissue with corrected November PO 459999 (test)");
    expect(rev.po_number).toBe("459999");
    expect(rev.revision_no).toBe(1);
    const original = await one(`SELECT status, po_number, total FROM invoices WHERE id=$1`, [inv["2026-11-01"]]);
    expect(original).toEqual({ status: "corrected", po_number: "459186", total: "2083.00" });
    expect(createHash("sha256").update((await invoicePdf(inv["2026-11-01"])).pdf).digest("hex")).toBe(novPdfSha);
    // Revision keeps the November period and the old rate (rate change applies only to the rental going forward, here it is the current rate)
    expect(rev.period_start).toBe("2026-11-01");
    // restore so later tests use the agreed rate
    await updateRentalTerms(manager, line2101, { rate_amount: "1924.25", job_number: "5276", work_order_number: "184139", note: "Restore (test)" });
    await pool().query(`UPDATE customers SET name='RPM xConstruction' WHERE id=$1`, [rpmId]);
    const revApproved = await submitAndApprove(rev.id);
    expect(revApproved.invoice_number).toBe("CE-INV-100001-R1");
  });

  let batchId = "";
  it("Test 4 — Bulk import: 26-unit RPM file matches every machine; mismatches are flagged and nothing changes without approval", async () => {
    // December file: every unit gets a new PO. (MUR002101 already has 523456 for December from Test 3 → flagged as a replacement.)
    const csv = Buffer.from(rpmPoCsv(RPM_SAMPLE_UNITS, decemberPo));
    const b = await createImportBatch(clerk, { customerId: rpmId, billingMonth: "2026-12-01", filename: "RPM-POs-Dec-2026.csv", content: csv });
    batchId = b.id;
    let d = (await importDetail(batchId))!;
    expect(d.rows).toHaveLength(26);
    for (const r of d.rows) {
      const expected = RPM_SAMPLE_UNITS.find((u) => u.unit === r.unit_number)!;
      const m = await one(`SELECT e.unit_number, c.contract_number FROM rental_contract_lines l JOIN equipment e ON e.id=l.equipment_id JOIN rental_contracts c ON c.id=l.contract_id WHERE l.id=$1`, [r.matched_line_id]);
      expect(m).toEqual({ unit_number: expected.unit, contract_number: expected.contract });
    }
    expect(d.batch.summary.matched).toBe(26);
    expect(d.batch.summary.with_errors).toBe(0);
    expect(d.batch.summary.missing_from_file).toEqual([]);
    const flagged = d.rows.find((r) => r.unit_number === "MUR002101")!;
    expect(flagged.issues.map((i: any) => i.code)).toContain("replaces_po");

    // Nothing is assigned until approved and applied.
    expect((await q(`SELECT 1 FROM po_assignments WHERE import_row_id IS NOT NULL`)).length).toBe(0);
    await expect(applyImportBatch(manager, batchId)).rejects.toThrow(/need a decision/);
    expect(await approveCleanRows(clerk, batchId)).toBe(25);
    await decideImportRow(clerk, flagged.id, "approved", "RPM confirmed the new December PO by email");
    await expect(applyImportBatch(clerk, batchId)).rejects.toThrow(/permission/);   // clerks prepare, managers apply
    const applied = await applyImportBatch(manager, batchId);
    expect(applied).toHaveLength(26);
    const decAssignments = await q(`SELECT e.unit_number, p.po_number FROM po_assignments a JOIN purchase_orders p ON p.id=a.purchase_order_id JOIN equipment e ON e.id=a.equipment_id
                                     JOIN billing_periods bp ON bp.id=a.billing_period_id WHERE a.status='active' AND bp.period_start='2026-12-01'`);
    expect(decAssignments).toHaveLength(26);
    RPM_SAMPLE_UNITS.forEach((u, i) => expect(decAssignments.find((a) => a.unit_number === u.unit)!.po_number).toBe(decemberPo(u, i)));

    // The same file can never be processed twice.
    await expect(createImportBatch(clerk, { customerId: rpmId, billingMonth: "2026-12-01", filename: "again.csv", content: csv })).rejects.toThrow(/already imported/);
  });

  it("Test 4b — Bulk import flags: unknown, duplicate, returned, invalid, missing PO, job conflict, missing rentals, variance", async () => {
    // January file with deliberate problems, built from the real November examples.
    const rows = [
      "PO Number,Unit,Work Order,Job,PO Total",
      "459500,MUR002101,184139,5276,2083.00",         // clean
      "459501,MUR002035,178493,4814,1562.25",          // unknown unit (real unit is MUR02035)
      "359502,MUR002102,184140,5430,2083.00",          // invalid PO format
      ",SSL019098,160063,5398,3169.50",                // missing PO
      "459504,SSL018877,170001,5276,3169.50",          // returned unit
      "459505,MUR0021" + "10,184200,7777,2083.00",     // job conflict (rental job is 5276)
      "459506,MUR002110,184200,5276,2083.00",          // duplicate unit
      "459507,SSL019111,184201,5430,9999.99",          // big variance vs calculated
      "459508,CTL004512,184202,4814,3518.13",          // clean
    ].join("\n");
    const b = await createImportBatch(clerk, { customerId: rpmId, billingMonth: "2027-01-01", filename: "RPM-POs-Jan-2027.csv", content: Buffer.from(rows) });
    const d = (await importDetail(b.id))!;
    const codes = (unit: string, po?: string) => d.rows.filter((r) => r.unit_number === unit && (po === undefined || r.po_number === po)).flatMap((r) => r.issues.map((i: any) => i.code));
    expect(codes("MUR002035")).toContain("unknown_unit");
    expect(d.rows.find((r) => r.unit_number === "MUR002035")!.issues[0].message).toMatch(/MUR02035/);
    expect(codes("MUR002102")).toContain("invalid_po");
    expect(codes("SSL019098")).toContain("missing_po");
    expect(codes("SSL018877")).toContain("unit_returned");
    expect(codes("MUR002110", "459505")).toEqual(expect.arrayContaining(["job_conflict", "duplicate_unit"]));
    expect(codes("SSL019111")).toContain("total_variance");
    expect(d.batch.summary.missing_from_file.length).toBe(26 - 6); // units active but absent from the January file
    // Rows with errors cannot be approved…
    const unknown = d.rows.find((r) => r.unit_number === "MUR002035")!;
    await expect(decideImportRow(clerk, unknown.id, "approved")).rejects.toThrow(/errors/);
    // …until an employee corrects them.
    await editImportRow(clerk, unknown.id, { unit_number: "MUR02035", note: "Typo in RPM file; confirmed by phone" });
    const fixed = (await importDetail(b.id))!.rows.find((r) => r.id === unknown.id)!;
    expect(fixed.issues.filter((i: any) => i.severity === "error")).toEqual([]);
    expect(fixed.matched_line_id).toBe(await lineForUnit("MUR02035"));
  });

  it("Test 5 — Calendar billing: Nov 1–30 and Dec 1–31 with no duplicated or omitted days", async () => {
    const rows = await q(`SELECT period_start, period_end FROM invoices WHERE contract_line_id=$1 AND status NOT IN ('voided','corrected') ORDER BY period_start`, [line2101]);
    expect(rows.map((r) => [r.period_start, r.period_end])).toEqual([["2026-11-01", "2026-11-30"], ["2026-12-01", "2026-12-31"], ["2027-01-01", "2027-01-31"]]);
    // Bulk-generate December for all RPM units and check the same.
    const results = await generateMonthForCustomer(clerk, rpmId, "2026-12-01");
    expect(results.filter((r) => r.status === "created")).toHaveLength(25);
    expect(results.find((r) => r.unit === "MUR002101")!.status).toBe("exists");
    const dec = await q(`SELECT DISTINCT period_start, period_end FROM invoices WHERE customer_id=$1 AND period_start >= '2026-12-01' AND period_start < '2027-01-01'`, [rpmId]);
    expect(dec).toEqual([{ period_start: "2026-12-01", period_end: "2026-12-31" }]);
    const d = await one(`SELECT total FROM invoices WHERE id=$1`, [inv["2026-12-01"]]);
    expect(d.total).toBe("2083.00"); // full month at monthly rate, regardless of 31 days
  });

  it("Test 6 — Missing PO: an invoice without a valid monthly PO cannot be released, with a clear reason", async () => {
    const jan = inv["2027-01-01"];
    await submitForReview(clerk, jan);
    const checks = await validateInvoice(jan);
    const po = checks.find((c) => c.rule === "po_present")!;
    expect(po.status).toBe("fail");
    expect(po.message).toMatch(/No purchase order is assigned to unit MUR002101/);
    await expect(approveInvoice(manager, jan)).rejects.toThrow(/Valid PO for this billing period/);
    expect((await one(`SELECT status, invoice_number FROM invoices WHERE id=$1`, [jan]))).toEqual({ status: "pending_review", invoice_number: null });
    // Clerks can't override; managers can only with a recorded reason.
    await expect(overrideCheck(clerk, jan, "po_present", "please")).rejects.toThrow(/permission/);
    await expect(overrideCheck(manager, jan, "po_present", "")).rejects.toThrow(/reason/);
  });

  it("Test 7 — Invoice amount verification: variance vs RPM's estimated PO total is shown, rates are not altered", async () => {
    const line = await lineForUnit("MUR002102");
    await assignPo(clerk, { lineId: line, period: "2026-11-01", poNumber: "459381", estimatedTotal: "2000.00", jobNumber: "5430", workOrderNumber: "184140" });
    const created = await generateInvoice(clerk, line, "2026-11-01");
    const d = (await invoiceDetail(created.id))!;
    expect(d.reconciliation).toMatchObject({ poTotal: "2000.00", subtotal: "1924.25", tax: "158.75", total: "2083.00", variance: "83.00", pct: "4.15", within: false });
    expect(d.checks.find((c) => c.rule === "po_variance")!.status).toBe("warn");
    expect((await one(`SELECT rate_amount FROM rental_contract_lines WHERE id=$1`, [line])).rate_amount).toBe("1924.25");
    // Approval requires a documented variance approval.
    await submitForReview(clerk, created.id);
    await overrideCheck(manager, created.id, "placeholders", "Test environment: placeholder company details accepted");
    await expect(approveInvoice(manager, created.id)).rejects.toThrow(/PO estimate/);
    await overrideCheck(manager, created.id, "po_variance", "RPM estimate excluded tax; confirmed with RPM AP");
    const ok = await approveInvoice(manager, created.id);
    expect(ok.invoice_number).toMatch(/^CE-INV-/);
    const o = await one(`SELECT reason FROM invoice_overrides WHERE invoice_id=$1 AND rule='po_variance'`, [created.id]);
    expect(o.reason).toMatch(/RPM estimate/);
  });

  it("Test 8 — Original contract: every monthly invoice references the original agreement and carries it as an attachment", async () => {
    const rows = await q(`SELECT id, snapshot FROM invoices WHERE contract_line_id=$1`, [line2101]);
    for (const r of rows) {
      expect(r.snapshot.contract.number).toBe("CE-10025");
      const att = await q(`SELECT d.filename FROM invoice_attachments a JOIN contract_documents d ON d.id=a.contract_document_id WHERE a.invoice_id=$1`, [r.id]);
      expect(att.map((a) => a.filename)).toEqual(["CE-10025-agreement-SAMPLE.pdf"]);
    }
    const pdf = await PDFDocument.load((await invoicePdf(inv["2026-11-01"])).pdf);
    expect(pdf.getPageCount()).toBe(2); // invoice + appended agreement
    // A rental without its agreement on file cannot be released for RPM.
    await createEquipment(clerk, { unit_number: "MUR002199", description: "Mini excavator 3.5T (test)", serial_number: "T-2199" });
    const { line } = await createRental(clerk, { contract_number: "CE-TEST-1", customer_id: rpmId, unit_number: "MUR002199", jobsite_name: "Test", jobsite_address: "1 Test Rd, Houston TX",
      job_number: "5276", work_order_number: "184999", start_date: "2026-10-20", billing_start_date: "2026-11-01", rate_amount: "1924.25", rate_basis: "monthly" });
    const created = await generateInvoice(clerk, line.id, "2026-11-01");
    expect((await validateInvoice(created.id)).find((c) => c.rule === "attachment")!.status).toBe("fail");
  });

  it("Test 9 — No duplicate billing: generating the same unit + period twice is detected and blocked", async () => {
    const err = await generateInvoice(clerk, line2101, "2026-12-01").catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateInvoiceError);
    expect(err.message).toMatch(/already exists/);
    expect(err.existing.id).toBe(inv["2026-12-01"]);
    // Even a direct database insert of an overlapping period is refused.
    await expect(pool().query(`INSERT INTO billing_periods(contract_line_id,period_start,period_end) VALUES ($1,'2026-11-15','2026-12-14')`, [line2101])).rejects.toThrow(/exclu|conflict/i);
    const bp = await one(`SELECT * FROM billing_periods WHERE contract_line_id=$1 AND period_start='2026-12-01'`, [line2101]);
    await expect(pool().query(`INSERT INTO invoices(customer_id,contract_id,contract_line_id,billing_period_id,period_start,period_end,snapshot,calc_details) SELECT customer_id,contract_id,contract_line_id,billing_period_id,period_start,period_end,snapshot,calc_details FROM invoices WHERE id=$1`, [inv["2026-12-01"]]))
      .rejects.toThrow(/invoices_one_live_per_period/);
    expect(bp).toBeTruthy();
  });

  it("Test 10 — Runs independently of Quipli: no Quipli integration, no outbound calls, Quipli references are read-only text", () => {
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => { const p = path.join(d, f); statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) && files.push(p); });
    walk(path.join(__dirname, "..", "src"));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\bfetch\(|axios|https?\.request|node:https|quipli\.com|api\.quipli/i);
    }
  });

  it("Permissions — viewers cannot change data; clerks cannot approve; submitters cannot self-approve", async () => {
    await expect(assignPo(viewer, { lineId: line2101, period: "2027-02-01", poNumber: "459777" })).rejects.toThrow(/permission/);
    const line = await lineForUnit("SSL019098");
    const created = await generateInvoice(manager, line, "2026-11-01").catch(async () => one(`SELECT id FROM invoices WHERE contract_line_id=$1 AND period_start='2026-11-01'`, [line]));
    await expect(approveInvoice(clerk, created.id)).rejects.toThrow(/permission/);
    await assignPo(manager, { lineId: line, period: "2026-11-01", poNumber: "459201", estimatedTotal: "3169.50" });
    await submitForReview(manager, created.id);
    await expect(approveInvoice(manager, created.id)).rejects.toThrow(/different employee/);
  });

  it("Concurrency — PO assignment and invoice generation for the same new period can run at the same time", async () => {
    const results = await Promise.allSettled([
      assignPo(clerk, { lineId: line2101, period: "2027-03-01", poNumber: "459888", estimatedTotal: "2083.00" }),
      generateInvoice(manager, line2101, "2027-03-01"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await q(`SELECT 1 FROM billing_periods WHERE contract_line_id=$1 AND period_start='2027-03-01'`, [line2101])).length).toBe(1);
  });

  it("Proration — partial periods are blocked until a policy is approved, then follow it exactly", async () => {
    const line = await lineForUnit("MUR002102");
    await changeLineStatus(clerk, line, { status: "off_rent", date: "2027-01-10", note: "RPM called off unit (test)" });
    await expect(generateInvoice(clerk, line, "2027-01-01")).rejects.toThrow(/proration policy has not been approved/);
    await expect(approveProrationPolicy(admin, rpmId, "actual_days", "")).rejects.toThrow(/approved/);
    await approveProrationPolicy(admin, rpmId, "actual_days", "TEST ONLY — real RPM policy pending Quipli confirmation");
    const created = await generateInvoice(clerk, line, "2027-01-01");
    expect(created.period_start).toBe("2027-01-01");
    expect(created.period_end).toBe("2027-01-10");
    expect(created.subtotal).toBe("620.73");
    await approveProrationPolicy(admin, rpmId, "unapproved", "");
  });
});
