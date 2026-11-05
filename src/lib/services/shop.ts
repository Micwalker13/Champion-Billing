// Shop work orders and service-due reminders.
// A work order records a repair or service on one unit: the complaint, cause and correction, with
// parts, labor and outside repair costs. Damage found after a rental can be billed back to that
// rental as a one-time charge on its next invoice. Service intervals ("every 250 hours") flag units
// that are due or overdue, using the hour meter.
import { z } from "zod";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { addDays, diffDays, isIsoDate, todayCentral } from "../dates";
import { D, dec, money } from "../money";
import { normalizeUnit } from "../po";
import { logEvent, openRentalFor } from "./inventory";

export const WO_KIND_LABELS: Record<string, string> = { repair: "Repair", service: "Scheduled service", inspection: "Inspection", make_ready: "Make ready", damage: "Damage repair" };
export const WO_STATUS_LABELS: Record<string, string> = { open: "Open", in_progress: "In progress", waiting_parts: "Waiting on parts", completed: "Completed", cancelled: "Cancelled" };
export const LINE_KIND_LABELS: Record<string, string> = { part: "Part", labor: "Labor", outside: "Outside repair" };

const optText = z.string().trim().max(4000).optional().nullable().transform((v) => (v ? v : null));
const optId = z.union([z.literal(""), z.coerce.string().regex(/^\d+$/)]).optional().nullable().transform((v) => (v ? v : null));
const optHours = z.union([z.literal(""), z.string().trim().regex(/^\d{1,7}(\.\d)?$/, "Enter hours like 1234.5")]).optional().nullable().transform((v) => (v ? v : null));
const optDays = z.union([z.literal(""), z.coerce.number().int().min(1).max(3650)]).optional().nullable().transform((v) => (v === "" || v == null ? null : v));
const date = z.string().refine(isIsoDate, "Enter a date");

async function lockWo(db: Db, id: string) {
  const wo = await one(`SELECT * FROM work_orders WHERE id=$1 FOR UPDATE`, [id], db);
  if (!wo) throw new AppError("Work order not found", "not_found");
  return wo;
}
const closed = (wo: any) => ["completed", "cancelled"].includes(wo.status);

// ───────────────────────── Work orders ─────────────────────────
export const workOrderSchema = z.object({
  unit_number: z.string().trim().min(1, "Enter the unit number").transform(normalizeUnit),
  kind: z.enum(["repair", "service", "inspection", "make_ready", "damage"]).default("repair"),
  complaint: z.string().trim().min(3, "Describe the problem or the work to do").max(4000),
  opened_on: date.optional(),
  hours_in: optHours,
  assigned_to: optText,
  contract_line_id: optId,
  service_interval_id: optId,
  put_in_shop: z.boolean().default(true),
});

/** Open a work order. A unit in the yard is moved to "In shop" unless told otherwise. */
export async function createWorkOrder(user: SessionUser, input: unknown) {
  requirePerm(user, "edit_records");
  const w = workOrderSchema.parse(input);
  return tx(async (db) => {
    const unit = await one(`SELECT * FROM equipment WHERE unit_number=$1 FOR UPDATE`, [w.unit_number], db);
    if (!unit) throw new AppError(`Unit ${w.unit_number} isn't in equipment.`);
    if (["sold", "retired"].includes(unit.status)) throw new AppError(`Unit ${unit.unit_number} is ${unit.status}; it can't get a work order.`);
    if (w.contract_line_id) {
      const ok = await one(`SELECT 1 FROM rental_contract_lines WHERE id=$1 AND (equipment_id=$2 OR id IN (SELECT contract_line_id FROM equipment_exchanges WHERE out_equipment_id=$2 OR in_equipment_id=$2))`, [w.contract_line_id, unit.id], db);
      if (!ok) throw new AppError("That rental isn't for this unit.");
    }
    if (w.service_interval_id && !(await one(`SELECT 1 FROM service_intervals WHERE id=$1 AND equipment_id=$2`, [w.service_interval_id, unit.id], db)))
      throw new AppError("That service schedule belongs to a different unit.");
    const s = await one(`SELECT next_work_order_number FROM company_settings WHERE id=1 FOR UPDATE`, [], db);
    await db.query(`UPDATE company_settings SET next_work_order_number = next_work_order_number + 1 WHERE id=1`);
    const number = `WO-${s.next_work_order_number}`;
    const opened = w.opened_on ?? todayCentral();
    const wo = await one(
      `INSERT INTO work_orders(wo_number,equipment_id,opened_on,kind,complaint,hours_in,assigned_to,contract_line_id,service_interval_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [number, unit.id, opened, w.kind, w.complaint, w.hours_in, w.assigned_to, w.contract_line_id, w.service_interval_id, user.id], db);
    await logEvent(db, { equipmentId: unit.id, kind: "work_order", date: opened, hours: w.hours_in, note: `${number} opened: ${w.complaint}`, workOrderId: wo.id, userId: user.id });
    if (w.hours_in) await db.query(`UPDATE equipment SET hour_meter=$2 WHERE id=$1 AND (hour_meter IS NULL OR hour_meter < $2)`, [unit.id, w.hours_in]);
    const onRent = await openRentalFor(db, unit.id);
    if (w.put_in_shop && !onRent && unit.status === "available") {
      await db.query(`UPDATE equipment SET status='in_shop' WHERE id=$1`, [unit.id]);
      await logEvent(db, { equipmentId: unit.id, kind: "status", date: opened, status: "in_shop", note: `In shop for ${number}`, workOrderId: wo.id, userId: user.id });
    }
    await audit(db, user.id, "create", "work_order", wo.id, null, wo);
    return wo;
  });
}

export const woUpdateSchema = z.object({
  status: z.enum(["open", "in_progress", "waiting_parts"]),
  cause: optText,
  correction: optText,
  assigned_to: optText,
});
export async function updateWorkOrder(user: SessionUser, id: string, input: unknown) {
  requirePerm(user, "edit_records");
  const u = woUpdateSchema.parse(input);
  return tx(async (db) => {
    const before = await lockWo(db, id);
    if (closed(before)) throw new AppError("This work order is closed.");
    const after = await one(`UPDATE work_orders SET status=$2, cause=$3, correction=$4, assigned_to=$5, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, u.status, u.cause, u.correction, u.assigned_to], db);
    await audit(db, user.id, "update", "work_order", id, before, after);
    return after;
  });
}

export const woLineSchema = z.object({
  kind: z.enum(["part", "labor", "outside"]),
  description: z.string().trim().min(2, "Describe the part or labor").max(500),
  part_number: optText,
  quantity: z.string().trim().regex(/^\d{1,6}(\.\d{1,2})?$/, "Enter a quantity like 2 or 1.5").refine((v) => dec(v).gt(0), "Quantity must be more than 0"),
  unit_cost: z.string().trim().regex(/^\d{1,8}(\.\d{1,2})?$/, "Enter a cost like 45.00"),
});
export async function addWorkOrderLine(user: SessionUser, id: string, input: unknown) {
  requirePerm(user, "edit_records");
  const l = woLineSchema.parse(input);
  return tx(async (db) => {
    const wo = await lockWo(db, id);
    if (closed(wo)) throw new AppError("This work order is closed; its parts and labor can't change.");
    const amount = money(dec(l.quantity).mul(l.unit_cost));
    const row = await one(`INSERT INTO work_order_lines(work_order_id,kind,description,part_number,quantity,unit_cost,amount,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, l.kind, l.description, l.part_number, l.quantity, l.unit_cost, amount, user.id], db);
    if (wo.status === "open") await db.query(`UPDATE work_orders SET status='in_progress', updated_at=now() WHERE id=$1`, [id]);
    await audit(db, user.id, "add_line", "work_order", id, null, row);
    return row;
  });
}
export async function removeWorkOrderLine(user: SessionUser, id: string, lineId: string) {
  requirePerm(user, "edit_records");
  return tx(async (db) => {
    const wo = await lockWo(db, id);
    if (closed(wo)) throw new AppError("This work order is closed; its parts and labor can't change.");
    const row = await one(`DELETE FROM work_order_lines WHERE id=$1 AND work_order_id=$2 RETURNING *`, [lineId, id], db);
    if (!row) throw new AppError("Line not found", "not_found");
    await audit(db, user.id, "remove_line", "work_order", id, row, null);
  });
}

export const completeSchema = z.object({
  completed_on: date,
  correction: z.string().trim().min(3, "Describe what was done").max(4000),
  hours_out: optHours,
  return_to: z.enum(["available", "in_shop"]).default("available"),
  bill_customer: z.boolean().default(false),
});

/**
 * Close a work order. Marks the unit available again (if it isn't on rent), records a service as
 * done when the work order is for a service schedule, and optionally bills the total back to the
 * rental it came off as a one-time charge.
 */
export async function completeWorkOrder(user: SessionUser, id: string, input: unknown) {
  requirePerm(user, "edit_records");
  const c = completeSchema.parse(input);
  if (c.bill_customer) requirePerm(user, "approve_invoice");
  return tx(async (db) => {
    const wo = await lockWo(db, id);
    if (closed(wo)) throw new AppError("This work order is already closed.");
    if (c.completed_on < wo.opened_on) throw new AppError("The completion date can't be before the work order was opened.");
    const total = (await one(`SELECT coalesce(sum(amount),0) AS t FROM work_order_lines WHERE work_order_id=$1`, [id], db)).t;
    let feeId: string | null = null;
    if (c.bill_customer) {
      if (!wo.contract_line_id) throw new AppError("Link this work order to the rental it came off before billing the customer.");
      if (dec(total).lte(0)) throw new AppError("Add the parts and labor before billing the customer.");
      const line = await one(`SELECT l.taxable, c.contract_number FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id WHERE l.id=$1`, [wo.contract_line_id], db);
      const fee = await one(`INSERT INTO contract_line_fees(contract_line_id,description,amount,frequency,taxable) VALUES ($1,$2,$3,'one_time',$4) RETURNING id`,
        [wo.contract_line_id, `Damage repair ${wo.wo_number}: ${c.correction}`.slice(0, 300), total, line.taxable], db);
      feeId = fee.id;
    }
    const after = await one(`UPDATE work_orders SET status='completed', completed_on=$2, correction=$3, billed_fee_id=$4, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, c.completed_on, c.correction, feeId], db);
    const unit = await one(`SELECT * FROM equipment WHERE id=$1 FOR UPDATE`, [wo.equipment_id], db);
    if (c.hours_out) await db.query(`UPDATE equipment SET hour_meter=$2 WHERE id=$1 AND (hour_meter IS NULL OR hour_meter < $2)`, [unit.id, c.hours_out]);
    await logEvent(db, { equipmentId: unit.id, kind: "work_order", date: c.completed_on, hours: c.hours_out, note: `${wo.wo_number} completed (${money(total)}): ${c.correction}`, workOrderId: id, userId: user.id });
    if (wo.service_interval_id) {
      const hours = c.hours_out ?? wo.hours_in ?? unit.hour_meter;
      const si = await one(`UPDATE service_intervals SET last_done_on=$2, last_done_hours=COALESCE($3,last_done_hours) WHERE id=$1 RETURNING name`, [wo.service_interval_id, c.completed_on, hours], db);
      await logEvent(db, { equipmentId: unit.id, kind: "service_done", date: c.completed_on, hours, note: `${si.name} done on ${wo.wo_number}`, workOrderId: id, userId: user.id });
    }
    const otherOpen = await one(`SELECT 1 FROM work_orders WHERE equipment_id=$1 AND id<>$2 AND status NOT IN ('completed','cancelled') LIMIT 1`, [unit.id, id], db);
    if (unit.status === "in_shop" && c.return_to === "available" && !otherOpen) {
      await db.query(`UPDATE equipment SET status='available' WHERE id=$1`, [unit.id]);
      await logEvent(db, { equipmentId: unit.id, kind: "status", date: c.completed_on, status: "available", note: `Ready after ${wo.wo_number}`, workOrderId: id, userId: user.id });
    }
    await audit(db, user.id, "complete", "work_order", id, wo, { ...after, total, billed_fee_id: feeId });
    return { ...after, total };
  });
}

export async function cancelWorkOrder(user: SessionUser, id: string, reason: string) {
  requirePerm(user, "edit_records");
  if (String(reason ?? "").trim().length < 5) throw new AppError("Enter why the work order is cancelled.");
  return tx(async (db) => {
    const wo = await lockWo(db, id);
    if (closed(wo)) throw new AppError("This work order is already closed.");
    const after = await one(`UPDATE work_orders SET status='cancelled', correction=COALESCE(correction,$2), updated_at=now() WHERE id=$1 RETURNING *`, [id, `Cancelled: ${reason.trim()}`], db);
    await logEvent(db, { equipmentId: wo.equipment_id, kind: "work_order", note: `${wo.wo_number} cancelled: ${reason.trim()}`, workOrderId: id, userId: user.id });
    await audit(db, user.id, "cancel", "work_order", id, wo, after, reason);
    return after;
  });
}

export async function listWorkOrders(f: { status?: "open" | "closed" | "all"; unit?: string } = {}, db: Db = pool()) {
  const where: string[] = []; const args: any[] = [];
  if (f.status !== "all") where.push(f.status === "closed" ? `w.status IN ('completed','cancelled')` : `w.status NOT IN ('completed','cancelled')`);
  if (f.unit) { args.push(`%${f.unit.trim().toUpperCase()}%`); where.push(`e.unit_number LIKE $${args.length}`); }
  return q(`SELECT w.*, e.unit_number, e.description AS unit_description, e.status AS unit_status,
              (SELECT coalesce(sum(amount),0) FROM work_order_lines l WHERE l.work_order_id=w.id) AS total
            FROM work_orders w JOIN equipment e ON e.id=w.equipment_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
            ORDER BY (w.status IN ('completed','cancelled')), w.opened_on DESC, w.id DESC LIMIT 300`, args, db);
}

export async function workOrderDetail(id: string, db: Db = pool()) {
  const wo = await one(`SELECT w.*, e.unit_number, e.description AS unit_description, e.hour_meter, e.status AS unit_status, u.name AS created_by_name,
                          c.contract_number, cu.name AS customer_name, si.name AS interval_name, f.billed_on_invoice_id
                        FROM work_orders w JOIN equipment e ON e.id=w.equipment_id LEFT JOIN users u ON u.id=w.created_by
                        LEFT JOIN rental_contract_lines l ON l.id=w.contract_line_id LEFT JOIN rental_contracts c ON c.id=l.contract_id LEFT JOIN customers cu ON cu.id=c.customer_id
                        LEFT JOIN service_intervals si ON si.id=w.service_interval_id LEFT JOIN contract_line_fees f ON f.id=w.billed_fee_id WHERE w.id=$1`, [id], db);
  if (!wo) return null;
  const lines = await q(`SELECT * FROM work_order_lines WHERE work_order_id=$1 ORDER BY id`, [id], db);
  const totals = { part: new D(0), labor: new D(0), outside: new D(0) } as Record<string, InstanceType<typeof D>>;
  for (const l of lines) totals[l.kind] = totals[l.kind].add(l.amount);
  const total = Object.values(totals).reduce((s, v) => s.add(v), new D(0));
  // Rentals this unit was on, newest first, for linking damage to the renter.
  const rentals = await q(`SELECT DISTINCT l.id, c.contract_number, cu.name AS customer_name, l.on_rent_date, l.off_rent_date, l.status
                           FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id JOIN customers cu ON cu.id=c.customer_id
                           WHERE l.equipment_id=$1 OR l.id IN (SELECT contract_line_id FROM equipment_exchanges WHERE out_equipment_id=$1 OR in_equipment_id=$1)
                           ORDER BY l.on_rent_date DESC LIMIT 10`, [wo.equipment_id], db);
  return { wo, lines, totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, money(v)])), total: money(total), rentals };
}

/** Link a work order to the rental the damage came from, so it can be billed back. */
export async function linkWorkOrderRental(user: SessionUser, id: string, lineId: string | null) {
  requirePerm(user, "edit_records");
  return tx(async (db) => {
    const wo = await lockWo(db, id);
    if (closed(wo)) throw new AppError("This work order is closed.");
    if (lineId) {
      const ok = await one(`SELECT 1 FROM rental_contract_lines WHERE id=$1 AND (equipment_id=$2 OR id IN (SELECT contract_line_id FROM equipment_exchanges WHERE out_equipment_id=$2 OR in_equipment_id=$2))`, [lineId, wo.equipment_id], db);
      if (!ok) throw new AppError("That rental isn't for this unit.");
    }
    await db.query(`UPDATE work_orders SET contract_line_id=$2, updated_at=now() WHERE id=$1`, [id, lineId]);
    await audit(db, user.id, "link_rental", "work_order", id, { contract_line_id: wo.contract_line_id }, { contract_line_id: lineId });
  });
}

// ───────────────────────── Service schedules ─────────────────────────
export const intervalSchema = z.object({
  name: z.string().trim().min(2, "Name the service, e.g. 250-hour service").max(100),
  every_hours: optHours,
  every_days: optDays,
  last_done_hours: optHours,
  last_done_on: z.union([z.literal(""), date]).optional().nullable().transform((v) => (v ? v : null)),
}).refine((v) => v.every_hours || v.every_days, "Enter how often: every so many hours, days, or both");

export async function createServiceInterval(user: SessionUser, equipmentId: string, input: unknown) {
  requirePerm(user, "edit_records");
  const s = intervalSchema.parse(input);
  return tx(async (db) => {
    const unit = await one(`SELECT id, hour_meter FROM equipment WHERE id=$1`, [equipmentId], db);
    if (!unit) throw new AppError("Unit not found", "not_found");
    const row = await one(`INSERT INTO service_intervals(equipment_id,name,every_hours,every_days,last_done_hours,last_done_on,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [equipmentId, s.name, s.every_hours, s.every_days, s.last_done_hours, s.last_done_on, user.id], db).catch((e) => {
        if (/service_intervals_equipment_id_name_key/.test(e.message)) throw new AppError("This unit already has a service with that name.");
        throw e;
      });
    await audit(db, user.id, "create", "service_interval", row.id, null, row);
    return row;
  });
}

export async function setIntervalActive(user: SessionUser, id: string, active: boolean) {
  requirePerm(user, "edit_records");
  return tx(async (db) => {
    const before = await one(`SELECT * FROM service_intervals WHERE id=$1 FOR UPDATE`, [id], db);
    if (!before) throw new AppError("Service schedule not found", "not_found");
    await db.query(`UPDATE service_intervals SET active=$2 WHERE id=$1`, [id, active]);
    await audit(db, user.id, active ? "activate" : "deactivate", "service_interval", id, before, { active });
  });
}

export type DueStatus = "overdue" | "due_soon" | "ok" | "unknown";
export const DUE_LABELS: Record<DueStatus, string> = { overdue: "Overdue", due_soon: "Due soon", ok: "OK", unknown: "No baseline" };

/**
 * Where each active service stands. Due by hours when the hour meter reaches last done + every;
 * due by date at last done + every days. "Due soon" is within 10% of the interval (at least
 * 10 hours) or within 14 days.
 */
export async function serviceDue(f: { equipmentId?: string; onlyDue?: boolean } = {}, db: Db = pool(), today = todayCentral()) {
  const rows = await q(`SELECT si.*, e.unit_number, e.description, e.hour_meter, e.status AS unit_status,
                          (SELECT w.wo_number FROM work_orders w WHERE w.service_interval_id=si.id AND w.status NOT IN ('completed','cancelled') ORDER BY w.id DESC LIMIT 1) AS open_wo,
                          (SELECT w.id FROM work_orders w WHERE w.service_interval_id=si.id AND w.status NOT IN ('completed','cancelled') ORDER BY w.id DESC LIMIT 1) AS open_wo_id
                        FROM service_intervals si JOIN equipment e ON e.id=si.equipment_id
                        WHERE si.active AND e.status NOT IN ('sold','retired') ${f.equipmentId ? "AND si.equipment_id=$1" : ""}
                        ORDER BY e.unit_number, si.name`, f.equipmentId ? [f.equipmentId] : [], db);
  const out = [];
  for (const r of rows) {
    const onRent = await openRentalFor(db, r.equipment_id);
    let status = "unknown" as DueStatus;
    let hoursLeft: string | null = null, dueAtHours: string | null = null, dueOn: string | null = null, daysLeft: number | null = null;
    const rank = (s: DueStatus) => ({ overdue: 3, due_soon: 2, ok: 1, unknown: 0 })[s];
    const worse = (s: DueStatus) => { if (rank(s) > rank(status)) status = s; };
    if (r.every_hours && r.last_done_hours != null && r.hour_meter != null) {
      const due = dec(r.last_done_hours).add(r.every_hours);
      const left = due.sub(r.hour_meter);
      dueAtHours = due.toFixed(1); hoursLeft = left.toFixed(1);
      const soon = D.max(dec(r.every_hours).mul("0.1"), 10);
      worse(left.lt(0) ? "overdue" : left.lte(soon) ? "due_soon" : "ok");
    }
    if (r.every_days && r.last_done_on) {
      dueOn = addDays(r.last_done_on, r.every_days);
      daysLeft = diffDays(today, dueOn);
      worse(daysLeft < 0 ? "overdue" : daysLeft <= 14 ? "due_soon" : "ok");
    }
    const item = { ...r, status, hours_left: hoursLeft, due_at_hours: dueAtHours, due_on: dueOn, days_left: daysLeft, on_rent: onRent };
    if (!f.onlyDue || status === "overdue" || status === "due_soon") out.push(item);
  }
  const order = { overdue: 0, due_soon: 1, unknown: 2, ok: 3 } as const;
  return out.sort((a, b) => order[a.status as DueStatus] - order[b.status as DueStatus] || a.unit_number.localeCompare(b.unit_number));
}
