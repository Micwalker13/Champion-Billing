// Availability by class, class reservations, and picking the unit at dispatch.
import { beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { addDays, todayCentral } from "@/lib/dates";
import { createEquipment } from "@/lib/services/records";
import { cancelReservation, createReservation, sendOutReservation } from "@/lib/services/dispatch";
import { availabilityGrid, freeForCategory, unitsForReservation } from "@/lib/services/availability";
import { resetDb, userByRole } from "./helpers";

let clerk: SessionUser, manager: SessionUser, rpmId: string;
const start = addDays(todayCentral(), 10);
const res = (extra: Record<string, unknown>) => ({ customer_id: rpmId, description: "Telehandler", start_date: start, end_date: addDays(start, 4), rate_amount: "4200", rate_basis: "monthly", ...extra });

beforeAll(async () => {
  rpmId = (await resetDb()).rpmId;
  [clerk, manager] = await Promise.all(["billing_clerk", "billing_manager"].map(userByRole));
  for (const u of ["TH01", "TH02"]) await createEquipment(clerk, { unit_number: u, description: "10k telehandler", category: "Telehandler 10K" });
  await createEquipment(clerk, { unit_number: "TH03", description: "10k telehandler", category: "telehandler 10k " }); // same class, typed differently
  await q(`UPDATE equipment SET status='retired' WHERE unit_number='TH03'`);
});

describe("Availability by class", () => {
  it("counts the fleet once per class, ignoring case and retired units", async () => {
    const [c] = await availabilityGrid(start, 5, { category: "TELEHANDLER 10K" });
    expect(c.days).toHaveLength(5);
    expect(c.days[0]).toMatchObject({ fleet: 2, on_rent: 0, held: 0, free: 2 });
  });

  it("lets a class be reserved without a unit until none are free, then blocks it", async () => {
    await expect(createReservation(clerk, res({}))).rejects.toThrow(/Pick the equipment class/);
    await createReservation(clerk, res({ category: "Telehandler 10K" }));
    await createReservation(clerk, res({ category: "telehandler 10k", start_date: addDays(start, 2) }));
    expect((await freeForCategory("Telehandler 10K", start, addDays(start, 4))).minFree).toBe(0);
    // Free on the first two days (only one held), but not on day 3, so it's refused.
    await expect(createReservation(clerk, res({ category: "Telehandler 10K", start_date: addDays(start, 1) }))).rejects.toThrow(new RegExp(`No Telehandler 10K is free on ${addDays(start, 2)}`));
    // Only a manager can wait-list beyond what's free, and it shows as overbooked.
    await expect(createReservation(clerk, res({ category: "Telehandler 10K", overbook: true }))).rejects.toThrow(/Only a billing manager/);
    const c = await createReservation(manager, res({ category: "Telehandler 10K", overbook: true }));
    const [grid] = await availabilityGrid(start, 5, { category: "Telehandler 10K" });
    expect(grid.days.map((d) => d.free)).toEqual([0, 0, -1, -1, -1]);
    await cancelReservation(manager, c.id, "Wait list cleared");
    expect((await availabilityGrid(start, 5, { category: "Telehandler 10K" }))[0].days.map((d) => d.free)).toEqual([1, 1, 0, 0, 0]);
  });

  it("picks the unit at dispatch, puts it on rent and schedules the delivery in one step", async () => {
    const r = await one(`SELECT * FROM reservations WHERE status='reserved' ORDER BY id LIMIT 1`);
    const units = await unitsForReservation(r);
    expect(units[0]).toMatchObject({ unit_number: "TH01", same_category: true });
    expect(units.map((u: any) => u.unit_number)).not.toContain("TH03");

    await expect(sendOutReservation(clerk, r.id, { contract_number: "CE-TH-1" })).rejects.toThrow(/Pick the unit/);
    const out = await sendOutReservation(clerk, r.id, { unit_number: "TH01", contract_number: "CE-TH-1", delivery: { scheduled_date: start, driver: "Luis" } });
    expect(out.ticket).toMatchObject({ kind: "delivery", scheduled_date: start, driver: "Luis" });
    expect(await one(`SELECT status, equipment_id IS NOT NULL AS has_unit FROM reservations WHERE id=$1`, [r.id])).toEqual({ status: "converted", has_unit: true });
    const line = await one(`SELECT l.on_rent_date, l.rate_amount, e.unit_number FROM rental_contract_lines l JOIN equipment e ON e.id=l.equipment_id WHERE l.id=$1`, [out.lineId]);
    expect(line).toEqual({ on_rent_date: start, rate_amount: "4200.00", unit_number: "TH01" });

    // TH01 is now on rent, so it counts as on rent, and the class reservation it filled no longer holds a second unit.
    const [c] = await availabilityGrid(start, 5, { category: "Telehandler 10K" });
    expect(c.days.map((d) => d.free)).toEqual([1, 1, 0, 0, 0]);
    expect(c.days[0]).toMatchObject({ on_rent: 1, held: 0 });

    // The other reservation can't take TH01; a failed send-out changes nothing.
    const other = await one(`SELECT * FROM reservations WHERE status='reserved' ORDER BY id LIMIT 1`);
    await expect(sendOutReservation(clerk, other.id, { unit_number: "TH01", contract_number: "CE-TH-2" })).rejects.toThrow(/on rent/);
    expect(await one(`SELECT status, equipment_id FROM reservations WHERE id=$1`, [other.id])).toEqual({ status: "reserved", equipment_id: null });
    expect(await one(`SELECT count(*)::int AS n FROM rental_contracts WHERE contract_number='CE-TH-2'`)).toEqual({ n: 0 });
  });
});
