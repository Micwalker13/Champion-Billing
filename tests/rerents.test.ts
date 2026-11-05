// Re-rents (supplier machines) and fleet profitability.
import { beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { assignPo } from "@/lib/services/pos";
import { approveInvoice, generateInvoice, overrideCheck, submitForReview, validateInvoice } from "@/lib/services/invoices";
import { changeLineStatus, createRental } from "@/lib/services/records";
import { addWorkOrderLine, createWorkOrder } from "@/lib/services/shop";
import { addReRent, addReRentBill, listReRents, returnToVendor, voidReRentBill } from "@/lib/services/rerents";
import { fleetProfitability } from "@/lib/services/profitability";
import { resetDb, userByRole } from "./helpers";

let clerk: SessionUser, manager: SessionUser, viewer: SessionUser, rpmId: string;
let reRentId: string, lineId: string, invoiceTotal: string, invoiceSubtotal: string;

async function invoiceLine(line: string, po: string) {
  await assignPo(clerk, { lineId: line, period: "2026-11-01", poNumber: po, estimatedTotal: "20000", jobNumber: "J1", workOrderNumber: "W1" });
  const inv = await generateInvoice(clerk, line, "2026-11-01");
  await submitForReview(clerk, inv.id);
  for (const c of (await validateInvoice(inv.id)).filter((c) => (c.status === "fail" || c.status === "warn") && c.overridable && !c.override)) await overrideCheck(manager, inv.id, c.rule, "Test: accepted");
  await approveInvoice(manager, inv.id);
  return one(`SELECT * FROM invoices WHERE id=$1`, [inv.id]);
}

beforeAll(async () => {
  rpmId = (await resetDb()).rpmId;
  [clerk, manager, viewer] = await Promise.all(["billing_clerk", "billing_manager", "viewer"].map(userByRole));
});

describe("Re-rents", () => {
  it("adds a supplier's machine as its own unit, reusing the supplier by name", async () => {
    await expect(addReRent(viewer, {})).rejects.toThrow(/permission/);
    const a = await addReRent(clerk, { vendor_name: "Sunbelt Rentals", unit_number: "rr-1001", description: "60' boom lift", category: "Boom 60", vendor_agreement: "SB-555", vendor_po: "CE-PO-9", cost_amount: "3000", cost_basis: "monthly", received_date: "2026-10-30" });
    const b = await addReRent(clerk, { vendor_name: " sunbelt rentals ", unit_number: "RR-1002", description: "Scissor lift", cost_amount: "900", cost_basis: "monthly", received_date: "2026-10-30" });
    expect(a.unit_number).toBe("RR-1001");
    expect(a.vendor_id).toBe(b.vendor_id);
    expect(await one(`SELECT ownership, status FROM equipment WHERE unit_number='RR-1001'`)).toEqual({ ownership: "re_rent", status: "available" });
    await expect(addReRent(clerk, { vendor_name: "Other", unit_number: "RR-1001", description: "Dup", cost_amount: "1", cost_basis: "daily", received_date: "2026-10-30" })).rejects.toThrow();
    reRentId = a.id;
  });

  it("rents and bills to the customer like any unit; supplier bills track the cost without touching the invoice", async () => {
    const { line } = await createRental(clerk, { contract_number: "CE-RR-1", customer_id: rpmId, unit_number: "RR-1001", start_date: "2026-11-01", rate_amount: "4500.00", rate_basis: "monthly" });
    lineId = line.id;
    const inv = await invoiceLine(lineId, "498765");
    invoiceTotal = inv.total; invoiceSubtotal = inv.subtotal;
    expect(Number(inv.subtotal)).toBeGreaterThanOrEqual(4500);

    await addReRentBill(clerk, reRentId, { vendor_invoice: "SB-INV-1", bill_date: "2026-11-05", period_start: "2026-11-01", period_end: "2026-11-30", amount: "3000.00" });
    await expect(addReRentBill(clerk, reRentId, { vendor_invoice: "sb-inv-1", bill_date: "2026-11-06", amount: "3000.00" })).rejects.toThrow(/already entered/);
    const wrong = await addReRentBill(clerk, reRentId, { vendor_invoice: "SB-INV-2", bill_date: "2026-11-06", period_start: "2026-11-01", amount: "999.00" });
    await expect(q(`UPDATE re_rent_bills SET amount=1 WHERE id=$1`, [wrong.id])).rejects.toThrow(/read-only/);
    await expect(q(`DELETE FROM re_rent_bills WHERE id=$1`, [wrong.id])).rejects.toThrow(/cannot be deleted/);
    await voidReRentBill(clerk, wrong.id, "Entered twice by mistake");

    const [rr] = (await listReRents({ open: true })).filter((r: any) => r.id === reRentId);
    expect(rr).toMatchObject({ cost_billed: "3000.00", customer_name: expect.any(String), contract_number: "CE-RR-1" });
    expect(Number(rr.revenue_billed)).toBe(Number(invoiceSubtotal));
    expect((await one(`SELECT total FROM invoices WHERE contract_line_id=$1`, [lineId])).total).toBe(invoiceTotal);
  });

  it("can't go back to the supplier while it's on rent", async () => {
    await expect(returnToVendor(clerk, reRentId, "2026-12-01")).rejects.toThrow(/still on rent/);
    await changeLineStatus(clerk, lineId, { status: "off_rent", date: "2026-11-30" });
    await changeLineStatus(clerk, lineId, { status: "returned", date: "2026-12-01" });
    await expect(returnToVendor(clerk, reRentId, "2026-10-01")).rejects.toThrow(/before it arrived/);
    await returnToVendor(clerk, reRentId, "2026-12-02");
    expect(await one(`SELECT status FROM equipment WHERE unit_number='RR-1001'`)).toEqual({ status: "returned_to_vendor" });
    await expect(createRental(clerk, { contract_number: "CE-RR-2", customer_id: rpmId, unit_number: "RR-1001", start_date: "2026-12-05", rate_amount: "1.00", rate_basis: "monthly" })).rejects.toThrow();
    expect((await listReRents({ open: true })).map((r: any) => r.unit_number)).not.toContain("RR-1001");
  });
});

describe("Fleet profitability", () => {
  it("is revenue less credits, shop cost and re-rent cost, per unit and per class", async () => {
    await expect(createWorkOrder(clerk, { unit_number: "RR-1001", complaint: "Gone back already" })).rejects.toThrow(/returned to vendor/);
    const wo = await createWorkOrder(clerk, { unit_number: "RR-1002", complaint: "Replace platform gate" });
    await addWorkOrderLine(clerk, wo.id, { kind: "part", description: "Gate", quantity: "1", unit_cost: "250.00" });

    const r = await fleetProfitability("2026-11-01", "2026-11-30");
    const u = r.units.find((x) => x.unit_number === "RR-1001")!;
    expect(u).toMatchObject({ ownership: "re_rent", revenue: invoiceSubtotal, credits: "0.00", shop_cost: "0.00", re_rent_cost: "3000.00" });
    expect(Number(u.profit)).toBeCloseTo(Number(invoiceSubtotal) - 3000, 2);
    expect(r.classes.find((c) => c.category === "Boom 60")).toMatchObject({ units: 1, re_rent_cost: "3000.00", profit: u.profit });
    // Work orders count by the day they were opened (today), so look at a wide range for the shop cost.
    const wide = await fleetProfitability("2020-01-01", "2030-12-31");
    expect(wide.units.find((x) => x.unit_number === "RR-1002")).toMatchObject({ shop_cost: "250.00", profit: "-250.00", margin: null });
    expect(Number(wide.totals.shop_cost)).toBeGreaterThanOrEqual(250);
  });
});
