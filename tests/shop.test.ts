// Shop work orders and service-due reminders.
import { beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { createEquipment } from "@/lib/services/records";
import { addWorkOrderLine, cancelWorkOrder, completeWorkOrder, createServiceInterval, createWorkOrder, linkWorkOrderRental, removeWorkOrderLine, serviceDue, workOrderDetail } from "@/lib/services/shop";
import { RPM_SAMPLE_UNITS } from "@/lib/sample-data";
import { lineForUnit, resetDb, userByRole } from "./helpers";

let manager: SessionUser, clerk: SessionUser, viewer: SessionUser;
const unitId = async (u: string) => (await one(`SELECT id FROM equipment WHERE unit_number=$1`, [u])).id;
const status = async (u: string) => (await one(`SELECT status, hour_meter FROM equipment WHERE unit_number=$1`, [u]));

beforeAll(async () => {
  await resetDb();
  [manager, clerk, viewer] = await Promise.all(["billing_manager", "billing_clerk", "viewer"].map(userByRole));
  await createEquipment(clerk, { unit_number: "SHOP01", description: "Skid steer", category: "Test", hour_meter: "1200" });
});

describe("Work orders", () => {
  it("opens a numbered work order, puts a yard unit in the shop, and totals parts and labor", async () => {
    await expect(createWorkOrder(viewer, { unit_number: "SHOP01", complaint: "Leaking hydraulic hose" })).rejects.toThrow(/permission/);
    const wo = await createWorkOrder(clerk, { unit_number: "shop01", complaint: "Leaking hydraulic hose", hours_in: "1210.0" });
    expect(wo.wo_number).toMatch(/^WO-\d+$/);
    expect(await status("SHOP01")).toEqual({ status: "in_shop", hour_meter: "1210.0" });
    await addWorkOrderLine(clerk, wo.id, { kind: "part", description: "Hydraulic hose", part_number: "HH-22", quantity: "2", unit_cost: "45.50" });
    const labor = await addWorkOrderLine(clerk, wo.id, { kind: "labor", description: "Mechanic", quantity: "1.5", unit_cost: "95.00" });
    await addWorkOrderLine(clerk, wo.id, { kind: "outside", description: "Wrong line", quantity: "1", unit_cost: "10" });
    const extra = (await workOrderDetail(wo.id))!.lines.at(-1);
    await removeWorkOrderLine(clerk, wo.id, extra.id);
    const d = (await workOrderDetail(wo.id))!;
    expect(d.wo.status).toBe("in_progress");
    expect(labor.amount).toBe("142.50");
    expect(d.totals).toEqual({ part: "91.00", labor: "142.50", outside: "0.00" });
    expect(d.total).toBe("233.50");

    await expect(completeWorkOrder(clerk, wo.id, { completed_on: "2000-01-01", correction: "Replaced hose" })).rejects.toThrow(/before the work order was opened/);
    await completeWorkOrder(clerk, wo.id, { completed_on: wo.opened_on, correction: "Replaced both hoses", hours_out: "1211.0" });
    expect(await status("SHOP01")).toEqual({ status: "available", hour_meter: "1211.0" });
    await expect(addWorkOrderLine(clerk, wo.id, { kind: "part", description: "Late part", quantity: "1", unit_cost: "1" })).rejects.toThrow(/closed/);
    await expect(q(`DELETE FROM work_order_lines WHERE work_order_id=$1`, [wo.id])).rejects.toThrow(/closed/);
    const events = await q(`SELECT kind FROM equipment_events WHERE work_order_id=$1 ORDER BY id`, [wo.id]);
    expect(events.map((e) => e.kind)).toEqual(["work_order", "status", "work_order", "status"]);
  });

  it("bills damage back to the rental it came off as a one-time charge (manager only)", async () => {
    const unit = RPM_SAMPLE_UNITS[0].unit;
    const line = await lineForUnit(unit);
    const wo = await createWorkOrder(clerk, { unit_number: unit, kind: "damage", complaint: "Bent bucket found on inspection" });
    expect((await status(unit)).status).toBe("available"); // still on rent, not moved to the shop
    await addWorkOrderLine(clerk, wo.id, { kind: "outside", description: "Welding shop", quantity: "1", unit_cost: "600.00" });
    await expect(completeWorkOrder(manager, wo.id, { completed_on: wo.opened_on, correction: "Straightened bucket", bill_customer: true })).rejects.toThrow(/Link this work order/);
    await linkWorkOrderRental(clerk, wo.id, line);
    await expect(completeWorkOrder(clerk, wo.id, { completed_on: wo.opened_on, correction: "Straightened bucket", bill_customer: true })).rejects.toThrow(/permission/);
    const done = await completeWorkOrder(manager, wo.id, { completed_on: wo.opened_on, correction: "Straightened bucket", bill_customer: true });
    const fee = await one(`SELECT * FROM contract_line_fees WHERE id=$1`, [done.billed_fee_id]);
    expect(fee).toMatchObject({ contract_line_id: line, amount: "600.00", frequency: "one_time" });
    expect(fee.description).toContain(wo.wo_number);
  });

  it("cancels with a reason", async () => {
    const wo = await createWorkOrder(clerk, { unit_number: "SHOP01", complaint: "Check noise", put_in_shop: false });
    expect((await status("SHOP01")).status).toBe("available");
    await expect(cancelWorkOrder(clerk, wo.id, "")).rejects.toThrow(/why/);
    expect((await cancelWorkOrder(clerk, wo.id, "Noise was normal")).status).toBe("cancelled");
  });
});

describe("Service reminders", () => {
  it("flags services due by hours or date, and resets when a service work order is completed", async () => {
    const id = await unitId("SHOP01"); // hour meter 1211
    await expect(createServiceInterval(clerk, id, { name: "Bad" })).rejects.toThrow(/how often/);
    const s250 = await createServiceInterval(clerk, id, { name: "250-hour service", every_hours: "250", last_done_hours: "980" });
    await createServiceInterval(clerk, id, { name: "500-hour service", every_hours: "500", last_done_hours: "1000" });
    await createServiceInterval(clerk, id, { name: "Annual inspection", every_days: "365", last_done_on: "2025-11-20" });
    await createServiceInterval(clerk, id, { name: "Grease", every_hours: "50" });
    await expect(createServiceInterval(clerk, id, { name: "Grease", every_hours: "50" })).rejects.toThrow(/already has/);
    const all = await serviceDue({ equipmentId: id }, undefined, "2026-11-07");
    const by = (n: string) => all.find((r: any) => r.name === n)!;
    expect(by("250-hour service")).toMatchObject({ status: "due_soon", due_at_hours: "1230.0", hours_left: "19.0" });
    expect(by("500-hour service")).toMatchObject({ status: "ok", hours_left: "289.0" });
    expect(by("Annual inspection")).toMatchObject({ status: "due_soon", due_on: "2026-11-20", days_left: 13 });
    expect(by("Grease").status).toBe("unknown");
    expect((await serviceDue({ onlyDue: true }, undefined, "2026-12-01")).map((r: any) => r.name)).toEqual(["Annual inspection", "250-hour service"]);

    const wo = await createWorkOrder(clerk, { unit_number: "SHOP01", kind: "service", complaint: "250-hour service", service_interval_id: s250.id, hours_in: "1215.0" });
    expect((await serviceDue({ equipmentId: id }, undefined, "2026-11-05")).find((r: any) => r.id === s250.id)!.open_wo).toBe(wo.wo_number);
    await completeWorkOrder(clerk, wo.id, { completed_on: "2026-11-05", correction: "Oil, filters, grease", hours_out: "1216.0" });
    expect((await serviceDue({ equipmentId: id }, undefined, "2026-11-05")).find((r: any) => r.id === s250.id)).toMatchObject({ status: "ok", due_at_hours: "1466.0", last_done_on: "2026-11-05" });
  });
});
