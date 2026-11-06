// Sales tax exemptions: agricultural, resale, interstate.
import { beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { assignPo } from "@/lib/services/pos";
import { approveInvoice, generateInvoice, invoicePdf, issueInvoice, overrideCheck, refreshInvoice, submitForReview, validateInvoice } from "@/lib/services/invoices";
import { createSale } from "@/lib/services/sales";
import { createEquipment } from "@/lib/services/records";
import { addTaxExemption, removeTaxExemption, taxExemptionFor } from "@/lib/services/tax-exempt";
import { RPM_SAMPLE_UNITS } from "@/lib/sample-data";
import { lineForUnit, pdfText, resetDb, userByRole } from "./helpers";

let admin: SessionUser, manager: SessionUser, clerk: SessionUser, rpmId: string;
const inv = (id: string) => one(`SELECT * FROM invoices WHERE id=$1`, [id]);

async function draft(i: number) {
  const u = RPM_SAMPLE_UNITS[i];
  const line = await lineForUnit(u.unit);
  await assignPo(clerk, { lineId: line, period: "2026-11-01", poNumber: u.po, estimatedTotal: u.poTotal, jobNumber: u.job, workOrderNumber: u.wo });
  return (await generateInvoice(clerk, line, "2026-11-01")).id as string;
}

beforeAll(async () => {
  rpmId = (await resetDb()).rpmId;
  [admin, manager, clerk] = await Promise.all(["admin", "billing_manager", "billing_clerk"].map(userByRole));
  await q(`UPDATE customer_billing_profiles SET tax_rate=0.0825 WHERE customer_id=$1`, [rpmId]);
});

describe("Choosing the certificate", () => {
  const x = (id: string, from: string, to: string | null, contract: string | null = null) => ({ id, contract_id: contract, reason: "resale", certificate_number: "1", effective_from: from, effective_to: to });
  it("covers dates within its range and prefers one for the contract", () => {
    expect(taxExemptionFor([x("1", "2026-01-01", null)], "9", "2026-11-01")?.id).toBe("1");
    expect(taxExemptionFor([x("1", "2026-12-01", null)], "9", "2026-11-01")).toBeNull();
    expect(taxExemptionFor([x("1", "2026-01-01", "2026-10-31")], "9", "2026-11-01")).toBeNull();
    expect(taxExemptionFor([x("1", "2026-01-01", null, "8")], "9", "2026-11-01")).toBeNull();
    expect(taxExemptionFor([x("1", "2026-01-01", null), x("2", "2026-01-01", null, "9")], "9", "2026-11-01")?.id).toBe("2");
  });
});

describe("Sales tax exemptions", () => {
  let id0: string, finalTax: string;
  it("only a manager or admin adds one, with a number or file; ag needs its number", async () => {
    await expect(addTaxExemption(clerk, rpmId, { reason: "resale", certificate_number: "R1", effective_from: "2026-01-01" })).rejects.toThrow(/permission/);
    await expect(addTaxExemption(manager, rpmId, { reason: "charity", certificate_number: "R1", effective_from: "2026-01-01" })).rejects.toThrow(/agricultural, resale or interstate/);
    await expect(addTaxExemption(manager, rpmId, { reason: "resale", effective_from: "2026-01-01" })).rejects.toThrow(/certificate/);
    await expect(addTaxExemption(manager, rpmId, { reason: "agricultural", effective_from: "2026-01-01", file: { filename: "a.pdf", mime: "application/pdf", content: Buffer.from("%PDF") } })).rejects.toThrow(/ag\/timber/);
    await expect(addTaxExemption(manager, rpmId, { reason: "resale", certificate_number: "R1", effective_from: "2026-05-01", effective_to: "2026-04-01" })).rejects.toThrow(/end date/);
  });

  it("a customer-wide certificate removes sales tax from drafts and says why; finished invoices never change", async () => {
    id0 = await draft(0);
    // Finish one invoice first, with tax.
    await submitForReview(clerk, id0);
    for (const c of (await validateInvoice(id0)).filter((c) => (c.status === "fail" || c.status === "warn") && c.overridable && !c.override)) await overrideCheck(manager, id0, c.rule, "Test: accepted");
    await approveInvoice(manager, id0);
    await issueInvoice(manager, id0);
    finalTax = (await inv(id0)).tax_amount;
    expect(Number(finalTax)).toBeGreaterThan(0);

    const id1 = await draft(1);
    expect(Number((await inv(id1)).tax_amount)).toBeGreaterThan(0);
    await addTaxExemption(manager, rpmId, { reason: "agricultural", certificate_number: "AG-0012345", effective_from: "2026-10-01" });
    await refreshInvoice(clerk, id1);
    const after = await inv(id1);
    expect(after.tax_amount).toBe("0.00");
    expect(after.total).toBe(after.subtotal);
    expect(after.snapshot.tax.exempt).toMatch(/Agricultural.*AG-0012345/);
    expect(pdfText((await invoicePdf(id1)).pdf)).toMatch(/Sales tax exempt \(Agricultural/);
    // The issued invoice keeps its tax.
    expect((await inv(id0)).tax_amount).toBe(finalTax);
  });

  it("removing it brings the tax back on drafts", async () => {
    const ex = await one(`SELECT id FROM sales_tax_exemptions WHERE customer_id=$1 AND removed_at IS NULL`, [rpmId]);
    await removeTaxExemption(manager, ex.id, "Certificate expired");
    const id2 = await draft(2);
    expect(Number((await inv(id2)).tax_amount)).toBeGreaterThan(0);
  });

  it("an interstate certificate for one contract exempts only that rental", async () => {
    const lineA = await lineForUnit(RPM_SAMPLE_UNITS[3].unit), lineB = await lineForUnit(RPM_SAMPLE_UNITS[4].unit);
    const contractA = (await one(`SELECT contract_id FROM rental_contract_lines WHERE id=$1`, [lineA])).contract_id;
    await addTaxExemption(manager, rpmId, { reason: "interstate", certificate_number: "IS-77", contract_id: contractA, effective_from: "2026-11-01" });
    const a = await inv(await draft(3)), b = await inv(await draft(4));
    expect(a.tax_amount).toBe("0.00");
    expect(a.snapshot.tax.exempt).toMatch(/Interstate/);
    expect(Number(b.tax_amount)).toBeGreaterThan(0);
    expect(lineB).not.toBe(lineA);
  });

  it("equipment sales under a customer-wide certificate are not taxed", async () => {
    await addTaxExemption(admin, rpmId, { reason: "resale", certificate_number: "RS-9", effective_from: "2026-01-01" });
    await createEquipment(admin, { unit_number: "TX01", description: "Sale unit" });
    const s = await createSale(clerk, { customer_id: rpmId, unit_number: "TX01", price: "10000.00" });
    expect(s.taxable).toBe(false);
    expect(s.tax_amount).toBe("0.00");
    expect(s.notes).toMatch(/Sales tax exempt: Resale, certificate RS-9/);
  });
});
