// Delivery and pickup tickets, quotes, and reservations.
// A ticket is scheduled against a rental, then completed at the jobsite with the customer's
// signature, hour meter and fuel level; the signed PDF is stored permanently. A quote prices
// equipment for a customer; accepting it reserves the equipment, and a reservation becomes a
// rental when the machine goes out.
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, can, requirePerm } from "../permissions";
import { addDays, isIsoDate, todayCentral } from "../dates";
import { dec } from "../money";
import { normalizeUnit } from "../po";
import { renderQuotePdf, renderTicketPdf } from "../pdf";
import { logEvent } from "./inventory";
import { createRentalInTx, rentalSchema } from "./records";
import { feesFor, loadFeeConfig } from "./fees";
import { freeForCategory } from "./availability";

const optText = z.string().trim().max(2000).optional().nullable().transform((v) => (v ? v : null));
const optHours = z.union([z.literal(""), z.string().trim().regex(/^\d{1,7}(\.\d)?$/, "Enter hours like 1234.5")]).optional().nullable().transform((v) => (v ? v : null));
const date = z.string().refine(isIsoDate, "Enter a date");
const optDate = z.union([z.literal(""), date]).optional().nullable().transform((v) => (v ? v : null));
const moneyStr = z.string().trim().regex(/^\d{1,9}(\.\d{1,2})?$/, "Enter an amount like 450.00");
const optMoney = z.union([z.literal(""), moneyStr]).optional().nullable().transform((v) => (v ? v : "0"));

async function nextNumber(db: Db, col: "next_ticket_number" | "next_quote_number") {
  const s = await one(`SELECT ${col} AS n FROM company_settings WHERE id=1 FOR UPDATE`, [], db);
  await db.query(`UPDATE company_settings SET ${col} = ${col} + 1 WHERE id=1`);
  return s.n as number;
}

// ───────────────────────── Tickets ─────────────────────────
export const TICKET_STATUS_LABELS: Record<string, string> = { scheduled: "Scheduled", completed: "Signed", cancelled: "Cancelled" };

export const ticketSchema = z.object({
  kind: z.enum(["delivery", "pickup"]),
  scheduled_date: date,
  time_window: optText,
  driver: optText,
  truck: optText,
  site_contact: optText,
  instructions: optText,
});

export async function scheduleTicket(user: SessionUser, lineId: string, input: unknown) {
  requirePerm(user, "edit_records");
  const t = ticketSchema.parse(input);
  return tx((db) => scheduleTicketInTx(db, user, lineId, t));
}

async function scheduleTicketInTx(db: Db, user: SessionUser, lineId: string, t: z.infer<typeof ticketSchema>) {
  {
    const line = await one(`SELECT l.*, j.address AS site_address FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id LEFT JOIN jobsites j ON j.id=c.jobsite_id WHERE l.id=$1`, [lineId], db);
    if (!line) throw new AppError("Rental not found", "not_found");
    if (["closed"].includes(line.status)) throw new AppError("This rental is closed.");
    if (t.kind === "pickup" && line.status === "active" && !line.off_rent_date) throw new AppError("Call the rental off-rent first (Rental status), then schedule the pickup.");
    const dup = await one(`SELECT ticket_number FROM delivery_tickets WHERE contract_line_id=$1 AND kind=$2 AND status='scheduled'`, [lineId, t.kind], db);
    if (dup) throw new AppError(`There's already a scheduled ${t.kind} for this rental (${dup.ticket_number}).`);
    const n = await nextNumber(db, "next_ticket_number");
    const row = await one(
      `INSERT INTO delivery_tickets(ticket_number,kind,contract_line_id,equipment_id,scheduled_date,time_window,driver,truck,site_address,site_contact,instructions,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [`${t.kind === "delivery" ? "DL" : "PU"}-${n}`, t.kind, lineId, line.equipment_id, t.scheduled_date, t.time_window, t.driver, t.truck, line.site_address, t.site_contact, t.instructions, user.id], db);
    await audit(db, user.id, "create", "delivery_ticket", row.id, null, { ...row, signature_png: undefined, pdf: undefined });
    return row;
  }
}

/** Decode a signature drawn on screen (a PNG data URL) and check it is a real, reasonably sized PNG. */
export function parseSignature(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ""));
  if (!m) throw new AppError("Have the customer sign in the box first.");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 60 || buf.length > 400_000 || buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new AppError("The signature didn't come through. Clear the box and sign again.");
  return buf;
}

export const completeTicketSchema = z.object({
  signed_by: z.string().trim().min(2, "Enter the name of the person signing").max(120),
  signature: z.string(),
  hours: optHours,
  fuel_level: z.union([z.literal(""), z.enum(["empty", "1/4", "1/2", "3/4", "full"])]).optional().nullable().transform((v) => (v ? v : null)),
  condition_notes: optText,
});

/** Complete a ticket at the jobsite: signature, hour meter, fuel and condition. Stores the signed PDF. */
export async function completeTicket(user: SessionUser, id: string, input: unknown) {
  requirePerm(user, "edit_records");
  const c = completeTicketSchema.parse(input);
  const png = parseSignature(c.signature);
  return tx(async (db) => {
    const t = await one(`SELECT * FROM delivery_tickets WHERE id=$1 FOR UPDATE`, [id], db);
    if (!t) throw new AppError("Ticket not found", "not_found");
    if (t.status !== "scheduled") throw new AppError("This ticket is already closed.");
    const ctx = await one(`SELECT c.contract_number, cu.name, cu.customer_code, e.unit_number, e.description, e.serial_number
                           FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id JOIN customers cu ON cu.id=c.customer_id JOIN equipment e ON e.id=$2 WHERE l.id=$1`,
      [t.contract_line_id, t.equipment_id], db);
    const company = await one(`SELECT * FROM company_settings WHERE id=1`, [], db);
    const completedAt = new Date();
    const pdf = Buffer.from(await renderTicketPdf({
      ticket_number: t.ticket_number, kind: t.kind, scheduled_date: t.scheduled_date, completed_at: completedAt, company,
      customer: { name: ctx.name, customer_code: ctx.customer_code }, contract_number: ctx.contract_number,
      unit: { unit_number: ctx.unit_number, description: ctx.description, serial_number: ctx.serial_number },
      site_address: t.site_address, site_contact: t.site_contact, driver: t.driver, truck: t.truck, instructions: t.instructions,
      hours: c.hours, fuel_level: c.fuel_level, condition_notes: c.condition_notes, signed_by: c.signed_by, signature_png: png,
    }));
    const sha = createHash("sha256").update(pdf).digest("hex");
    const after = await one(
      `UPDATE delivery_tickets SET status='completed', hours=$2, fuel_level=$3, condition_notes=$4, signed_by=$5, signature_png=$6, completed_at=$7, completed_by=$8, pdf=$9, pdf_sha256=$10
       WHERE id=$1 RETURNING id, ticket_number, kind, status, pdf_sha256`,
      [id, c.hours, c.fuel_level, c.condition_notes, c.signed_by, png, completedAt, user.id, pdf, sha], db);
    await logEvent(db, { equipmentId: t.equipment_id, kind: t.kind === "delivery" ? "delivered" : "picked_up", date: todayCentral(), hours: c.hours,
      note: `${t.ticket_number} signed by ${c.signed_by}${c.condition_notes ? `: ${c.condition_notes}` : ""}`, lineId: t.contract_line_id, userId: user.id });
    if (c.hours) await db.query(`UPDATE equipment SET hour_meter=$2 WHERE id=$1 AND (hour_meter IS NULL OR hour_meter < $2)`, [t.equipment_id, c.hours]);
    await audit(db, user.id, "sign", "delivery_ticket", id, { status: t.status }, { status: "completed", signed_by: c.signed_by, hours: c.hours, fuel_level: c.fuel_level, pdf_sha256: sha });
    return after;
  });
}

export async function cancelTicket(user: SessionUser, id: string, reason: string) {
  requirePerm(user, "edit_records");
  if (String(reason ?? "").trim().length < 3) throw new AppError("Enter why the ticket is cancelled.");
  return tx(async (db) => {
    const t = await one(`SELECT id, status FROM delivery_tickets WHERE id=$1 FOR UPDATE`, [id], db);
    if (!t) throw new AppError("Ticket not found", "not_found");
    if (t.status !== "scheduled") throw new AppError("Only a scheduled ticket can be cancelled.");
    await db.query(`UPDATE delivery_tickets SET status='cancelled', cancel_reason=$2 WHERE id=$1`, [id, reason.trim()]);
    await audit(db, user.id, "cancel", "delivery_ticket", id, t, { status: "cancelled" }, reason);
  });
}

export async function ticketPdf(id: string, db: Db = pool()) {
  const t = await one(`SELECT ticket_number, pdf, pdf_sha256 FROM delivery_tickets WHERE id=$1 AND status='completed'`, [id], db);
  if (!t) throw new AppError("Signed ticket not found", "not_found");
  const sha = createHash("sha256").update(t.pdf).digest("hex");
  if (sha !== t.pdf_sha256) throw new AppError("Stored PDF failed its integrity check. Contact an administrator.", "integrity");
  return { pdf: t.pdf as Buffer, filename: `${t.ticket_number}.pdf` };
}

export async function listTickets(f: { from?: string; status?: string; lineId?: string } = {}, db: Db = pool()) {
  const where = ["1=1"]; const args: any[] = [];
  if (f.lineId) { args.push(f.lineId); where.push(`t.contract_line_id=$${args.length}`); }
  if (f.status) { args.push(f.status); where.push(`t.status=$${args.length}`); }
  if (f.from) { args.push(f.from); where.push(`t.scheduled_date >= $${args.length}`); }
  return q(`SELECT t.id, t.ticket_number, t.kind, t.status, t.scheduled_date, t.time_window, t.driver, t.truck, t.site_address, t.site_contact, t.instructions,
              t.signed_by, t.completed_at, t.hours, t.fuel_level, t.condition_notes, t.contract_line_id, e.unit_number, e.description, c.contract_number, cu.name AS customer_name
            FROM delivery_tickets t JOIN equipment e ON e.id=t.equipment_id JOIN rental_contract_lines l ON l.id=t.contract_line_id
            JOIN rental_contracts c ON c.id=l.contract_id JOIN customers cu ON cu.id=c.customer_id
            WHERE ${where.join(" AND ")} ORDER BY t.scheduled_date, t.id LIMIT 300`, args, db);
}

// ───────────────────────── Quotes ─────────────────────────
export const QUOTE_STATUS_LABELS: Record<string, string> = { draft: "Draft", sent: "Sent", accepted: "Accepted", declined: "Declined" };

export const quoteSchema = z.object({
  customer_id: z.coerce.string().regex(/^\d+$/, "Choose a customer"),
  valid_days: z.union([z.literal(""), z.coerce.number().int().min(1).max(365)]).optional().nullable().transform((v) => (v === "" || v == null ? 30 : v)),
  jobsite: optText,
  contact: optText,
  notes: optText,
});
export async function createQuote(user: SessionUser, input: unknown) {
  requirePerm(user, "edit_records");
  const s = quoteSchema.parse(input);
  return tx(async (db) => {
    if (!(await one(`SELECT 1 FROM customers WHERE id=$1`, [s.customer_id], db))) throw new AppError("Customer not found");
    const n = await nextNumber(db, "next_quote_number");
    const today = todayCentral();
    const row = await one(`INSERT INTO quotes(quote_number,customer_id,quote_date,valid_until,jobsite,contact,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [`Q-${n}`, s.customer_id, today, addDays(today, s.valid_days), s.jobsite, s.contact, s.notes, user.id], db);
    await audit(db, user.id, "create", "quote", row.id, null, row);
    return row;
  });
}

export const quoteLineSchema = z.object({
  description: z.string().trim().min(2, "Describe the equipment").max(300),
  category: optText,
  unit_number: z.union([z.literal(""), z.string().trim().transform(normalizeUnit)]).optional().nullable().transform((v) => (v ? v : null)),
  quantity: z.coerce.number().int().min(1).max(100).default(1),
  rate_amount: moneyStr,
  rate_basis: z.enum(["daily", "weekly", "cycle_28", "cycle_30", "monthly"]),
  start_date: date,
  end_date: optDate,
  delivery_charge: optMoney,
  pickup_charge: optMoney,
});
export async function addQuoteLine(user: SessionUser, quoteId: string, input: unknown) {
  requirePerm(user, "edit_records");
  const l = quoteLineSchema.parse(input);
  if (l.end_date && l.end_date < l.start_date) throw new AppError("The end date is before the start date.");
  return tx(async (db) => {
    const qt = await one(`SELECT * FROM quotes WHERE id=$1 FOR UPDATE`, [quoteId], db);
    if (!qt) throw new AppError("Quote not found", "not_found");
    if (qt.status !== "draft") throw new AppError("This quote was already sent; its prices can't change.");
    let equipmentId: string | null = null;
    if (l.unit_number) {
      const e = await one(`SELECT id FROM equipment WHERE unit_number=$1`, [l.unit_number], db);
      if (!e) throw new AppError(`Unit ${l.unit_number} isn't in equipment.`);
      if (l.quantity !== 1) throw new AppError("A specific unit can only be quoted with quantity 1.");
      equipmentId = e.id;
    }
    const row = await one(`INSERT INTO quote_lines(quote_id,description,category,equipment_id,quantity,rate_amount,rate_basis,start_date,end_date,delivery_charge,pickup_charge)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [quoteId, l.description, l.category, equipmentId, l.quantity, l.rate_amount, l.rate_basis, l.start_date, l.end_date, l.delivery_charge, l.pickup_charge], db);
    await audit(db, user.id, "add_line", "quote", quoteId, null, row);
    return row;
  });
}
export async function removeQuoteLine(user: SessionUser, quoteId: string, lineId: string) {
  requirePerm(user, "edit_records");
  return tx(async (db) => {
    const row = await one(`DELETE FROM quote_lines WHERE id=$1 AND quote_id=$2 RETURNING *`, [lineId, quoteId], db);
    if (!row) throw new AppError("Line not found", "not_found");
    await audit(db, user.id, "remove_line", "quote", quoteId, row, null);
  });
}

export async function markQuoteSent(user: SessionUser, id: string) {
  requirePerm(user, "edit_records");
  return tx(async (db) => {
    const qt = await one(`SELECT * FROM quotes WHERE id=$1 FOR UPDATE`, [id], db);
    if (!qt) throw new AppError("Quote not found", "not_found");
    if (qt.status !== "draft") throw new AppError("This quote was already sent.");
    if (!(await one(`SELECT 1 FROM quote_lines WHERE quote_id=$1`, [id], db))) throw new AppError("Add at least one line before sending the quote.");
    await db.query(`UPDATE quotes SET status='sent' WHERE id=$1`, [id]);
    await audit(db, user.id, "send", "quote", id, { status: "draft" }, { status: "sent" });
  });
}

/** The customer accepted: every line becomes a reservation (one per unit quoted). */
export async function acceptQuote(user: SessionUser, id: string, note: string) {
  requirePerm(user, "edit_records");
  return tx(async (db) => {
    const qt = await one(`SELECT * FROM quotes WHERE id=$1 FOR UPDATE`, [id], db);
    if (!qt) throw new AppError("Quote not found", "not_found");
    if (qt.status !== "sent") throw new AppError(qt.status === "draft" ? "Mark the quote as sent first." : "This quote was already decided.");
    if (qt.valid_until < todayCentral()) throw new AppError(`This quote expired on ${qt.valid_until}. Copy it to a new quote with current prices.`);
    const lines = await q(`SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY id`, [id], db);
    const made: any[] = [];
    for (const l of lines) for (let i = 0; i < l.quantity; i++) {
      made.push(await reserveInTx(db, user, { customer_id: qt.customer_id, quote_line_id: l.id, equipment_id: l.equipment_id, category: l.category, description: l.description,
        start_date: l.start_date, end_date: l.end_date, rate_amount: l.rate_amount, rate_basis: l.rate_basis, notes: `From quote ${qt.quote_number}` }));
    }
    await db.query(`UPDATE quotes SET status='accepted', decided_at=now(), decided_note=$2 WHERE id=$1`, [id, note?.trim() || null]);
    await audit(db, user.id, "accept", "quote", id, { status: "sent" }, { status: "accepted", reservations: made.map((r) => r.id) }, note);
    return made;
  });
}
export async function declineQuote(user: SessionUser, id: string, note: string) {
  requirePerm(user, "edit_records");
  return tx(async (db) => {
    const qt = await one(`SELECT status FROM quotes WHERE id=$1 FOR UPDATE`, [id], db);
    if (!qt) throw new AppError("Quote not found", "not_found");
    if (!["draft", "sent"].includes(qt.status)) throw new AppError("This quote was already decided.");
    await db.query(`UPDATE quotes SET status='declined', decided_at=now(), decided_note=$2 WHERE id=$1`, [id, note?.trim() || null]);
    await audit(db, user.id, "decline", "quote", id, qt, { status: "declined" }, note);
  });
}

/** Fees and taxes each quote line's unit (or category) would carry, per billing cycle, as of its start date. */
export async function quoteLineFees(customerId: string, lines: any[], db: Db = pool()) {
  const config = await loadFeeConfig(db);
  const out: Record<string, Array<{ description: string; amount: string; category: string }>> = {};
  for (const l of lines) {
    const unit = l.equipment_id ? await one(`SELECT id, equipment_class, category FROM equipment WHERE id=$1`, [l.equipment_id], db) : { id: "0", equipment_class: null, category: l.category };
    const applied = await feesFor({ txn: "rental", equipment: unit, customerId, date: l.start_date, base: l.rate_amount, firstPeriod: true, config }, db);
    out[l.id] = applied.filter((a) => a.outcome.status === "billed").map((a) => ({ description: (a.outcome as any).description, amount: (a.outcome as any).amount, category: a.fee.category }));
  }
  return out;
}

export async function quotePdf(id: string, db: Db = pool()) {
  const qt = await one(`SELECT * FROM quotes WHERE id=$1`, [id], db);
  if (!qt) throw new AppError("Quote not found", "not_found");
  const [lines, company, customer] = await Promise.all([
    q(`SELECT * FROM quote_lines WHERE quote_id=$1 ORDER BY id`, [id], db),
    one(`SELECT * FROM company_settings WHERE id=1`, [], db),
    one(`SELECT * FROM customers WHERE id=$1`, [qt.customer_id], db),
  ]);
  const fees = await quoteLineFees(qt.customer_id, lines, db);
  return { pdf: Buffer.from(await renderQuotePdf(qt, lines.map((l) => ({ ...l, fees: fees[l.id] ?? [] })), company, customer)), filename: `${qt.quote_number}.pdf` };
}

export async function listQuotes(db: Db = pool()) {
  return q(`SELECT qt.*, cu.name AS customer_name, (SELECT count(*)::int FROM quote_lines l WHERE l.quote_id=qt.id) AS lines
            FROM quotes qt JOIN customers cu ON cu.id=qt.customer_id ORDER BY qt.id DESC LIMIT 200`, [], db);
}
export async function quoteDetail(id: string, db: Db = pool()) {
  const qt = await one(`SELECT qt.*, cu.name AS customer_name FROM quotes qt JOIN customers cu ON cu.id=qt.customer_id WHERE qt.id=$1`, [id], db);
  if (!qt) return null;
  const lines = await q(`SELECT l.*, e.unit_number FROM quote_lines l LEFT JOIN equipment e ON e.id=l.equipment_id WHERE l.quote_id=$1 ORDER BY l.id`, [id], db);
  const reservations = await q(`SELECT r.*, e.unit_number FROM reservations r LEFT JOIN equipment e ON e.id=r.equipment_id WHERE r.quote_line_id = ANY($1) ORDER BY r.id`, [lines.map((l) => l.id)], db);
  const fees = await quoteLineFees(qt.customer_id, lines, db);
  return { qt, lines, reservations, fees };
}

// ───────────────────────── Reservations ─────────────────────────
export const RES_STATUS_LABELS: Record<string, string> = { reserved: "Reserved", converted: "On rent", cancelled: "Cancelled" };

/** Is the unit free for these dates: not on another reservation, not on an open rental that overlaps, not sold or retired? */
async function assertUnitFree(db: Db, equipmentId: string, start: string, end: string | null, ignoreReservation?: string) {
  const e = await one(`SELECT unit_number, status FROM equipment WHERE id=$1`, [equipmentId], db);
  if (["sold", "retired"].includes(e.status)) throw new AppError(`Unit ${e.unit_number} is ${e.status}.`);
  const res = await one(`SELECT r.id, cu.name FROM reservations r JOIN customers cu ON cu.id=r.customer_id WHERE r.equipment_id=$1 AND r.status='reserved' AND ($4::bigint IS NULL OR r.id<>$4)
                         AND daterange(r.start_date, COALESCE(r.end_date,'infinity'::date), '[]') && daterange($2::date, COALESCE($3::date,'infinity'::date), '[]')`,
    [equipmentId, start, end, ignoreReservation ?? null], db);
  if (res) throw new AppError(`Unit ${e.unit_number} is already reserved for ${res.name} on those dates.`);
  const rent = await one(`SELECT c.contract_number, l.off_rent_date FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id
                          WHERE l.equipment_id=$1 AND l.status IN ('active','off_rent') AND (l.off_rent_date IS NULL OR l.off_rent_date >= $2::date)`, [equipmentId, start], db);
  if (rent) throw new AppError(`Unit ${e.unit_number} is on rent (${rent.contract_number})${rent.off_rent_date ? ` until ${rent.off_rent_date}` : " with no off-rent date"}.`);
}

async function reserveInTx(db: Db, user: SessionUser, r: { customer_id: string; quote_line_id?: string | null; equipment_id?: string | null; category?: string | null; description: string; start_date: string; end_date?: string | null; rate_amount?: string | null; rate_basis?: string | null; notes?: string | null }) {
  if (r.equipment_id) await assertUnitFree(db, r.equipment_id, r.start_date, r.end_date ?? null);
  const row = await one(`INSERT INTO reservations(customer_id,quote_line_id,equipment_id,category,description,start_date,end_date,rate_amount,rate_basis,notes,created_by)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [r.customer_id, r.quote_line_id ?? null, r.equipment_id ?? null, r.category ?? null, r.description, r.start_date, r.end_date ?? null, r.rate_amount ?? null, r.rate_basis ?? null, r.notes ?? null, user.id], db);
  await audit(db, user.id, "create", "reservation", row.id, null, row);
  return row;
}

export const reservationSchema = z.object({
  customer_id: z.coerce.string().regex(/^\d+$/, "Choose a customer"),
  unit_number: z.union([z.literal(""), z.string().trim().transform(normalizeUnit)]).optional().nullable().transform((v) => (v ? v : null)),
  category: optText,
  description: z.string().trim().min(2, "Describe what's reserved").max(300),
  start_date: date,
  end_date: optDate,
  rate_amount: z.union([z.literal(""), moneyStr]).optional().nullable().transform((v) => (v ? v : null)),
  rate_basis: z.union([z.literal(""), z.enum(["daily", "weekly", "cycle_28", "cycle_30", "monthly"])]).optional().nullable().transform((v) => (v ? v : null)),
  notes: optText,
  overbook: z.boolean().optional(),
});
export async function createReservation(user: SessionUser, input: unknown) {
  requirePerm(user, "edit_records");
  const r = reservationSchema.parse(input);
  if (r.end_date && r.end_date < r.start_date) throw new AppError("The end date is before the start date.");
  return tx(async (db) => {
    let equipmentId: string | null = null;
    let category = r.category;
    if (r.unit_number) {
      const e = await one(`SELECT id, category FROM equipment WHERE unit_number=$1`, [r.unit_number], db);
      if (!e) throw new AppError(`Unit ${r.unit_number} isn't in equipment.`);
      equipmentId = e.id;
      category = category ?? e.category ?? null;
    } else if (category) {
      // Holding a class without a unit: make sure one is free every day, one booking at a time.
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('reserve-category:' || lower(btrim($1))))`, [category]);
      const f = await freeForCategory(category, r.start_date, r.end_date, {}, db);
      if (f.minFree <= 0) {
        const why = f.fleet === 0 ? `There are no ${category} units in the fleet.` : `No ${category} is free on ${f.shortDay} (${f.fleet} in the fleet).`;
        if (!r.overbook) throw new AppError(`${why} Check Availability, pick another class, or tick "Reserve anyway" to wait-list it.`);
        if (!can(user, "override_validation")) throw new AppError(`${why} Only a billing manager can reserve beyond what's free.`);
      }
    } else {
      throw new AppError("Pick the equipment class (or a specific unit) so the reservation holds a machine.");
    }
    const row = await reserveInTx(db, user, { ...r, category, equipment_id: equipmentId });
    if (r.overbook && !equipmentId) await audit(db, user.id, "overbook", "reservation", row.id, null, { category }, "Reserved beyond the units free for these dates");
    return row;
  });
}

export async function assignReservationUnit(user: SessionUser, id: string, unitNumber: string) {
  requirePerm(user, "edit_records");
  return tx(async (db) => {
    const r = await one(`SELECT * FROM reservations WHERE id=$1 FOR UPDATE`, [id], db);
    if (!r || r.status !== "reserved") throw new AppError("Only an open reservation can be changed.");
    const e = await one(`SELECT id FROM equipment WHERE unit_number=$1`, [normalizeUnit(unitNumber)], db);
    if (!e) throw new AppError(`Unit ${unitNumber} isn't in equipment.`);
    await assertUnitFree(db, e.id, r.start_date, r.end_date, id);
    await db.query(`UPDATE reservations SET equipment_id=$2 WHERE id=$1`, [id, e.id]);
    await audit(db, user.id, "assign_unit", "reservation", id, { equipment_id: r.equipment_id }, { equipment_id: e.id });
  });
}

export async function cancelReservation(user: SessionUser, id: string, reason: string) {
  requirePerm(user, "edit_records");
  if (String(reason ?? "").trim().length < 3) throw new AppError("Enter why the reservation is cancelled.");
  return tx(async (db) => {
    const r = await one(`SELECT * FROM reservations WHERE id=$1 FOR UPDATE`, [id], db);
    if (!r || r.status !== "reserved") throw new AppError("Only an open reservation can be cancelled.");
    await db.query(`UPDATE reservations SET status='cancelled', cancel_reason=$2 WHERE id=$1`, [id, reason.trim()]);
    await audit(db, user.id, "cancel", "reservation", id, r, { status: "cancelled" }, reason);
  });
}

/**
 * The machine is going out: create the rental from the reservation. The rental agreement number
 * comes from Quipli (this app never creates or changes Quipli agreements).
 */
type ConvertInput = { contract_number: string; start_date?: string; jobsite_address?: string | null; delivery_charge?: string; pickup_charge?: string };
export async function convertReservation(user: SessionUser, id: string, input: ConvertInput) {
  requirePerm(user, "edit_records");
  return tx((db) => convertInTx(db, user, id, input));
}

/**
 * Dispatch a reservation in one step: pick the unit (if it doesn't have one yet), put it on rent
 * with the Quipli agreement number, and optionally schedule the delivery ticket. All or nothing.
 */
export async function sendOutReservation(user: SessionUser, id: string, input: ConvertInput & { unit_number?: string | null; delivery?: { scheduled_date: string; time_window?: string | null; driver?: string | null; truck?: string | null } | null }) {
  requirePerm(user, "edit_records");
  const delivery = input.delivery ? ticketSchema.parse({ kind: "delivery", ...input.delivery }) : null;
  return tx(async (db) => {
    const r = await one(`SELECT * FROM reservations WHERE id=$1 FOR UPDATE`, [id], db);
    if (!r || r.status !== "reserved") throw new AppError("Only an open reservation can go out.");
    const unit = input.unit_number ? normalizeUnit(input.unit_number) : null;
    if (unit) {
      const e = await one(`SELECT id FROM equipment WHERE unit_number=$1`, [unit], db);
      if (!e) throw new AppError(`Unit ${unit} isn't in equipment.`);
      if (String(e.id) !== String(r.equipment_id)) {
        await assertUnitFree(db, e.id, input.start_date || r.start_date, r.end_date, id);
        await db.query(`UPDATE reservations SET equipment_id=$2 WHERE id=$1`, [id, e.id]);
        await audit(db, user.id, "assign_unit", "reservation", id, { equipment_id: r.equipment_id }, { equipment_id: e.id });
      }
    } else if (!r.equipment_id) throw new AppError("Pick the unit that's going out.");
    const { lineId } = await convertInTx(db, user, id, input);
    const ticket = delivery ? await scheduleTicketInTx(db, user, lineId, delivery) : null;
    return { lineId, ticket };
  });
}

async function convertInTx(db: Db, user: SessionUser, id: string, input: ConvertInput) {
  {
    const r = await one(`SELECT r.*, e.unit_number, ql.delivery_charge AS q_delivery, ql.pickup_charge AS q_pickup, qt.jobsite AS q_jobsite
                         FROM reservations r LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN quote_lines ql ON ql.id=r.quote_line_id LEFT JOIN quotes qt ON qt.id=ql.quote_id
                         WHERE r.id=$1 FOR UPDATE OF r`, [id], db);
    if (!r || r.status !== "reserved") throw new AppError("Only an open reservation can go on rent.");
    if (!r.equipment_id) throw new AppError("Pick the unit for this reservation first.");
    if (!r.rate_amount || !r.rate_basis) throw new AppError("This reservation has no rate. Cancel it and create the rental directly, or reserve again with a rate.");
    const parsed = rentalSchema.parse({
      contract_number: input.contract_number, customer_id: r.customer_id, unit_number: r.unit_number, start_date: input.start_date || r.start_date,
      jobsite_address: input.jobsite_address ?? r.q_jobsite ?? "", rate_amount: dec(r.rate_amount).toFixed(2), rate_basis: r.rate_basis,
      delivery_charge: input.delivery_charge || dec(r.q_delivery).toFixed(2), pickup_charge: input.pickup_charge || dec(r.q_pickup).toFixed(2),
      internal_notes: `From reservation #${r.id}${r.notes ? ` (${r.notes})` : ""}`,
    });
    const created = await createRentalInTx(db, user, parsed);
    const lineId = created.line.id as string;
    await db.query(`UPDATE reservations SET status='converted', contract_line_id=$2 WHERE id=$1`, [id, lineId]);
    await audit(db, user.id, "convert", "reservation", id, { status: "reserved" }, { status: "converted", contract_line_id: lineId });
    return { lineId };
  }
}

export async function listReservations(f: { status?: string } = {}, db: Db = pool()) {
  return q(`SELECT r.*, e.unit_number, cu.name AS customer_name, qt.quote_number, qt.id AS quote_id
            FROM reservations r JOIN customers cu ON cu.id=r.customer_id LEFT JOIN equipment e ON e.id=r.equipment_id
            LEFT JOIN quote_lines ql ON ql.id=r.quote_line_id LEFT JOIN quotes qt ON qt.id=ql.quote_id
            WHERE ($1::text IS NULL OR r.status=$1) ORDER BY (r.status<>'reserved'), r.start_date, r.id LIMIT 300`, [f.status ?? null], db);
}

/** Units free for a date range, for picking a unit on a reservation. */
export async function availableForDates(start: string, end: string | null, db: Db = pool()) {
  return q(`SELECT e.id, e.unit_number, e.description, e.category FROM equipment e
            WHERE e.status IN ('available','in_shop')
              AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.equipment_id=e.id AND r.status='reserved'
                              AND daterange(r.start_date, COALESCE(r.end_date,'infinity'::date), '[]') && daterange($1::date, COALESCE($2::date,'infinity'::date), '[]'))
              AND NOT EXISTS (SELECT 1 FROM rental_contract_lines l WHERE l.equipment_id=e.id AND l.status IN ('active','off_rent') AND (l.off_rent_date IS NULL OR l.off_rent_date >= $1::date))
            ORDER BY e.category NULLS LAST, e.unit_number`, [start, end], db);
}
