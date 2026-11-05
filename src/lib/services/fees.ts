// Equipment fees and taxes: setup (administrators), per-unit switches, customer exemptions, overrides, and reporting.
import { z } from "zod";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { addDays, isIsoDate } from "../dates";
import { dec } from "../money";
import {
  FeeAssignment, FeeExemption, FeeOutcome, FeeOverride, FeeRate, FeeTxn, FeeType, UnitFeeSetting,
  applicableFees, computeFee, isExempt, rateOn,
} from "../fees";

// ───────────────────────── Reading the setup ─────────────────────────
export interface FeeConfig { types: FeeType[]; rates: FeeRate[]; assignments: FeeAssignment[] }

export async function loadFeeConfig(db: Db = pool()): Promise<FeeConfig> {
  const [types, rates, assignments] = await Promise.all([
    q<FeeType>(`SELECT * FROM fee_types ORDER BY category, name`, [], db),
    q<FeeRate>(`SELECT * FROM fee_rates ORDER BY fee_type_id, effective_from`, [], db),
    q<FeeAssignment>(`SELECT * FROM fee_assignments WHERE active`, [], db),
  ]);
  return { types, rates, assignments };
}

export const unitFeeSettings = (equipmentId: string, db: Db = pool()) =>
  q<UnitFeeSetting & { reason: string | null }>(`SELECT fee_type_id, enabled, reason FROM equipment_fee_settings WHERE equipment_id=$1`, [equipmentId], db);
export const customerExemptions = (customerId: string, db: Db = pool()) =>
  q<FeeExemption>(`SELECT fee_type_id, effective_from, effective_to FROM fee_exemptions WHERE customer_id=$1 AND removed_at IS NULL`, [customerId], db);
export const overridesFor = (target: { lineId?: string; saleId?: string }, db: Db = pool()) =>
  q<FeeOverride & { id: string }>(`SELECT id, fee_type_id, waived, percent, amount, reason FROM fee_overrides WHERE removed_at IS NULL AND ${target.lineId ? "contract_line_id" : "sale_id"}=$1`,
    [target.lineId ?? target.saleId], db);

export interface AppliedFee { fee: FeeType; outcome: FeeOutcome }

/**
 * Work out every fee that reaches this unit for one billing cycle or one sale.
 * `date` picks the rate and exemptions (first day of the billing period, or the sale date).
 */
export async function feesFor(i: {
  txn: FeeTxn; equipment: { id: string; equipment_class?: string | null; category?: string | null }; customerId: string; date: string;
  base: string; firstPeriod: boolean; lineId?: string; saleId?: string; config?: FeeConfig;
}, db: Db = pool()): Promise<AppliedFee[]> {
  const cfg = i.config ?? await loadFeeConfig(db);
  const [settings, exemptions, overrides] = await Promise.all([
    unitFeeSettings(i.equipment.id, db), customerExemptions(i.customerId, db),
    i.lineId || i.saleId ? overridesFor({ lineId: i.lineId, saleId: i.saleId }, db) : Promise.resolve([]),
  ]);
  const fees = applicableFees(cfg.types, i.txn, i.equipment, cfg.assignments, settings);
  return fees.map((fee) => ({
    fee,
    outcome: computeFee({
      fee, rate: rateOn(cfg.rates, fee.id, i.date), exempt: isExempt(exemptions, fee.id, i.date),
      override: overrides.find((o) => String(o.fee_type_id) === String(fee.id)) ?? null,
      base: i.base, firstPeriod: i.firstPeriod, baseLabel: i.txn === "rental" ? "rental" : "price",
    }),
  }));
}

// ───────────────────────── Fee setup (administrators) ─────────────────────────
const yes = z.unknown().optional().transform((v) => v === true || v === "on" || v === "true");
const text = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

export const feeTypeSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/, "Use a short code of 2-20 letters or numbers, like HET or TERP"),
  name: z.string().trim().min(2, "Enter the fee's name").max(100),
  description: text(500),
  category: z.enum(["regulatory_tax", "business_surcharge"], { message: "Choose whether this is a regulatory tax or a business surcharge" }),
  calc_type: z.enum(["percent", "fixed"], { message: "Choose percent or flat dollar amount" }),
  frequency: z.enum(["per_billing_cycle", "one_time"], { message: "Choose how often it is charged" }),
  applies_rentals: yes, applies_sales: yes, taxable: yes,
  allow_override: z.unknown().optional().transform((v) => v === undefined || v === true || v === "on" || v === "true"),
  gl_account: text(40),
}).refine((v) => v.applies_rentals || v.applies_sales, { message: "Choose rentals, sales, or both", path: ["applies_rentals"] });

const rateSchema = z.object({
  effective_from: z.string().refine(isIsoDate, "Enter the date this rate starts"),
  value: z.string().trim().regex(/^\d{1,7}(\.\d{1,4})?$/, "Enter the rate, like 2 for 2% or 25.00 for $25").refine((v) => dec(v).gt(0), "The rate must be more than 0"),
  note: text(300),
});

export async function createFeeType(user: SessionUser, input: unknown, firstRate?: unknown) {
  requirePerm(user, "manage_fees");
  const s = feeTypeSchema.parse(input);
  return tx(async (db) => {
    if (await one(`SELECT 1 FROM fee_types WHERE code=$1`, [s.code], db)) throw new AppError(`A fee with code ${s.code} already exists.`);
    const row = await one(`INSERT INTO fee_types(code,name,description,category,calc_type,frequency,applies_rentals,applies_sales,taxable,gl_account,allow_override,created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [s.code, s.name, s.description, s.category, s.calc_type, s.frequency, s.applies_rentals, s.applies_sales, s.taxable, s.gl_account, s.allow_override, user.id], db);
    await audit(db, user.id, "create", "fee_type", row.id, null, row);
    if (firstRate) await addRateIn(db, user, row, firstRate);
    return row as FeeType;
  });
}

export async function updateFeeType(user: SessionUser, id: string, input: unknown) {
  requirePerm(user, "manage_fees");
  const s = feeTypeSchema.parse(input);
  return tx(async (db) => {
    const before = await one(`SELECT * FROM fee_types WHERE id=$1 FOR UPDATE`, [id], db);
    if (!before) throw new AppError("Fee not found", "not_found");
    if (s.calc_type !== before.calc_type) throw new AppError("A fee can't switch between percent and flat amount after it is created. Create a new fee instead.");
    if (s.code !== before.code && await one(`SELECT 1 FROM fee_types WHERE code=$1`, [s.code], db)) throw new AppError(`A fee with code ${s.code} already exists.`);
    const after = await one(`UPDATE fee_types SET code=$2,name=$3,description=$4,category=$5,frequency=$6,applies_rentals=$7,applies_sales=$8,taxable=$9,gl_account=$10,allow_override=$11,updated_at=now()
                             WHERE id=$1 RETURNING *`,
      [id, s.code, s.name, s.description, s.category, s.frequency, s.applies_rentals, s.applies_sales, s.taxable, s.gl_account, s.allow_override], db);
    await audit(db, user.id, "update", "fee_type", id, before, after);
    return after;
  });
}

export async function setFeeTypeActive(user: SessionUser, id: string, active: boolean) {
  requirePerm(user, "manage_fees");
  return tx(async (db) => {
    const before = await one(`SELECT id, code, active FROM fee_types WHERE id=$1 FOR UPDATE`, [id], db);
    if (!before) throw new AppError("Fee not found", "not_found");
    await db.query(`UPDATE fee_types SET active=$2, updated_at=now() WHERE id=$1`, [id, active]);
    await audit(db, user.id, active ? "activate" : "deactivate", "fee_type", id, before, { active });
  });
}

async function addRateIn(db: Db, user: SessionUser, fee: any, input: unknown) {
  const r = rateSchema.parse(input);
  if (fee.calc_type === "percent" && dec(r.value).gte(100)) throw new AppError("A percent rate must be under 100.");
  const percent = fee.calc_type === "percent" ? dec(r.value).div(100).toFixed(6) : null;
  const amount = fee.calc_type === "fixed" ? dec(r.value).toFixed(2) : null;
  const open = await one(`SELECT * FROM fee_rates WHERE fee_type_id=$1 AND effective_to IS NULL`, [fee.id], db);
  if (open) {
    if (r.effective_from <= open.effective_from) throw new AppError(`The current rate started ${open.effective_from}. A new rate must start after that.`);
    await db.query(`UPDATE fee_rates SET effective_to=$2 WHERE id=$1`, [open.id, addDays(r.effective_from, -1)]);
  } else {
    const later = await one(`SELECT 1 FROM fee_rates WHERE fee_type_id=$1 AND effective_to >= $2`, [fee.id, r.effective_from], db);
    if (later) throw new AppError("That start date falls inside an earlier rate period.");
  }
  const row = await one(`INSERT INTO fee_rates(fee_type_id,effective_from,percent,amount,note,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [fee.id, r.effective_from, percent, amount, r.note, user.id], db);
  await audit(db, user.id, "add_rate", "fee_type", fee.id, open ? { previous_rate: open } : null, row, r.note ?? undefined);
  return row;
}

export async function addFeeRate(user: SessionUser, feeId: string, input: unknown) {
  requirePerm(user, "manage_fees");
  return tx(async (db) => {
    const fee = await one(`SELECT * FROM fee_types WHERE id=$1 FOR UPDATE`, [feeId], db);
    if (!fee) throw new AppError("Fee not found", "not_found");
    return addRateIn(db, user, fee, input);
  });
}

/** End the open-ended rate, so the fee has no rate after that date (invoices then flag it). */
export async function endFeeRate(user: SessionUser, feeId: string, lastDay: string) {
  requirePerm(user, "manage_fees");
  if (!isIsoDate(lastDay)) throw new AppError("Enter the last day the rate applies.");
  return tx(async (db) => {
    const open = await one(`SELECT * FROM fee_rates WHERE fee_type_id=$1 AND effective_to IS NULL FOR UPDATE`, [feeId], db);
    if (!open) throw new AppError("This fee has no open-ended rate to end.");
    if (lastDay < open.effective_from) throw new AppError(`The current rate starts ${open.effective_from}; the end date can't be before that.`);
    await db.query(`UPDATE fee_rates SET effective_to=$2 WHERE id=$1`, [open.id, lastDay]);
    await audit(db, user.id, "end_rate", "fee_type", feeId, open, { effective_to: lastDay });
  });
}

// ───────────────────────── Which equipment a fee applies to ─────────────────────────
export async function addFeeAssignment(user: SessionUser, feeId: string, input: { scope: string; value?: string | null }) {
  requirePerm(user, "manage_fees");
  const scope = input.scope;
  if (!["class", "category", "all"].includes(scope)) throw new AppError("Choose an equipment class, a category, or all equipment.");
  const value = String(input.value ?? "").trim();
  if (scope !== "all" && value.length < 1) throw new AppError(`Enter the ${scope === "class" ? "equipment class" : "category"}.`);
  return tx(async (db) => {
    const fee = await one(`SELECT id FROM fee_types WHERE id=$1`, [feeId], db);
    if (!fee) throw new AppError("Fee not found", "not_found");
    const dup = await one(`SELECT 1 FROM fee_assignments WHERE active AND fee_type_id=$1 AND scope=$2 AND lower(COALESCE(equipment_class, category, ''))=lower($3)`, [feeId, scope, scope === "all" ? "" : value], db);
    if (dup) throw new AppError("That assignment already exists.");
    const row = await one(`INSERT INTO fee_assignments(fee_type_id,scope,equipment_class,category,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [feeId, scope, scope === "class" ? value : null, scope === "category" ? value : null, user.id], db);
    await audit(db, user.id, "assign", "fee_type", feeId, null, row);
    return row;
  });
}

export async function removeFeeAssignment(user: SessionUser, assignmentId: string) {
  requirePerm(user, "manage_fees");
  return tx(async (db) => {
    const before = await one(`SELECT * FROM fee_assignments WHERE id=$1 AND active FOR UPDATE`, [assignmentId], db);
    if (!before) throw new AppError("Assignment not found", "not_found");
    await db.query(`UPDATE fee_assignments SET active=false WHERE id=$1`, [assignmentId]);
    await audit(db, user.id, "unassign", "fee_type", before.fee_type_id, before, null);
    return before.fee_type_id as string;
  });
}

/** Switch a fee on or off for one unit, or clear the switch (null) so its class and category decide. */
export async function setUnitFee(user: SessionUser, equipmentId: string, feeId: string, enabled: boolean | null, reason?: string) {
  requirePerm(user, "manage_fees");
  if (enabled === false && String(reason ?? "").trim().length < 3) throw new AppError("Enter why this fee doesn't apply to this unit.");
  return tx(async (db) => {
    const before = await one(`SELECT enabled, reason FROM equipment_fee_settings WHERE equipment_id=$1 AND fee_type_id=$2 FOR UPDATE`, [equipmentId, feeId], db);
    if (enabled === null) await db.query(`DELETE FROM equipment_fee_settings WHERE equipment_id=$1 AND fee_type_id=$2`, [equipmentId, feeId]);
    else await db.query(`INSERT INTO equipment_fee_settings(equipment_id,fee_type_id,enabled,reason,updated_by) VALUES ($1,$2,$3,$4,$5)
                         ON CONFLICT (equipment_id, fee_type_id) DO UPDATE SET enabled=$3, reason=$4, updated_by=$5, updated_at=now()`,
      [equipmentId, feeId, enabled, String(reason ?? "").trim() || null, user.id]);
    await audit(db, user.id, "unit_fee", "equipment", equipmentId, before ? { fee_type_id: feeId, ...before } : null, { fee_type_id: feeId, enabled }, reason?.trim() || undefined);
  });
}

export async function setEquipmentClass(user: SessionUser, equipmentId: string, cls: string) {
  requirePerm(user, "edit_records");
  const v = String(cls ?? "").trim().slice(0, 60) || null;
  return tx(async (db) => {
    const before = await one(`SELECT equipment_class FROM equipment WHERE id=$1 FOR UPDATE`, [equipmentId], db);
    if (!before) throw new AppError("Unit not found", "not_found");
    await db.query(`UPDATE equipment SET equipment_class=$2 WHERE id=$1`, [equipmentId, v]);
    await audit(db, user.id, "update", "equipment", equipmentId, before, { equipment_class: v });
  });
}

// ───────────────────────── Customer exemptions ─────────────────────────
export async function addExemption(user: SessionUser, customerId: string, input: { fee_type_id: string; reason: string; certificate_ref?: string; effective_from: string; effective_to?: string }) {
  requirePerm(user, "configure_billing");
  if (!isIsoDate(input.effective_from)) throw new AppError("Enter the date the exemption starts.");
  if (input.effective_to && (!isIsoDate(input.effective_to) || input.effective_to < input.effective_from)) throw new AppError("The end date must be after the start date.");
  if (String(input.reason ?? "").trim().length < 3) throw new AppError("Enter why the customer is exempt.");
  return tx(async (db) => {
    const row = await one(`INSERT INTO fee_exemptions(customer_id,fee_type_id,reason,certificate_ref,effective_from,effective_to,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [customerId, input.fee_type_id, input.reason.trim(), String(input.certificate_ref ?? "").trim() || null, input.effective_from, input.effective_to || null, user.id], db);
    await audit(db, user.id, "create", "fee_exemption", row.id, null, row);
    return row;
  });
}

export async function removeExemption(user: SessionUser, id: string, reason: string) {
  requirePerm(user, "configure_billing");
  if (String(reason ?? "").trim().length < 3) throw new AppError("Enter why the exemption is being removed.");
  return tx(async (db) => {
    const before = await one(`SELECT * FROM fee_exemptions WHERE id=$1 AND removed_at IS NULL FOR UPDATE`, [id], db);
    if (!before) throw new AppError("Exemption not found", "not_found");
    await db.query(`UPDATE fee_exemptions SET removed_at=now(), removed_by=$2, removed_reason=$3 WHERE id=$1`, [id, user.id, reason.trim()]);
    await audit(db, user.id, "remove", "fee_exemption", id, before, null, reason.trim());
    return before.customer_id as string;
  });
}

// ───────────────────────── Overrides on one rental or sale ─────────────────────────
export async function setFeeOverride(user: SessionUser, target: { lineId?: string; saleId?: string }, input: { fee_type_id: string; mode: string; value?: string; reason: string }) {
  requirePerm(user, "override_fees");
  if (String(input.reason ?? "").trim().length < 5) throw new AppError("Enter why this fee is being changed.");
  return tx(async (db) => {
    const fee = await one(`SELECT * FROM fee_types WHERE id=$1`, [input.fee_type_id], db);
    if (!fee) throw new AppError("Fee not found", "not_found");
    if (!fee.allow_override) throw new AppError(`${fee.name} is set so it can't be changed on a single rental or sale.`);
    let percent: string | null = null, amount: string | null = null;
    const waived = input.mode === "waive";
    if (!waived) {
      const v = String(input.value ?? "").trim();
      if (!/^\d{1,7}(\.\d{1,4})?$/.test(v)) throw new AppError(fee.calc_type === "percent" ? "Enter the percent, like 1.5" : "Enter the amount, like 25.00");
      if (fee.calc_type === "percent") { if (dec(v).lte(0) || dec(v).gte(100)) throw new AppError("Enter a percent between 0 and 100."); percent = dec(v).div(100).toFixed(6); }
      else amount = dec(v).toFixed(2);
    }
    if (target.saleId) {
      const sale = await one(`SELECT status FROM equipment_sales WHERE id=$1`, [target.saleId], db);
      if (sale?.status !== "draft") throw new AppError("Fees can only be changed while the sale is a draft.");
    }
    const col = target.lineId ? "contract_line_id" : "sale_id";
    const id = target.lineId ?? target.saleId;
    const prev = await one(`SELECT * FROM fee_overrides WHERE fee_type_id=$1 AND ${col}=$2 AND removed_at IS NULL FOR UPDATE`, [fee.id, id], db);
    if (prev) await db.query(`UPDATE fee_overrides SET removed_at=now(), removed_by=$2 WHERE id=$1`, [prev.id, user.id]);
    const row = await one(`INSERT INTO fee_overrides(fee_type_id,${col},waived,percent,amount,reason,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [fee.id, id, waived, percent, amount, input.reason.trim(), user.id], db);
    await audit(db, user.id, "override", "fee_override", row.id, prev, row, input.reason.trim());
    return row;
  });
}

export async function removeFeeOverride(user: SessionUser, overrideId: string) {
  requirePerm(user, "override_fees");
  return tx(async (db) => {
    const before = await one(`SELECT o.*, s.status AS sale_status FROM fee_overrides o LEFT JOIN equipment_sales s ON s.id=o.sale_id WHERE o.id=$1 AND o.removed_at IS NULL FOR UPDATE OF o`, [overrideId], db);
    if (!before) throw new AppError("Override not found", "not_found");
    if (before.sale_id && before.sale_status !== "draft") throw new AppError("Fees can only be changed while the sale is a draft.");
    await db.query(`UPDATE fee_overrides SET removed_at=now(), removed_by=$2 WHERE id=$1`, [overrideId, user.id]);
    await audit(db, user.id, "remove", "fee_override", overrideId, before, null);
    return before as { contract_line_id: string | null; sale_id: string | null };
  });
}

// ───────────────────────── Lists for pages ─────────────────────────
export async function feeAdminList() {
  const [types, rates, assignments] = await Promise.all([
    q(`SELECT t.*, (SELECT count(*) FROM equipment_fee_settings s WHERE s.fee_type_id=t.id AND s.enabled) AS units_on,
               (SELECT count(*) FROM equipment_fee_settings s WHERE s.fee_type_id=t.id AND NOT s.enabled) AS units_off
        FROM fee_types t ORDER BY t.active DESC, t.category, t.name`),
    q(`SELECT * FROM fee_rates ORDER BY fee_type_id, effective_from DESC`),
    q(`SELECT * FROM fee_assignments WHERE active ORDER BY fee_type_id, scope, equipment_class, category`),
  ]);
  return { types, rates, assignments };
}

export const equipmentClasses = () => q<{ v: string }>(`SELECT DISTINCT equipment_class AS v FROM equipment WHERE equipment_class IS NOT NULL ORDER BY 1`);
export const equipmentCategories = () => q<{ v: string }>(`SELECT DISTINCT category AS v FROM equipment WHERE category IS NOT NULL ORDER BY 1`);

export async function listExemptions(customerId: string) {
  return q(`SELECT e.*, t.name AS fee_name, t.code, u.name AS created_by_name FROM fee_exemptions e JOIN fee_types t ON t.id=e.fee_type_id LEFT JOIN users u ON u.id=e.created_by
            WHERE e.customer_id=$1 ORDER BY (e.removed_at IS NULL) DESC, e.effective_from DESC`, [customerId]);
}

/**
 * Fees and taxes billed, by fee, for invoices and sales finalized in [from, to].
 * Regulatory taxes and business surcharges are kept in separate groups.
 */
export async function feeReport(from: string, to: string) {
  return q(`
    WITH lines AS (
      SELECT l.fee_type_id, l.amount, i.invoice_date AS d FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id
       WHERE l.fee_type_id IS NOT NULL AND i.finalized_at IS NOT NULL AND i.status NOT IN ('voided','corrected') AND i.invoice_date BETWEEN $1 AND $2
      UNION ALL
      SELECT f.fee_type_id, f.amount, s.sale_date FROM sale_fees f JOIN equipment_sales s ON s.id=f.sale_id
       WHERE s.finalized_at IS NOT NULL AND s.status <> 'voided' AND s.sale_date BETWEEN $1 AND $2)
    SELECT t.id, t.code, t.name, t.category, t.gl_account, count(*)::int AS lines, COALESCE(sum(lines.amount),0)::numeric(14,2) AS total
      FROM lines JOIN fee_types t ON t.id=lines.fee_type_id
     GROUP BY t.id ORDER BY t.category, t.name`, [from, to]);
}
