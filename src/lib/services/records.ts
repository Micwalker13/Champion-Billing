import { maxUploadMb } from "../limits";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { BillingMethod, LineWindow, ProrationPolicy, RateBasis } from "../billing";
import { normalizeUnit } from "../po";
import { addDays, isIsoDate } from "../dates";
import { UNIT_STATUS_LABELS, logEvent } from "./inventory";
import { Coi, activeCois } from "./insurance";

const isoDate = z.string().refine(isIsoDate, "Use a valid date (YYYY-MM-DD)");
const optIsoDate = z.union([isoDate, z.literal("")]).optional().nullable().transform((v) => (v ? v : null));
const moneyStr = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "Enter an amount like 1925.00");
const optText = z.string().trim().max(2000).optional().nullable().transform((v) => (v ? v : null));

// ───────────────────────── Customers ─────────────────────────
export const customerSchema = z.object({
  customer_code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  billing_address: z.string().trim().min(1).max(1000),
  email: optText,
  phone: optText,
});

export async function createCustomer(user: SessionUser, input: unknown) {
  requirePerm(user, "edit_records");
  const c = customerSchema.parse(input);
  return tx(async (db) => {
    const row = await one(
      `INSERT INTO customers(customer_code,name,billing_address,email,phone) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [c.customer_code.toUpperCase(), c.name, c.billing_address, c.email, c.phone], db);
    await db.query(`INSERT INTO customer_billing_profiles(customer_id) VALUES ($1)`, [row.id]);
    await audit(db, user.id, "create", "customer", row.id, null, row);
    return row;
  });
}

export async function updateCustomer(user: SessionUser, id: string, input: unknown) {
  requirePerm(user, "edit_records");
  const c = customerSchema.parse(input);
  return tx(async (db) => {
    const before = await one(`SELECT * FROM customers WHERE id=$1 FOR UPDATE`, [id], db);
    if (!before) throw new AppError("Customer not found", "not_found");
    const after = await one(`UPDATE customers SET customer_code=$2,name=$3,billing_address=$4,email=$5,phone=$6 WHERE id=$1 RETURNING *`,
      [id, c.customer_code.toUpperCase(), c.name, c.billing_address, c.email, c.phone], db);
    await audit(db, user.id, "update", "customer", id, before, after);
    return after;
  });
}

export const profileSchema = z.object({
  billing_method: z.enum(["daily", "weekly", "cycle_28", "cycle_30", "calendar_month"]),
  bill_off_rent_day: z.boolean(),
  require_monthly_po: z.boolean(),
  unique_po_per_unit: z.boolean(),
  po_pattern: optText,
  po_pattern_description: optText,
  require_work_order: z.boolean(),
  require_job_number: z.boolean(),
  require_jobsite_address: z.boolean(),
  require_contract_attachment: z.boolean(),
  require_manual_approval: z.boolean(),
  invoice_level_po: z.boolean(),
  po_variance_tolerance_pct: z.string().trim().regex(/^\d+(\.\d{1,4})?$/),
  po_variance_tolerance_amount: moneyStr,
  tax_rate: z.string().trim().regex(/^0(\.\d{1,5})?$/, "Enter the tax rate as a decimal, e.g. 0.0825"),
  tax_rate_is_placeholder: z.boolean(),
  payment_terms_days: z.coerce.number().int().min(0).max(365),
  payment_terms_label: z.string().trim().min(1).max(60),
});

export async function updateBillingProfile(user: SessionUser, customerId: string, input: unknown) {
  requirePerm(user, "configure_billing");
  const p = profileSchema.parse(input);
  if (p.po_pattern) {
    try { new RegExp(p.po_pattern); } catch { throw new AppError("PO pattern is not a valid regular expression"); }
  }
  return tx(async (db) => {
    const before = await one(`SELECT * FROM customer_billing_profiles WHERE customer_id=$1 FOR UPDATE`, [customerId], db);
    if (!before) throw new AppError("Billing profile not found", "not_found");
    const keys = Object.keys(p) as (keyof typeof p)[];
    const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(",");
    const after = await one(`UPDATE customer_billing_profiles SET ${sets}, updated_at=now() WHERE customer_id=$1 RETURNING *`,
      [customerId, ...keys.map((k) => p[k])], db);
    await audit(db, user.id, "update", "billing_profile", customerId, before, after);
    return after;
  });
}

/** Proration is a financial policy: only an admin can set it, with a recorded business-approval note. */
export async function approveProrationPolicy(user: SessionUser, customerId: string, policy: ProrationPolicy, note: string) {
  requirePerm(user, "configure_billing");
  if (policy !== "unapproved" && (!note || note.trim().length < 5))
    throw new AppError("Record who approved this proration policy and when (e.g. 'Approved by M. Walker by email 11/3/2026').");
  return tx(async (db) => {
    const before = await one(`SELECT * FROM customer_billing_profiles WHERE customer_id=$1 FOR UPDATE`, [customerId], db);
    const after = await one(
      `UPDATE customer_billing_profiles SET proration_policy=$2, proration_approved_by=$3, proration_approved_at=now(),
         proration_approval_note=$4, updated_at=now() WHERE customer_id=$1 RETURNING *`,
      [customerId, policy, policy === "unapproved" ? null : user.id, note?.trim() || null], db);
    await audit(db, user.id, "approve_proration", "billing_profile", customerId, before, after, note);
    return after;
  });
}

// ───────────────────────── Equipment ─────────────────────────
export const equipmentSchema = z.object({
  unit_number: z.string().trim().min(1).max(40).transform(normalizeUnit),
  description: z.string().trim().min(1).max(300),
  serial_number: optText,
  make: optText,
  model: optText,
  year: z.union([z.literal(""), z.coerce.number().int().min(1950).max(2100)]).optional().nullable().transform((v) => (v === "" || v == null ? null : v)),
  category: optText,
  yard_id: z.union([z.coerce.string().regex(/^\d+$/), z.literal("")]).optional().nullable().transform((v) => (v ? v : null)),
  hour_meter: z.union([z.literal(""), z.coerce.number().min(0).max(999999)]).optional().nullable().transform((v) => (v === "" || v == null ? null : v)),
});

export async function createEquipment(user: SessionUser, input: unknown, db?: Db) {
  requirePerm(user, "edit_records");
  const e = equipmentSchema.parse(input);
  const run = async (c: Db) => {
    const row = await one(`INSERT INTO equipment(unit_number,description,serial_number,make,model,year,category,yard_id,hour_meter) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [e.unit_number, e.description, e.serial_number, e.make, e.model, e.year, e.category, e.yard_id, e.hour_meter], c);
    await logEvent(c, { equipmentId: row.id, kind: "added", yardId: row.yard_id, status: row.status, hours: row.hour_meter, userId: user.id });
    await audit(c, user.id, "create", "equipment", row.id, null, row);
    return row;
  };
  return db ? run(db) : tx(run);
}

// ───────────────────────── Rentals ─────────────────────────
export const rentalSchema = z.object({
  contract_number: z.string().trim().min(1).max(60),
  customer_id: z.coerce.string(),
  unit_number: z.string().trim().min(1).transform(normalizeUnit),
  jobsite_name: optText,
  jobsite_address: optText,
  job_number: optText,
  work_order_number: optText,
  start_date: isoDate,
  billing_start_date: optIsoDate,
  billing_method: z.union([z.enum(["daily", "weekly", "cycle_28", "cycle_30", "calendar_month"]), z.literal("")]).optional().nullable().transform((v) => (v ? v : null)),
  rate_amount: moneyStr,
  rate_basis: z.enum(["daily", "weekly", "cycle_28", "cycle_30", "monthly"]),
  delivery_charge: moneyStr.default("0"),
  pickup_charge: moneyStr.default("0"),
  taxable: z.boolean().default(true),
  payment_terms_days: z.union([z.literal(""), z.coerce.number().int().min(0).max(365)]).optional().nullable().transform((v) => (v === "" || v == null ? null : v)),
  quipli_reference: optText,
  internal_notes: optText,
  fees: z.array(z.object({ description: z.string().trim().min(1), amount: moneyStr, frequency: z.enum(["per_period", "one_time"]), taxable: z.boolean() })).default([]),
});

export async function createRental(user: SessionUser, input: unknown) {
  requirePerm(user, "edit_records");
  const r = rentalSchema.parse(input);
  return tx((db) => createRentalInTx(db, user, r));
}

export async function createRentalInTx(db: Db, user: SessionUser, r: z.infer<typeof rentalSchema>) {
  {
    const equipment = await one(`SELECT * FROM equipment WHERE unit_number=$1`, [r.unit_number], db);
    if (!equipment) throw new AppError(`Equipment unit ${r.unit_number} does not exist. Add it under Equipment first.`);
    const open = await one(`SELECT l.id, c.contract_number FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id
                            WHERE l.equipment_id=$1 AND l.status IN ('active','off_rent')`, [equipment.id], db);
    if (open) throw new AppError(`Unit ${r.unit_number} is already on open rental ${open.contract_number}.`);
    if (equipment.status !== "available") throw new AppError(`Unit ${r.unit_number} is ${UNIT_STATUS_LABELS[equipment.status].toLowerCase()}, so it can't go on rent. Mark it available on its equipment page first.`);
    let jobsiteId: string | null = null;
    if (r.jobsite_address) {
      const js = await one(`INSERT INTO jobsites(customer_id,name,address) VALUES ($1,$2,$3) RETURNING id`,
        [r.customer_id, r.jobsite_name || r.jobsite_address.split("\n")[0], r.jobsite_address], db);
      jobsiteId = js.id;
    }
    const contract = await one(
      `INSERT INTO rental_contracts(contract_number,customer_id,jobsite_id,job_number,work_order_number,start_date,billing_method,payment_terms_days,quipli_reference,internal_notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [r.contract_number, r.customer_id, jobsiteId, r.job_number, r.work_order_number, r.start_date, r.billing_method,
       r.payment_terms_days, r.quipli_reference, r.internal_notes, user.id], db);
    const line = await one(
      `INSERT INTO rental_contract_lines(contract_id,equipment_id,rate_amount,rate_basis,on_rent_date,billing_start_date,delivery_charge,pickup_charge,taxable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [contract.id, equipment.id, r.rate_amount, r.rate_basis, r.start_date, r.billing_start_date || r.start_date,
       r.delivery_charge, r.pickup_charge, r.taxable], db);
    for (const f of r.fees) {
      await db.query(`INSERT INTO contract_line_fees(contract_line_id,description,amount,frequency,taxable) VALUES ($1,$2,$3,$4,$5)`,
        [line.id, f.description, f.amount, f.frequency, f.taxable]);
    }
    await audit(db, user.id, "create", "rental_contract", contract.id, null, { contract, line, fees: r.fees });
    return { contract, line };
  }
}

const STATUS_FLOW: Record<string, string[]> = {
  active: ["off_rent", "returned"],
  off_rent: ["active", "returned"],
  returned: ["closed"],
  closed: [],
};

/** Call-off / return / close. Never touches invoices; only changes the billable window going forward. */
export async function changeLineStatus(user: SessionUser, lineId: string, input: { status: string; date?: string | null; note?: string | null }) {
  requirePerm(user, "edit_records");
  return tx(async (db) => {
    const before = await one(`SELECT * FROM rental_contract_lines WHERE id=$1 FOR UPDATE`, [lineId], db);
    if (!before) throw new AppError("Rental line not found", "not_found");
    if (!STATUS_FLOW[before.status].includes(input.status))
      throw new AppError(`Cannot change a rental from ${before.status} to ${input.status}.`);
    let off = before.off_rent_date as string | null, ret = before.returned_date as string | null;
    if (input.status === "off_rent") { if (!input.date || !isIsoDate(input.date)) throw new AppError("Enter the off-rent (call-off) date."); off = input.date; }
    if (input.status === "returned") { if (!input.date || !isIsoDate(input.date)) throw new AppError("Enter the return date."); ret = input.date; off = off ?? input.date; }
    if (input.status === "active") off = null; // un-call-off (contract extension)
    if (off && off < before.on_rent_date) throw new AppError("Off-rent date cannot be before the on-rent date.");
    // An off-rent date must not cut into a period that was already invoiced and finalized.
    if (off) {
      const conflict = await one(
        `SELECT i.invoice_number, i.period_end FROM invoices i WHERE i.contract_line_id=$1 AND i.finalized_at IS NOT NULL
           AND i.status NOT IN ('voided','corrected') AND i.period_end > $2 ORDER BY i.period_end DESC LIMIT 1`, [lineId, off], db);
      if (conflict) throw new AppError(`Invoice ${conflict.invoice_number} already bills through ${conflict.period_end}. Void or credit it before setting an earlier off-rent date.`);
    }
    const after = await one(`UPDATE rental_contract_lines SET status=$2, off_rent_date=$3, returned_date=$4 WHERE id=$1 RETURNING *`,
      [lineId, input.status, off, ret], db);
    // Keep contract status in step when it has a single line.
    await db.query(`UPDATE rental_contracts c SET status=$2 WHERE id=$1 AND NOT EXISTS
                     (SELECT 1 FROM rental_contract_lines l WHERE l.contract_id=c.id AND l.id<>$3 AND l.status IN ('active','off_rent'))`,
      [before.contract_id, input.status, lineId]);
    if (input.status === "returned") await logEvent(db, { equipmentId: before.equipment_id, kind: "returned", date: ret ?? undefined, note: input.note, lineId, userId: user.id });
    await audit(db, user.id, "status_change", "rental_line", lineId, before, after, input.note ?? undefined);
    return after;
  });
}

export async function updateRentalTerms(user: SessionUser, lineId: string, input: { rate_amount?: string; job_number?: string | null; work_order_number?: string | null; internal_notes?: string | null; note?: string }) {
  requirePerm(user, "edit_records");
  return tx(async (db) => {
    const line = await one(`SELECT * FROM rental_contract_lines WHERE id=$1 FOR UPDATE`, [lineId], db);
    if (!line) throw new AppError("Rental line not found", "not_found");
    const contract = await one(`SELECT * FROM rental_contracts WHERE id=$1 FOR UPDATE`, [line.contract_id], db);
    if (input.rate_amount != null) {
      moneyStr.parse(input.rate_amount);
      await db.query(`UPDATE rental_contract_lines SET rate_amount=$2 WHERE id=$1`, [lineId, input.rate_amount]);
    }
    await db.query(`UPDATE rental_contracts SET job_number=COALESCE($2,job_number), work_order_number=COALESCE($3,work_order_number), internal_notes=COALESCE($4,internal_notes) WHERE id=$1`,
      [contract.id, input.job_number ?? null, input.work_order_number ?? null, input.internal_notes ?? null]);
    const after = { line: await one(`SELECT * FROM rental_contract_lines WHERE id=$1`, [lineId], db), contract: await one(`SELECT * FROM rental_contracts WHERE id=$1`, [contract.id], db) };
    await audit(db, user.id, "update_terms", "rental_line", lineId, { line, contract }, after, input.note);
    return after;
  });
}

export async function addContractDocument(user: SessionUser, contractId: string, file: { filename: string; mime: string; content: Buffer }) {
  requirePerm(user, "edit_records");
  if (file.content.length === 0) throw new AppError("The file is empty.");
  if (file.content.length > maxUploadMb() * 1024 * 1024) throw new AppError(`Files must be under ${maxUploadMb()} MB. For a large scan, save the PDF at a reduced size and upload it again.`);
  const allowed = ["application/pdf", "image/png", "image/jpeg"];
  if (!allowed.includes(file.mime)) throw new AppError("Upload the agreement as a PDF, PNG or JPG.");
  const sha = createHash("sha256").update(file.content).digest("hex");
  return tx(async (db) => {
    const row = await one(`INSERT INTO contract_documents(contract_id,filename,mime_type,content,sha256,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)
                           RETURNING id, filename, mime_type, sha256, uploaded_at`, [contractId, file.filename.slice(0, 200), file.mime, file.content, sha, user.id], db);
    await audit(db, user.id, "upload", "contract_document", row.id, null, { contractId, filename: row.filename, sha256: sha });
    return row;
  });
}

// ───────────────────────── Context loader ─────────────────────────
export interface LineContext {
  line: any; contract: any; customer: any; profile: any; equipment: any; jobsite: any | null; fees: any[];
  /** The customer's insurance certificates that haven't been removed (newest expiry first). */
  cois?: Coi[];
  method: BillingMethod; rateBasis: RateBasis; window: LineWindow;
  /** Unit swaps on this rental, oldest first, each with the full out/in equipment rows. */
  exchanges: Array<{ id: string; exchange_date: string; reason: string; out: any; in: any }>;
}

export interface UnitSegment { equipment: any; from: string; to: string }

/**
 * Which unit was on this rental for each part of [start, end]. Without exchanges that is just the
 * rental's unit. An exchange dated D means the old unit is billed through D-1 and the new one from D.
 */
export function unitSegments(ctx: Pick<LineContext, "equipment" | "exchanges">, start: string, end: string): UnitSegment[] {
  const ex = ctx.exchanges ?? [];
  const timeline: Array<{ equipment: any; from: string | null; to: string | null }> = [];
  let current = ex.length ? ex[0].out : ctx.equipment, from: string | null = null;
  for (const e of ex) {
    timeline.push({ equipment: current, from, to: addDays(e.exchange_date, -1) });
    current = e.in; from = e.exchange_date;
  }
  timeline.push({ equipment: current, from, to: null });
  return timeline
    .map((t) => ({ equipment: t.equipment, from: t.from && t.from > start ? t.from : start, to: t.to && t.to < end ? t.to : end }))
    .filter((t) => t.from <= t.to);
}

export async function loadLineContext(lineId: string, db: Db = pool()): Promise<LineContext> {
  const line = await one(`SELECT * FROM rental_contract_lines WHERE id=$1`, [lineId], db);
  if (!line) throw new AppError("Rental line not found", "not_found");
  const contract = await one(`SELECT * FROM rental_contracts WHERE id=$1`, [line.contract_id], db);
  const customer = await one(`SELECT * FROM customers WHERE id=$1`, [contract.customer_id], db);
  const profile = await one(`SELECT * FROM customer_billing_profiles WHERE customer_id=$1`, [customer.id], db);
  const equipment = await one(`SELECT * FROM equipment WHERE id=$1`, [line.equipment_id], db);
  const jobsite = contract.jobsite_id ? await one(`SELECT * FROM jobsites WHERE id=$1`, [contract.jobsite_id], db) : null;
  const fees = await q(`SELECT * FROM contract_line_fees WHERE contract_line_id=$1 ORDER BY id`, [lineId], db);
  const cois = await activeCois(customer.id, db);
  const method: BillingMethod = contract.billing_method || profile.billing_method;
  const exRows = await q(`SELECT id, exchange_date, reason, out_equipment_id, in_equipment_id FROM equipment_exchanges WHERE contract_line_id=$1 ORDER BY exchange_date, id`, [lineId], db);
  const units = exRows.length ? await q(`SELECT * FROM equipment WHERE id = ANY($1)`, [[...new Set(exRows.flatMap((e) => [e.out_equipment_id, e.in_equipment_id]))]], db) : [];
  const byId = new Map(units.map((u) => [String(u.id), u]));
  const exchanges = exRows.map((e) => ({ id: e.id, exchange_date: e.exchange_date, reason: e.reason, out: byId.get(String(e.out_equipment_id)), in: byId.get(String(e.in_equipment_id)) }));
  return {
    line, contract, customer, profile, equipment, jobsite, fees, cois, method, rateBasis: line.rate_basis, exchanges,
    window: { method, onRentDate: line.on_rent_date, billingStartDate: line.billing_start_date, offRentDate: line.off_rent_date, billOffRentDay: profile.bill_off_rent_day },
  };
}

export async function findLineByUnit(customerId: string, unit: string, db: Db = pool()) {
  return one(`SELECT l.* FROM rental_contract_lines l JOIN equipment e ON e.id=l.equipment_id JOIN rental_contracts c ON c.id=l.contract_id
              WHERE e.unit_number=$1 AND c.customer_id=$2 ORDER BY (l.status IN ('active','off_rent')) DESC, l.on_rent_date DESC LIMIT 1`, [normalizeUnit(unit), customerId], db);
}
