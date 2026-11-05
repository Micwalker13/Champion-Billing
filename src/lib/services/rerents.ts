/**
 * Re-rents: a machine Champion rents from a supplier and rents out to its own customer.
 * The machine gets its own unit record (ownership "re_rent") so it rents, bills and dispatches like
 * any other unit. Customer billing is never changed by anything here; the supplier's cost is tracked
 * beside it, from the supplier's bills, for profitability.
 */
import { z } from "zod";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { isIsoDate } from "../dates";
import { createEquipment } from "./records";
import { logEvent, openRentalFor } from "./inventory";

const optText = z.string().trim().max(500).optional().nullable().transform((v) => (v ? v : null));
const date = z.string().refine(isIsoDate, "Enter a date");
const optDate = z.union([z.literal(""), date]).optional().nullable().transform((v) => (v ? v : null));
const money = z.string().trim().regex(/^\d{1,9}(\.\d{1,2})?$/, "Enter an amount like 1250.00");

export const COST_BASIS_LABELS: Record<string, string> = { daily: "per day", weekly: "per week", cycle_28: "per 28 days", monthly: "per month" };

const reRentSchema = z.object({
  vendor_name: z.string().trim().min(2, "Enter the supplier").max(120),
  unit_number: z.string().trim().min(1, "Give the machine a unit number").max(40),
  description: z.string().trim().min(1, "Describe the machine").max(300),
  category: optText,
  make: optText, model: optText, serial_number: optText,
  vendor_unit: optText,
  vendor_agreement: optText,
  vendor_po: optText,
  cost_amount: money,
  cost_basis: z.enum(["daily", "weekly", "cycle_28", "monthly"]),
  received_date: date,
  yard_id: z.union([z.coerce.string().regex(/^\d+$/), z.literal("")]).optional().nullable().transform((v) => (v ? v : null)),
  notes: optText,
});

async function vendorId(db: Db, name: string) {
  const found = await one(`SELECT id FROM vendors WHERE lower(btrim(name)) = lower(btrim($1))`, [name], db);
  if (found) return found.id as string;
  return (await one(`INSERT INTO vendors(name) VALUES (btrim($1)) RETURNING id`, [name], db)).id as string;
}

/** Bring a supplier's machine into the fleet as a re-rent. */
export async function addReRent(user: SessionUser, input: unknown) {
  requirePerm(user, "edit_records");
  const r = reRentSchema.parse(input);
  return tx(async (db) => {
    const unit = await createEquipment(user, { unit_number: r.unit_number, description: r.description, category: r.category ?? "", make: r.make ?? "", model: r.model ?? "", serial_number: r.serial_number ?? "", yard_id: r.yard_id ?? "" }, db);
    await db.query(`UPDATE equipment SET ownership='re_rent' WHERE id=$1`, [unit.id]);
    const vid = await vendorId(db, r.vendor_name);
    const row = await one(
      `INSERT INTO re_rents(equipment_id,vendor_id,vendor_agreement,vendor_po,vendor_unit,cost_amount,cost_basis,received_date,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [unit.id, vid, r.vendor_agreement, r.vendor_po, r.vendor_unit, r.cost_amount, r.cost_basis, r.received_date, r.notes, user.id], db);
    await audit(db, user.id, "create", "re_rent", row.id, null, row);
    return { ...row, unit_number: unit.unit_number };
  });
}

const billSchema = z.object({
  vendor_invoice: z.string().trim().min(1, "Enter the supplier's invoice number").max(60),
  bill_date: date,
  period_start: optDate,
  period_end: optDate,
  amount: money,
  notes: optText,
});

/** Record the supplier's invoice for a re-rented machine (the cost side; customer billing is unchanged). */
export async function addReRentBill(user: SessionUser, reRentId: string, input: unknown) {
  requirePerm(user, "edit_records");
  const b = billSchema.parse(input);
  if (Number(b.amount) <= 0) throw new AppError("Enter the bill amount.");
  if (b.period_start && b.period_end && b.period_end < b.period_start) throw new AppError("The period ends before it starts.");
  return tx(async (db) => {
    const rr = await one(`SELECT id FROM re_rents WHERE id=$1`, [reRentId], db);
    if (!rr) throw new AppError("Re-rent not found", "not_found");
    const dup = await one(`SELECT 1 FROM re_rent_bills WHERE re_rent_id=$1 AND lower(btrim(vendor_invoice))=lower(btrim($2)) AND voided_at IS NULL`, [reRentId, b.vendor_invoice], db);
    if (dup) throw new AppError(`Supplier invoice ${b.vendor_invoice} is already entered for this machine.`);
    const row = await one(`INSERT INTO re_rent_bills(re_rent_id,vendor_invoice,bill_date,period_start,period_end,amount,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [reRentId, b.vendor_invoice, b.bill_date, b.period_start, b.period_end, b.amount, b.notes, user.id], db);
    await audit(db, user.id, "create", "re_rent_bill", row.id, null, row);
    return row;
  });
}

export async function voidReRentBill(user: SessionUser, billId: string, reason: string) {
  requirePerm(user, "edit_records");
  if (String(reason ?? "").trim().length < 3) throw new AppError("Enter why the bill is being voided.");
  return tx(async (db) => {
    const b = await one(`SELECT * FROM re_rent_bills WHERE id=$1 FOR UPDATE`, [billId], db);
    if (!b || b.voided_at) throw new AppError("Only an active bill can be voided.");
    await db.query(`UPDATE re_rent_bills SET voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1`, [billId, user.id, reason.trim()]);
    await audit(db, user.id, "void", "re_rent_bill", billId, { amount: b.amount }, { voided: true }, reason);
  });
}

/** The machine goes back to the supplier. It must be back from the customer and not held for anyone. */
export async function returnToVendor(user: SessionUser, reRentId: string, returnedDate: string) {
  requirePerm(user, "edit_records");
  if (!isIsoDate(returnedDate)) throw new AppError("Enter the date it went back to the supplier.");
  return tx(async (db) => {
    const rr = await one(`SELECT r.*, e.unit_number, e.status FROM re_rents r JOIN equipment e ON e.id=r.equipment_id WHERE r.id=$1 FOR UPDATE OF r`, [reRentId], db);
    if (!rr) throw new AppError("Re-rent not found", "not_found");
    if (rr.returned_date) throw new AppError(`Unit ${rr.unit_number} already went back on ${rr.returned_date}.`);
    if (returnedDate < rr.received_date) throw new AppError("That's before it arrived.");
    const open = await openRentalFor(db, rr.equipment_id);
    if (open) throw new AppError(`Unit ${rr.unit_number} is still on rent to ${open.customer_name} (${open.contract_number}). Return it first.`);
    const held = await one(`SELECT 1 FROM reservations WHERE equipment_id=$1 AND status='reserved'`, [rr.equipment_id], db);
    if (held) throw new AppError(`Unit ${rr.unit_number} is held on an open reservation. Move or cancel it first.`);
    await db.query(`UPDATE re_rents SET returned_date=$2 WHERE id=$1`, [reRentId, returnedDate]);
    await db.query(`UPDATE equipment SET status='returned_to_vendor' WHERE id=$1`, [rr.equipment_id]);
    const v = await one(`SELECT name FROM vendors WHERE id=$1`, [rr.vendor_id], db);
    await logEvent(db, { equipmentId: rr.equipment_id, kind: "status", date: returnedDate, status: "returned_to_vendor", note: `Returned to ${v.name}`, userId: user.id });
    await audit(db, user.id, "return_to_vendor", "re_rent", reRentId, { returned_date: null }, { returned_date: returnedDate });
  });
}

/** Re-rents with cost, supplier bills and what the customer has been billed for the machine. */
export async function listReRents(f: { open?: boolean } = {}, db: Db = pool()) {
  return q(
    `SELECT r.*, v.name AS vendor_name, e.unit_number, e.description, e.category,
            l.id AS line_id, cu.name AS customer_name, c.contract_number,
            (SELECT coalesce(sum(b.amount),0) FROM re_rent_bills b WHERE b.re_rent_id=r.id AND b.voided_at IS NULL) AS cost_billed,
            (SELECT coalesce(sum(il.amount),0) FROM invoices i JOIN invoice_lines il ON il.invoice_id=i.id JOIN rental_contract_lines rl ON rl.id=i.contract_line_id
              WHERE rl.equipment_id=r.equipment_id AND i.finalized_at IS NOT NULL AND i.status NOT IN ('voided','corrected')
                AND coalesce(il.fee_category,'') <> 'regulatory_tax') AS revenue_billed
     FROM re_rents r JOIN vendors v ON v.id=r.vendor_id JOIN equipment e ON e.id=r.equipment_id
     LEFT JOIN rental_contract_lines l ON l.equipment_id=e.id AND l.status IN ('active','off_rent')
     LEFT JOIN rental_contracts c ON c.id=l.contract_id LEFT JOIN customers cu ON cu.id=c.customer_id
     WHERE ($1::boolean IS NOT TRUE OR r.returned_date IS NULL)
     ORDER BY (r.returned_date IS NULL) DESC, r.received_date DESC, r.id DESC`, [f.open ?? null], db);
}

export async function reRentBills(reRentId: string, db: Db = pool()) {
  return q(`SELECT b.*, u.name AS created_by_name FROM re_rent_bills b LEFT JOIN users u ON u.id=b.created_by WHERE b.re_rent_id=$1 ORDER BY b.bill_date DESC, b.id DESC`, [reRentId], db);
}

export async function reRentForUnit(equipmentId: string, db: Db = pool()) {
  return one(`SELECT r.*, v.name AS vendor_name FROM re_rents r JOIN vendors v ON v.id=r.vendor_id WHERE r.equipment_id=$1`, [equipmentId], db);
}

export async function vendorNames(db: Db = pool()): Promise<string[]> {
  return (await q(`SELECT name FROM vendors WHERE active ORDER BY name`, [], db)).map((r: any) => r.name);
}

