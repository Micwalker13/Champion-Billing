// Yard inventory, exchanging a unit on a running rental, and equipment sales.
import { beforeAll, describe, expect, it } from "vitest";
import { one, pool, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { assignPo } from "@/lib/services/pos";
import { createEquipment, createRental } from "@/lib/services/records";
import { estimateForMonth, generateInvoice, invoicePdf, refreshInvoice, validateInvoice } from "@/lib/services/invoices";
import { createYard, exchangeUnit, inventory, unitDetail, updateUnit } from "@/lib/services/inventory";
import { createSale, finalizeSale, recordSalePayment, salePdf, voidSale } from "@/lib/services/sales";
import { agingReport, customerStatement } from "@/lib/services/reports";
import { createImportBatch, importDetail } from "@/lib/services/imports";
import { RPM_SAMPLE_UNITS, rpmPoCsv } from "@/lib/sample-data";
import { lineForUnit, pdfText, resetDb, userByRole } from "./helpers";

let manager: SessionUser, clerk: SessionUser, rpmId: string, yardId: string;
const U0 = RPM_SAMPLE_UNITS[0];

beforeAll(async () => {
  const seeded = await resetDb();
  rpmId = seeded.rpmId;
  [manager, clerk] = await Promise.all(["billing_manager", "billing_clerk"].map(userByRole));
  yardId = (await createYard(clerk, { name: "Main yard", address: "Houston, TX" })).id;
  for (const unit of ["SPARE001", "SPARE002", "SALE001", "SALE002"])
    await createEquipment(clerk, { unit_number: unit, description: `${unit} test unit`, serial_number: `SN-${unit}`, yard_id: yardId, hour_meter: "100" });
});

describe("Inventory", () => {
  it("knows which units are on rent, in the yard or in the shop", async () => {
    const inv = await inventory();
    expect(inv.counts.on_rent).toBe(27); // 26 RPM units + the sample backhoe
    expect(inv.counts.available).toBe(5); // 4 new units + the returned sample skid steer
    const spare = inv.rows.find((r) => r.unit_number === "SPARE002")!;
    await updateUnit(clerk, spare.id, { description: spare.description, status: "in_shop", yard_id: yardId, hour_meter: "105.5", note: "Track tension" });
    const d = (await unitDetail(spare.id))!;
    expect(d.unit.status).toBe("in_shop");
    expect(d.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["added", "status", "hours"]));
    // A unit in the shop can't start a new rental.
    await expect(createRental(clerk, { contract_number: "T-SHOP", customer_id: rpmId, unit_number: "SPARE002", start_date: "2026-11-01", rate_amount: "1000.00", rate_basis: "monthly" }))
      .rejects.toThrow(/in shop/);
    // Status can't be changed while a unit is on rent.
    const onRent = inv.rows.find((r) => r.unit_number === U0.unit)!;
    await expect(updateUnit(clerk, onRent.id, { description: onRent.description, status: "in_shop" })).rejects.toThrow(/on rent/);
  });
});

describe("Exchange a unit on a running rental", () => {
  let lineId: string, invId: string, total: string;

  beforeAll(async () => {
    lineId = await lineForUnit(U0.unit);
    await assignPo(clerk, { lineId, period: "2026-11-01", poNumber: U0.po, estimatedTotal: U0.poTotal, jobNumber: U0.job, workOrderNumber: U0.wo });
    const inv = await generateInvoice(clerk, lineId, "2026-11-01");
    invId = inv.id; total = inv.total;
  });

  it("keeps the rental, rate, PO and amount; the invoice shows both units with their dates", async () => {
    const r = await exchangeUnit(clerk, lineId, { in_unit: "spare001", exchange_date: "2026-11-15", reason: "Hydraulic leak", out_status: "in_shop", out_yard_id: yardId, out_hours: "1200", in_hours: "100" });
    expect(r.finalizedAfter).toEqual([]);
    const line = await one(`SELECT l.*, e.unit_number FROM rental_contract_lines l JOIN equipment e ON e.id=l.equipment_id WHERE l.id=$1`, [lineId]);
    expect(line.unit_number).toBe("SPARE001");
    expect(line.status).toBe("active");

    // The draft made before the swap is flagged until it is recalculated.
    const before = await validateInvoice(invId);
    expect(before.find((c) => c.rule === "equipment_match")!.status).toBe("fail");
    const after = await refreshInvoice(clerk, invId);
    expect(after.total).toBe(total);
    expect(after.po_number).toBe(U0.po);
    expect(after.snapshot.equipment.unit_number).toBe("SPARE001");
    expect(after.snapshot.units.map((u: any) => [u.unit_number, u.from, u.to])).toEqual([[U0.unit, "2026-11-01", "2026-11-14"], ["SPARE001", "2026-11-15", "2026-11-30"]]);
    const desc = (await one(`SELECT description FROM invoice_lines WHERE invoice_id=$1 AND kind='rental'`, [invId])).description;
    expect(desc).toContain(`Unit ${U0.unit}`);
    expect(desc).toContain("exchanged for Unit SPARE001");
    expect((await validateInvoice(invId)).find((c) => c.rule === "equipment_match")!.status).toBe("pass");
    expect(pdfText((await invoicePdf(invId)).pdf)).toContain("Equipment exchange");

    // The old unit went to the shop; both units' history records the swap.
    const out = await one(`SELECT * FROM equipment WHERE unit_number=$1`, [U0.unit]);
    expect(out.status).toBe("in_shop");
    expect(Number(out.hour_meter)).toBe(1200);
    const events = await q(`SELECT e.unit_number, ev.kind FROM equipment_events ev JOIN equipment e ON e.id=ev.equipment_id WHERE ev.exchange_id=$1 ORDER BY ev.id`, [r.exchange.id]);
    expect(events).toEqual([{ unit_number: U0.unit, kind: "exchange_out" }, { unit_number: "SPARE001", kind: "exchange_in" }]);

    // Next month bills only the replacement, at the same amount.
    const dec = await estimateForMonth(pool(), lineId, "2026-12-01");
    expect(dec.lines[0].description).toContain("Unit SPARE001");
    expect(dec.lines[0].description).not.toContain(U0.unit);
    expect(dec.lines[0].amount).toBe((await one(`SELECT amount FROM invoice_lines WHERE invoice_id=$1 AND kind='rental'`, [invId])).amount);
  });

  it("refuses a replacement that is not ready, already out, or out of order", async () => {
    await expect(exchangeUnit(clerk, lineId, { in_unit: U0.unit, exchange_date: "2026-11-20", reason: "Back again" })).rejects.toThrow(/in shop/);
    await expect(exchangeUnit(clerk, lineId, { in_unit: RPM_SAMPLE_UNITS[1].unit, exchange_date: "2026-11-20", reason: "Swap" })).rejects.toThrow(/already on rent/);
    await expect(exchangeUnit(clerk, lineId, { in_unit: "SALE001", exchange_date: "2026-11-10", reason: "Swap" })).rejects.toThrow(/must be dated after/);
    await expect(exchangeUnit(clerk, lineId, { in_unit: "NOPE999", exchange_date: "2026-11-20", reason: "Swap" })).rejects.toThrow(/not in the equipment list/);
  });

  it("matches the customer's PO row for the old unit number to the same rental", async () => {
    const csv = Buffer.from(rpmPoCsv(RPM_SAMPLE_UNITS.slice(0, 2), (_u, i) => String(600100 + i)));
    const b = await createImportBatch(clerk, { customerId: rpmId, billingMonth: "2026-12-01", filename: "swap.csv", content: csv });
    const d = (await importDetail(b.id))!;
    const row = d.rows.find((r: any) => r.unit_number === U0.unit)!;
    expect(String(row.matched_line_id)).toBe(String(lineId));
    expect(row.issues.map((i: any) => i.code)).toContain("exchanged_unit");
    expect(row.issues.filter((i: any) => i.severity === "error")).toEqual([]);
    expect(d.batch.summary.missing_from_file.map((m: any) => m.unit_number)).not.toContain("SPARE001");
  });

  it("adds exchange freight once, on the rental's next invoice", async () => {
    const r = await exchangeUnit(clerk, lineId, { in_unit: "SALE002", exchange_date: "2026-12-05", reason: "Customer wanted the newer unit", out_status: "available", freight_amount: "150.00", out_hours: "", in_hours: "" });
    expect(r.out.status).toBe("available");
    expect(Number(r.out.hour_meter)).toBe(100); // blank hours leave the meter alone
    expect(Number((await one(`SELECT hour_meter FROM equipment WHERE unit_number='SALE002'`)).hour_meter)).toBe(100);
    const dec = await estimateForMonth(pool(), lineId, "2026-12-01");
    const freight = dec.lines.find((l) => l.description.startsWith("Exchange freight"))!;
    expect(freight.amount).toBe("150.00");
    expect(dec.lines[0].description).toContain("Unit SPARE001");
    expect(dec.lines[0].description).toContain("exchanged for Unit SALE002");
    // The table of exchanges is permanent.
    await expect(q(`DELETE FROM equipment_exchanges WHERE id=$1`, [r.exchange.id])).rejects.toThrow();
  });
});

describe("Equipment sales", () => {
  let saleId: string, total: string;

  it("drafts, finalizes with the next invoice number, stores the PDF and marks the unit sold", async () => {
    const s = await createSale(clerk, { customer_id: rpmId, unit_number: "SALE001", price: "45000.00", freight: "500", taxable: true, tax_percent: "8.25", terms_days: "30" });
    saleId = s.id; total = s.total;
    expect(s.subtotal).toBe("45500.00");
    expect(s.tax_amount).toBe("3753.75");
    expect(s.total).toBe("49253.75");
    expect((await one(`SELECT status FROM equipment WHERE unit_number='SALE001'`)).status).toBe("available");
    await expect(finalizeSale(clerk, saleId)).rejects.toThrow(/permission/);

    const next = (await one(`SELECT invoice_prefix, next_invoice_number FROM company_settings WHERE id=1`));
    const r = await finalizeSale(manager, saleId);
    expect(r.sale_number).toBe(`${next.invoice_prefix}${next.next_invoice_number}`);
    expect((await one(`SELECT status FROM equipment WHERE unit_number='SALE001'`)).status).toBe("sold");
    const pdf = await salePdf(saleId);
    expect(pdf.finalized).toBe(true);
    const text = pdfText(pdf.pdf);
    expect(text).toContain("EQUIPMENT SALE");
    expect(text).toContain(r.sale_number);
    expect(text).toContain("49,253.75");
    // The finalized sale can't be edited, and the unit can't go back on rent.
    await expect(q(`UPDATE equipment_sales SET total=1 WHERE id=$1`, [saleId])).rejects.toThrow(/finalized/);
    await expect(createRental(clerk, { contract_number: "T-SOLD", customer_id: rpmId, unit_number: "SALE001", start_date: "2026-11-01", rate_amount: "1000.00", rate_basis: "monthly" })).rejects.toThrow(/sold/);
    await expect(createSale(clerk, { customer_id: rpmId, unit_number: "SALE001", price: "1.00" })).rejects.toThrow(/already sold/);
  });

  it("shows in money owed and on the statement, and takes payments", async () => {
    const aging = await agingReport("2030-01-01");
    const row = aging.invoices.find((i) => i.kind === "sale" && String(i.id) === String(saleId))!;
    expect(row.balance).toBe(total);
    expect(row.href).toBe(`/sales/${saleId}`);
    await recordSalePayment(manager, saleId, { amount: "10000.00", paid_on: "2026-11-20", method: "Check", reference: "SALE-PMT" });
    await expect(voidSale(manager, saleId, "Deal fell through")).rejects.toThrow(/Payments/);
    const st = await customerStatement(rpmId, "2026-11-30");
    expect(st.invoices.find((i) => i.kind === "sale")!.balance).toBe("39253.75");
    expect(st.payments.map((p) => p.reference)).toContain("SALE-PMT");
    await recordSalePayment(manager, saleId, { amount: "39253.75", paid_on: "2026-11-25" });
    expect((await one(`SELECT status FROM equipment_sales WHERE id=$1`, [saleId])).status).toBe("paid");
  });

  it("won't sell a unit on rent, and voiding a sale puts the unit back", async () => {
    await expect(createSale(clerk, { customer_id: rpmId, unit_number: RPM_SAMPLE_UNITS[3].unit, price: "1000.00" })).rejects.toThrow(/on rent/);
    // Blank form fields mean "use the default", never zero.
    const s = await createSale(clerk, { customer_id: rpmId, unit_number: "SPARE002", price: "20000.00", taxable: false, terms_days: "", hours_at_sale: "", freight: "" });
    expect(s.total).toBe("20000.00");
    expect(s.terms_days).toBe(30);
    expect(Number(s.hours_at_sale)).toBe(105.5);
    const r = await finalizeSale(manager, s.id);
    await voidSale(manager, s.id, "Buyer financing declined");
    const after = await one(`SELECT s.status, s.sale_number, e.status AS unit_status FROM equipment_sales s JOIN equipment e ON e.id=s.equipment_id WHERE s.id=$1`, [s.id]);
    expect(after).toEqual({ status: "voided", sale_number: r.sale_number, unit_status: "available" });
    expect((await agingReport("2030-01-01")).invoices.find((i) => i.kind === "sale" && String(i.id) === String(s.id))).toBeUndefined();
  });
});
