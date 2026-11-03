import { createHash } from "node:crypto";
import { AppError, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { normalizeRef, normalizeUnit } from "../po";
import { isIsoDate } from "../dates";
import { parseMoney } from "../money";
import { readTable } from "./imports";
import { createRentalInTx, rentalSchema } from "./records";

const COLS: Record<string, string> = {
  contract: "contract_number", contractnumber: "contract_number", "contract#": "contract_number", rentalcontract: "contract_number", agreement: "contract_number", rentalagreement: "contract_number", ordernumber: "contract_number", order: "contract_number", "order#": "contract_number",
  unit: "unit_number", unitnumber: "unit_number", "unit#": "unit_number", equipment: "unit_number", equipmentunit: "unit_number", asset: "unit_number",
  description: "description", equipmentdescription: "description", item: "description",
  serial: "serial_number", serialnumber: "serial_number", "serial#": "serial_number", sn: "serial_number",
  make: "make", model: "model",
  startdate: "start_date", rentalstartdate: "start_date", onrentdate: "start_date", start: "start_date", outdate: "start_date",
  billfrom: "billing_start_date", billingstartdate: "billing_start_date", billingstart: "billing_start_date", billedthrough: "billed_through",
  rate: "rate_amount", monthlyrate: "rate_amount", rentalrate: "rate_amount", "4weekrate": "rate_amount",
  ratebasis: "rate_basis",
  job: "job_number", jobnumber: "job_number", "job#": "job_number",
  workorder: "work_order_number", wo: "work_order_number", workordernumber: "work_order_number", "wo#": "work_order_number",
  jobsite: "jobsite_name", jobsitename: "jobsite_name", jobname: "jobsite_name",
  jobsiteaddress: "jobsite_address", address: "jobsite_address", siteaddress: "jobsite_address",
  quipli: "quipli_reference", quiplireference: "quipli_reference", quipliorder: "quipli_reference",
  notes: "internal_notes",
};
const norm = (h: unknown) => String(h ?? "").toLowerCase().replace(/[\s_\-.]/g, "");

/** Accepts ISO, M/D/YYYY, M/D/YY and Excel-converted dates. */
export function parseDate(v: unknown): string | null {
  if (v == null || String(v).trim() === "") return null;
  const s = String(v).trim();
  if (isIsoDate(s.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const iso = `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    if (isIsoDate(iso)) return iso;
  }
  throw new Error(`"${s}" is not a date`);
}

export interface RentalRow { row_number: number; values: Record<string, string | null>; errors: string[]; notes: string[]; creates_equipment: boolean }

async function analyze(customerId: string, table: unknown[][]): Promise<RentalRow[]> {
  const hi = table.findIndex((r) => r.some((c) => COLS[norm(c)] === "unit_number") && r.some((c) => COLS[norm(c)] === "contract_number"));
  if (hi < 0) throw new AppError("Could not find the header row. The file needs at least 'Contract' and 'Unit' columns.");
  const map = table[hi].map((h) => COLS[norm(h)]);
  const out: RentalRow[] = [];
  const seenUnits = new Map<string, number>(), seenContracts = new Map<string, number>();
  for (let i = hi + 1; i < table.length; i++) {
    const r = table[i];
    if (!r || r.every((c) => c == null || String(c).trim() === "")) continue;
    const get = (k: string) => { const j = map.indexOf(k); return j >= 0 ? r[j] : null; };
    const errors: string[] = [], notes: string[] = [];
    const v: Record<string, string | null> = {};
    v.contract_number = get("contract_number") == null ? null : String(get("contract_number")).trim() || null;
    v.unit_number = normalizeUnit(get("unit_number")) || null;
    for (const k of ["description", "serial_number", "make", "model", "jobsite_name", "jobsite_address", "quipli_reference", "internal_notes"]) {
      const x = get(k); v[k] = x == null || String(x).trim() === "" ? null : String(x).trim();
    }
    v.job_number = normalizeRef(get("job_number"));
    v.work_order_number = normalizeRef(get("work_order_number"));
    v.rate_basis = (String(get("rate_basis") ?? "monthly").trim().toLowerCase() || "monthly").replace(/^month(ly)?$/, "monthly");
    try { v.start_date = parseDate(get("start_date")); } catch (e: any) { errors.push(`Start date: ${e.message}`); v.start_date = null; }
    try {
      v.billing_start_date = parseDate(get("billing_start_date"));
      const through = parseDate(get("billed_through"));
      if (!v.billing_start_date && through) { const d = new Date(`${through}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); v.billing_start_date = d.toISOString().slice(0, 10); }
    } catch (e: any) { errors.push(`Billing start: ${e.message}`); }
    try { v.rate_amount = parseMoney(get("rate_amount"))?.toFixed(2) ?? null; } catch (e: any) { errors.push(`Rate: ${e.message}`); v.rate_amount = null; }

    if (!v.contract_number) errors.push("Contract number is missing.");
    if (!v.unit_number) errors.push("Unit number is missing.");
    if (!v.start_date && !errors.some((e) => e.startsWith("Start"))) errors.push("Rental start date is missing.");
    if (!v.rate_amount && !errors.some((e) => e.startsWith("Rate"))) errors.push("Rate is missing.");
    if (!["daily", "weekly", "cycle_28", "cycle_30", "monthly"].includes(v.rate_basis!)) errors.push(`Rate basis "${v.rate_basis}" must be monthly, daily, weekly, cycle_28 or cycle_30.`);
    if (v.start_date && v.billing_start_date && v.billing_start_date < v.start_date) errors.push("Billing start is before the rental start.");
    if (!v.billing_start_date) notes.push("No 'Bill From' date: billing starts on the rental start date. For rentals already billed in Quipli, set Bill From to avoid double billing.");

    let createsEquipment = false;
    if (v.unit_number) {
      seenUnits.set(v.unit_number, (seenUnits.get(v.unit_number) ?? 0) + 1);
      const eq = await one(`SELECT id, description FROM equipment WHERE unit_number=$1`, [v.unit_number]);
      if (!eq) {
        createsEquipment = true;
        if (!v.description) errors.push("New unit needs a description.");
        else notes.push("New equipment record will be created.");
      } else {
        const open = await one(`SELECT rc.contract_number FROM rental_contract_lines l JOIN rental_contracts rc ON rc.id=l.contract_id WHERE l.equipment_id=$1 AND l.status IN ('active','off_rent')`, [eq.id]);
        if (open) errors.push(`Unit is already on open rental ${open.contract_number}.`);
      }
    }
    if (v.contract_number) {
      seenContracts.set(v.contract_number, (seenContracts.get(v.contract_number) ?? 0) + 1);
      if (await one(`SELECT 1 FROM rental_contracts WHERE contract_number=$1`, [v.contract_number])) errors.push(`Contract ${v.contract_number} already exists.`);
    }
    out.push({ row_number: i + 1, values: v, errors, notes, creates_equipment: createsEquipment });
  }
  for (const r of out) {
    if (r.values.unit_number && (seenUnits.get(r.values.unit_number) ?? 0) > 1) r.errors.push("Unit appears more than once in this file.");
    if (r.values.contract_number && (seenContracts.get(r.values.contract_number) ?? 0) > 1) r.errors.push("Contract appears more than once in this file.");
  }
  if (!out.length) throw new AppError("The file has a header row but no data rows.");
  void customerId;
  return out;
}

export async function uploadRentalFile(user: SessionUser, input: { customerId: string; filename: string; content: Buffer }) {
  requirePerm(user, "edit_records");
  const sha = createHash("sha256").update(input.content).digest("hex");
  if (await one(`SELECT 1 FROM rental_import_batches WHERE customer_id=$1 AND file_sha256=$2 AND status='applied'`, [input.customerId, sha]))
    throw new AppError("This exact file was already loaded.");
  const rows = await analyze(input.customerId, await readTable(input.filename, input.content));
  const b = await one(`INSERT INTO rental_import_batches(customer_id,filename,file_sha256,rows,uploaded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.customerId, input.filename.slice(0, 200), sha, JSON.stringify(rows), user.id]);
  await audit(pool(), user.id, "upload", "rental_import", b.id, null, { filename: input.filename, rows: rows.length });
  return b;
}

/** Creates every rental in one transaction. If any row fails, nothing is created. */
export async function applyRentalBatch(user: SessionUser, batchId: string) {
  requirePerm(user, "edit_records");
  return tx(async (db) => {
    const b = await one(`SELECT * FROM rental_import_batches WHERE id=$1 FOR UPDATE`, [batchId], db);
    if (!b || b.status !== "review") throw new AppError("This load is not waiting for review.");
    const bad = (b.rows as RentalRow[]).filter((r) => r.errors.length);
    if (bad.length) throw new AppError(`Fix the ${bad.length} row(s) with errors in the file and upload it again (rows ${bad.map((r) => r.row_number).join(", ")}).`);
    let n = 0;
    for (const r of b.rows as RentalRow[]) {
      const v = r.values;
      if (r.creates_equipment) {
        const e = await one(`INSERT INTO equipment(unit_number,description,serial_number,make,model) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [v.unit_number, v.description, v.serial_number, v.make, v.model], db);
        await audit(db, user.id, "create", "equipment", e.id, null, e, `Rental load #${batchId}`);
      }
      const parsed = rentalSchema.parse({ ...v, customer_id: b.customer_id, billing_method: "", taxable: true, delivery_charge: "0", pickup_charge: "0", fees: [] });
      try { await createRentalInTx(db, user, parsed); } catch (e: any) { throw new AppError(`Row ${r.row_number} (${v.unit_number}): ${e.message}`); }
      n++;
    }
    await db.query(`UPDATE rental_import_batches SET status='applied', applied_by=$2, applied_at=now() WHERE id=$1`, [batchId, user.id]);
    await audit(db, user.id, "apply", "rental_import", batchId, null, { created: n });
    return n;
  });
}

export async function cancelRentalBatch(user: SessionUser, batchId: string) {
  requirePerm(user, "edit_records");
  await pool().query(`UPDATE rental_import_batches SET status='cancelled' WHERE id=$1 AND status='review'`, [batchId]);
}

export async function rentalBatch(id: string) {
  return one(`SELECT b.*, c.name AS customer_name FROM rental_import_batches b JOIN customers c ON c.id=b.customer_id WHERE b.id=$1`, [id]);
}
export async function rentalBatches() {
  return q(`SELECT b.id, b.filename, b.status, b.uploaded_at, jsonb_array_length(b.rows) AS n, c.name AS customer_name FROM rental_import_batches b JOIN customers c ON c.id=b.customer_id ORDER BY b.id DESC LIMIT 50`);
}
