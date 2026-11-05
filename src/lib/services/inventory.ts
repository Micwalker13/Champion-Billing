// Yard inventory and equipment exchanges.
// An exchange swaps the machine on a running rental: the agreement, rate, billing cycle and monthly PO
// carry on, so the customer's charge does not change. The old unit goes back to a yard (or the shop),
// the new one goes on rent, and both units' history records the swap.
import { z } from "zod";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { normalizeUnit } from "../po";
import { fmtDate, isIsoDate, todayCentral } from "../dates";
import { money } from "../money";

export const UNIT_STATUS_LABELS: Record<string, string> = { on_rent: "On rent", available: "Available", in_shop: "In shop", sold: "Sold", retired: "Retired" };
export const EVENT_LABELS: Record<string, string> = {
  added: "Added to inventory", moved: "Moved yard", status: "Status changed", hours: "Hour meter", exchange_out: "Exchanged out",
  exchange_in: "Exchanged in", returned: "Returned from rent", sold: "Sold", sale_voided: "Sale voided", work_order: "Shop work order", service_done: "Service done",
};

const optText = z.string().trim().max(2000).optional().nullable().transform((v) => (v ? v : null));
const optId = z.union([z.coerce.string().regex(/^\d+$/), z.literal("")]).optional().nullable().transform((v) => (v ? v : null));
const optHours = z.union([z.literal(""), z.coerce.number().min(0).max(999999)]).optional().nullable().transform((v) => (v === "" || v == null ? null : v));
const optMoney = z.union([z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "Enter an amount like 450.00"), z.literal("")]).optional().nullable().transform((v) => (v ? v : null));

export async function logEvent(db: Db, e: { equipmentId: string; kind: string; date?: string; yardId?: string | null; status?: string | null; hours?: number | string | null; note?: string | null; lineId?: string | null; exchangeId?: string | null; saleId?: string | null; workOrderId?: string | null; userId: string | null }) {
  await db.query(
    `INSERT INTO equipment_events(equipment_id,kind,event_date,yard_id,status,hours,note,contract_line_id,exchange_id,sale_id,work_order_id,user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [e.equipmentId, e.kind, e.date ?? todayCentral(), e.yardId ?? null, e.status ?? null, e.hours ?? null, e.note ?? null, e.lineId ?? null, e.exchangeId ?? null, e.saleId ?? null, e.workOrderId ?? null, e.userId]);
}

/** The open rental a unit is on, if any. */
export async function openRentalFor(db: Db, equipmentId: string) {
  return one(`SELECT l.id, l.status, c.contract_number, cu.name AS customer_name FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id JOIN customers cu ON cu.id=c.customer_id
              WHERE l.equipment_id=$1 AND l.status IN ('active','off_rent')`, [equipmentId], db);
}

/** Refuse to put a unit on rent (new rental or exchange) unless it is in the yard and ready. */
export async function assertRentable(db: Db, equipment: any) {
  if (equipment.status !== "available") throw new AppError(`Unit ${equipment.unit_number} is ${UNIT_STATUS_LABELS[equipment.status].toLowerCase()}, so it can't go on rent. Mark it available on its equipment page first.`);
  const open = await openRentalFor(db, equipment.id);
  if (open) throw new AppError(`Unit ${equipment.unit_number} is already on rent to ${open.customer_name} (${open.contract_number}).`);
}

// ───────────────────────── Yards ─────────────────────────
export async function createYard(user: SessionUser, input: { name: string; address?: string | null }) {
  requirePerm(user, "edit_records");
  const name = String(input.name ?? "").trim();
  if (name.length < 2) throw new AppError("Enter the yard's name.");
  return tx(async (db) => {
    const row = await one(`INSERT INTO yards(name,address) VALUES ($1,$2) RETURNING *`, [name.slice(0, 100), input.address?.trim() || null], db);
    await audit(db, user.id, "create", "yard", row.id, null, row);
    return row;
  });
}

export async function listYards(db: Db = pool()) {
  return q(`SELECT * FROM yards WHERE active ORDER BY name`, [], db);
}

// ───────────────────────── Unit details ─────────────────────────
export const unitUpdateSchema = z.object({
  description: z.string().trim().min(1).max(300),
  category: optText,
  serial_number: optText,
  make: optText,
  model: optText,
  year: z.union([z.literal(""), z.coerce.number().int().min(1950).max(2100)]).optional().nullable().transform((v) => (v === "" || v == null ? null : v)),
  yard_id: optId,
  status: z.enum(["available", "in_shop", "retired"]),
  hour_meter: optHours,
  asking_price: optMoney,
  notes: optText,
  note: optText,
});

/** Edit a unit's details, yard, status and hours. Moves, status changes and new hour readings go into its history. */
export async function updateUnit(user: SessionUser, id: string, input: unknown) {
  requirePerm(user, "edit_records");
  const u = unitUpdateSchema.parse(input);
  return tx(async (db) => {
    const before = await one(`SELECT * FROM equipment WHERE id=$1 FOR UPDATE`, [id], db);
    if (!before) throw new AppError("Unit not found", "not_found");
    if (before.status === "sold") throw new AppError(`Unit ${before.unit_number} was sold. Void the sale first if it fell through.`);
    if (u.status !== before.status && (await openRentalFor(db, id))) throw new AppError(`Unit ${before.unit_number} is on rent. Return or exchange it before changing its status.`);
    const after = await one(
      `UPDATE equipment SET description=$2, category=$3, serial_number=$4, make=$5, model=$6, year=$7, yard_id=$8, status=$9, hour_meter=$10, asking_price=$11, notes=$12 WHERE id=$1 RETURNING *`,
      [id, u.description, u.category, u.serial_number, u.make, u.model, u.year, u.yard_id, u.status, u.hour_meter, u.asking_price, u.notes], db);
    if (String(before.yard_id ?? "") !== String(after.yard_id ?? "")) await logEvent(db, { equipmentId: id, kind: "moved", yardId: after.yard_id, note: u.note, userId: user.id });
    if (before.status !== after.status) await logEvent(db, { equipmentId: id, kind: "status", status: after.status, yardId: after.yard_id, note: u.note, userId: user.id });
    if (String(before.hour_meter ?? "") !== String(after.hour_meter ?? "") && after.hour_meter != null) await logEvent(db, { equipmentId: id, kind: "hours", hours: after.hour_meter, note: u.note, userId: user.id });
    await audit(db, user.id, "update", "equipment", id, before, after, u.note ?? undefined);
    return after;
  });
}

/** Units with where they are now: on rent (from the open rental), or in a yard with their status. */
export async function inventory(filters: { q?: string | null; status?: string | null; yard?: string | null } = {}, db: Db = pool()) {
  const rows = await q(
    `SELECT e.*, y.name AS yard_name, l.id AS line_id, l.status AS line_status, l.on_rent_date, c.contract_number, cu.name AS customer_name,
            CASE WHEN l.id IS NOT NULL THEN 'on_rent' ELSE e.status END AS where_status
     FROM equipment e LEFT JOIN yards y ON y.id=e.yard_id
     LEFT JOIN rental_contract_lines l ON l.equipment_id=e.id AND l.status IN ('active','off_rent')
     LEFT JOIN rental_contracts c ON c.id=l.contract_id LEFT JOIN customers cu ON cu.id=c.customer_id
     WHERE ($1::text IS NULL OR e.unit_number ILIKE '%'||$1||'%' OR e.description ILIKE '%'||$1||'%' OR e.category ILIKE '%'||$1||'%' OR e.serial_number ILIKE '%'||$1||'%')
       AND ($2::bigint IS NULL OR e.yard_id=$2)
     ORDER BY e.unit_number`, [filters.q || null, filters.yard || null], db);
  const filtered = filters.status ? rows.filter((r) => r.where_status === filters.status) : rows;
  const counts: Record<string, number> = { on_rent: 0, available: 0, in_shop: 0, sold: 0, retired: 0 };
  for (const r of rows) counts[r.where_status]++;
  const fleet = rows.filter((r) => r.where_status !== "sold" && r.where_status !== "retired").length;
  return { rows: filtered, counts, utilization: fleet ? Math.round((counts.on_rent / fleet) * 100) : 0 };
}

export async function unitDetail(id: string, db: Db = pool()) {
  const unit = await one(`SELECT e.*, y.name AS yard_name FROM equipment e LEFT JOIN yards y ON y.id=e.yard_id WHERE e.id=$1`, [id], db);
  if (!unit) return null;
  const [open, events, rentals, sale] = await Promise.all([
    openRentalFor(db, id),
    q(`SELECT ev.*, y.name AS yard_name, u.name AS user_name, c.contract_number FROM equipment_events ev LEFT JOIN yards y ON y.id=ev.yard_id LEFT JOIN users u ON u.id=ev.user_id
       LEFT JOIN rental_contract_lines l ON l.id=ev.contract_line_id LEFT JOIN rental_contracts c ON c.id=l.contract_id WHERE ev.equipment_id=$1 ORDER BY ev.at DESC, ev.id DESC`, [id], db),
    // Rentals this unit was on, including ones it was exchanged into or out of.
    q(`SELECT DISTINCT l.id, c.contract_number, cu.name AS customer_name, l.on_rent_date, l.off_rent_date, l.status, l.rate_amount, l.rate_basis
       FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id JOIN customers cu ON cu.id=c.customer_id
       WHERE l.equipment_id=$1 OR l.id IN (SELECT contract_line_id FROM equipment_exchanges WHERE out_equipment_id=$1 OR in_equipment_id=$1)
       ORDER BY l.on_rent_date DESC`, [id], db),
    one(`SELECT s.id, s.sale_number, s.status, s.total, cu.name AS customer_name FROM equipment_sales s JOIN customers cu ON cu.id=s.customer_id WHERE s.equipment_id=$1 AND s.status <> 'voided'`, [id], db),
  ]);
  return { unit, open, events, rentals, sale };
}

// ───────────────────────── Exchanges ─────────────────────────
export const exchangeSchema = z.object({
  in_unit: z.string().trim().min(1, "Enter the replacement unit number").transform(normalizeUnit),
  exchange_date: z.string().refine(isIsoDate, "Enter the exchange date"),
  reason: z.string().trim().min(3, "Enter the reason for the exchange").max(500),
  out_status: z.enum(["available", "in_shop"]).default("in_shop"),
  out_yard_id: optId,
  out_hours: optHours,
  in_hours: optHours,
  freight_amount: optMoney,
});

/**
 * Swap the machine on a running rental. Billing continues on the same rental line with the same rate
 * and PO, so no month is split and no proration is needed. Optional exchange freight is added as a
 * one-time charge on the rental's next invoice.
 */
export async function exchangeUnit(user: SessionUser, lineId: string, input: unknown) {
  requirePerm(user, "edit_records");
  const x = exchangeSchema.parse(input);
  return tx(async (db) => {
    const line = await one(`SELECT l.*, c.contract_number FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id WHERE l.id=$1 FOR UPDATE OF l`, [lineId], db);
    if (!line) throw new AppError("Rental not found", "not_found");
    if (line.status !== "active") throw new AppError(`Only an active rental can have its unit exchanged (this one is ${line.status.replace("_", "-")}).`);
    if (x.exchange_date <= line.on_rent_date) throw new AppError(`The exchange date must be after the rental started (${fmtDate(line.on_rent_date)}).`);
    if (line.off_rent_date && x.exchange_date > line.off_rent_date) throw new AppError(`The exchange date is after the off-rent date (${fmtDate(line.off_rent_date)}).`);
    const last = await one(`SELECT max(exchange_date) AS d FROM equipment_exchanges WHERE contract_line_id=$1`, [lineId], db);
    if (last?.d && x.exchange_date <= last.d) throw new AppError(`This rental already had an exchange on ${fmtDate(last.d)}. A new exchange must be dated after it.`);

    const out = await one(`SELECT * FROM equipment WHERE id=$1 FOR UPDATE`, [line.equipment_id], db);
    const inn = await one(`SELECT * FROM equipment WHERE unit_number=$1 FOR UPDATE`, [x.in_unit], db);
    if (!inn) throw new AppError(`Unit ${x.in_unit} is not in the equipment list. Add it under Equipment first.`);
    if (String(inn.id) === String(out.id)) throw new AppError(`Unit ${x.in_unit} is already the unit on this rental.`);
    await assertRentable(db, inn);

    let feeId: string | null = null;
    if (x.freight_amount && Number(x.freight_amount) > 0) {
      const fee = await one(`INSERT INTO contract_line_fees(contract_line_id,description,amount,frequency,taxable) VALUES ($1,$2,$3,'one_time',$4) RETURNING id`,
        [lineId, `Exchange freight: unit ${out.unit_number} swapped for ${inn.unit_number} on ${fmtDate(x.exchange_date)}`, money(x.freight_amount), line.taxable], db);
      feeId = fee.id;
    }
    const ex = await one(
      `INSERT INTO equipment_exchanges(contract_line_id,exchange_date,out_equipment_id,in_equipment_id,out_hours,in_hours,out_status,out_yard_id,reason,freight_fee_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [lineId, x.exchange_date, out.id, inn.id, x.out_hours, x.in_hours, x.out_status, x.out_yard_id, x.reason, feeId, user.id], db);
    await db.query(`UPDATE rental_contract_lines SET equipment_id=$2 WHERE id=$1`, [lineId, inn.id]);
    const outAfter = await one(`UPDATE equipment SET status=$2, yard_id=COALESCE($3,yard_id), hour_meter=COALESCE($4,hour_meter) WHERE id=$1 RETURNING *`, [out.id, x.out_status, x.out_yard_id, x.out_hours], db);
    await db.query(`UPDATE equipment SET hour_meter=COALESCE($2,hour_meter) WHERE id=$1`, [inn.id, x.in_hours]);
    await logEvent(db, { equipmentId: out.id, kind: "exchange_out", date: x.exchange_date, yardId: outAfter.yard_id, status: x.out_status, hours: x.out_hours, note: `Swapped out for ${inn.unit_number}: ${x.reason}`, lineId, exchangeId: ex.id, userId: user.id });
    await logEvent(db, { equipmentId: inn.id, kind: "exchange_in", date: x.exchange_date, hours: x.in_hours, note: `Replaced ${out.unit_number} on ${line.contract_number}: ${x.reason}`, lineId, exchangeId: ex.id, userId: user.id });

    // Invoices already finalized for dates on or after the swap keep the old unit on paper; the amount is the same either way.
    const finalized = await q(`SELECT invoice_number FROM invoices WHERE contract_line_id=$1 AND finalized_at IS NOT NULL AND status NOT IN ('voided','corrected') AND period_end >= $2 ORDER BY period_start`, [lineId, x.exchange_date], db);
    await audit(db, user.id, "exchange", "rental_line", lineId, { unit: out.unit_number }, { unit: inn.unit_number, exchange_id: ex.id, exchange_date: x.exchange_date, freight: x.freight_amount }, x.reason);
    return { exchange: ex, out: outAfter, in: inn, finalizedAfter: finalized.map((f) => f.invoice_number as string) };
  });
}

export async function exchangesForLine(lineId: string, db: Db = pool()) {
  return q(`SELECT x.*, o.unit_number AS out_unit, i.unit_number AS in_unit, y.name AS out_yard, u.name AS user_name, f.amount AS freight
            FROM equipment_exchanges x JOIN equipment o ON o.id=x.out_equipment_id JOIN equipment i ON i.id=x.in_equipment_id
            LEFT JOIN yards y ON y.id=x.out_yard_id LEFT JOIN users u ON u.id=x.created_by LEFT JOIN contract_line_fees f ON f.id=x.freight_fee_id
            WHERE x.contract_line_id=$1 ORDER BY x.exchange_date DESC`, [lineId], db);
}

/** Units ready to go out, for the exchange form's suggestions. */
export async function availableUnits(db: Db = pool()) {
  return q(`SELECT e.unit_number, e.description, y.name AS yard_name FROM equipment e LEFT JOIN yards y ON y.id=e.yard_id
            WHERE e.status='available' AND NOT EXISTS (SELECT 1 FROM rental_contract_lines l WHERE l.equipment_id=e.id AND l.status IN ('active','off_rent'))
            ORDER BY e.unit_number`, [], db);
}
