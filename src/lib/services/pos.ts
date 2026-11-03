import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { billedPeriodFor, billedPeriodForMonth } from "../billing";
import { normalizePo, normalizeRef, validatePoFormat } from "../po";
import { isIsoDate, monthStart } from "../dates";
import { parseMoney } from "../money";
import { LineContext, loadLineContext } from "./records";

/** Find or create the billing period of a line that contains the given month (calendar billing) or date. */
export async function ensureBillingPeriod(db: Db, ctx: LineContext, monthOrDate: string) {
  const p = ctx.method === "calendar_month"
    ? billedPeriodForMonth(ctx.window, monthStart(monthOrDate))
    : billedPeriodFor(ctx.window, monthOrDate);
  if (!p) throw new AppError(`Unit ${ctx.equipment.unit_number} is not billable in that period (billing starts ${ctx.line.billing_start_date}${ctx.line.off_rent_date ? `, off rent ${ctx.line.off_rent_date}` : ""}).`, "not_billable");
  const existing = await one(`SELECT * FROM billing_periods WHERE contract_line_id=$1 AND period_start=$2`, [ctx.line.id, p.start], db);
  if (existing) {
    if (existing.period_end !== p.end) {
      // Window changed (e.g. call-off) since the period was created. Adjust only if nothing finalized depends on it.
      const fin = await one(`SELECT id FROM invoices WHERE billing_period_id=$1 AND finalized_at IS NOT NULL AND status NOT IN ('voided','corrected')`, [existing.id], db);
      if (fin) return existing;
      return one(`UPDATE billing_periods SET period_end=$2 WHERE id=$1 RETURNING *`, [existing.id, p.end], db);
    }
    return existing;
  }
  // ON CONFLICT DO NOTHING covers both the unique key and the no-overlap exclusion constraint, so two
  // employees creating the same period at the same moment (e.g. import apply + bulk generate) both succeed.
  const inserted = await one(
    `INSERT INTO billing_periods(contract_line_id, period_start, period_end, billing_month) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`,
    [ctx.line.id, p.start, p.end, ctx.method === "calendar_month" ? monthStart(p.start) : null], db);
  if (inserted) return inserted;
  const raced = await one(`SELECT * FROM billing_periods WHERE contract_line_id=$1 AND period_start=$2`, [ctx.line.id, p.start], db);
  if (raced) return raced;
  throw new AppError(`Unit ${ctx.equipment.unit_number} already has a billing period overlapping ${p.start} – ${p.end}. Billing periods can never overlap.`, "period_overlap");
}

export interface AssignPoInput {
  lineId: string;
  period: string;             // first-of-month for calendar billing, or any date inside the period
  poNumber: string;
  estimatedTotal?: string | number | null;
  jobNumber?: string | null;
  workOrderNumber?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  expiresOn?: string | null;
  reason?: string | null;
  replaceExisting?: boolean;  // correction of an already-assigned PO (requires reason)
  source?: "manual" | "import" | "correction";
  importRowId?: string | null;
  importBatchId?: string | null;
}

export interface AssignResult { assignment: any; superseded?: any; warnings: string[]; unchanged?: boolean }

/** Core rule enforcement for PO ↔ billing period assignment. Runs inside the caller's transaction. */
export async function assignPoInTx(db: Db, user: SessionUser, input: AssignPoInput): Promise<AssignResult> {
  const ctx = await loadLineContext(input.lineId, db);
  const po = normalizePo(input.poNumber);
  const fmt = validatePoFormat(po, ctx.profile);
  if (!fmt.ok) throw new AppError(fmt.message, "invalid_po");
  for (const d of [input.validFrom, input.validTo, input.expiresOn]) if (d && !isIsoDate(d)) throw new AppError(`Invalid date ${d}`);
  const est = parseMoney(input.estimatedTotal ?? null);
  const period = await ensureBillingPeriod(db, ctx, input.period);
  const warnings: string[] = [];

  // Serialize concurrent assignments to the same period.
  await db.query(`SELECT id FROM billing_periods WHERE id=$1 FOR UPDATE`, [period.id]);

  let poRow = await one(`SELECT * FROM purchase_orders WHERE customer_id=$1 AND po_number=$2 FOR UPDATE`, [ctx.customer.id, po], db);
  if (!poRow) {
    poRow = await one(
      `INSERT INTO purchase_orders(customer_id,po_number,estimated_total,valid_from,valid_to,expires_on,import_batch_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ctx.customer.id, po, est?.toFixed(2) ?? null, input.validFrom || null, input.validTo || null, input.expiresOn || null, input.importBatchId ?? null, user.id], db);
  } else if (est && poRow.estimated_total !== est.toFixed(2)) {
    if (poRow.estimated_total == null) {
      poRow = await one(`UPDATE purchase_orders SET estimated_total=$2 WHERE id=$1 RETURNING *`, [poRow.id, est.toFixed(2)], db);
    } else {
      warnings.push(`PO ${po} already recorded with estimated total ${poRow.estimated_total}; kept the original value.`);
    }
  }

  // A PO used elsewhere (other machine, or another month) is not allowed when the customer requires unique monthly POs.
  const otherUses = await q(
    `SELECT a.*, e.unit_number, bp.period_start FROM po_assignments a JOIN equipment e ON e.id=a.equipment_id JOIN billing_periods bp ON bp.id=a.billing_period_id
     WHERE a.purchase_order_id=$1 AND a.status='active' AND a.billing_period_id<>$2`, [poRow.id, period.id], db);
  if (otherUses.length && (ctx.profile.unique_po_per_unit || ctx.profile.require_monthly_po)) {
    const u = otherUses[0];
    throw new AppError(`PO ${po} is already assigned to unit ${u.unit_number} for the period starting ${u.period_start}. ${ctx.customer.name} requires a new PO per machine per month.`, "po_in_use");
  }

  const current = await one(`SELECT a.*, p.po_number FROM po_assignments a JOIN purchase_orders p ON p.id=a.purchase_order_id
                             WHERE a.billing_period_id=$1 AND a.status='active'`, [period.id], db);
  const job = normalizeRef(input.jobNumber) ?? null;
  const wo = normalizeRef(input.workOrderNumber) ?? null;

  if (current) {
    if (current.purchase_order_id === poRow.id && (job == null || job === current.job_number) && (wo == null || wo === current.work_order_number)) {
      return { assignment: current, warnings: [...warnings, "This PO was already assigned to that period; nothing changed."], unchanged: true };
    }
    if (!input.replaceExisting) {
      throw new AppError(`Unit ${ctx.equipment.unit_number} already has PO ${current.po_number} for ${period.period_start} – ${period.period_end}. Use "Correct PO" to replace it with an audit reason.`, "po_exists");
    }
    requirePerm(user, "correct_po");
    if (!input.reason || input.reason.trim().length < 5) throw new AppError("Enter the reason for correcting this PO.");
  }

  // End the old assignment first (one-active-per-period index), then insert the new one and link them.
  let superseded: any;
  if (current) {
    superseded = await one(`UPDATE po_assignments SET status='superseded', ended_by=$2, ended_at=now() WHERE id=$1 RETURNING *`, [current.id, user.id], db);
  }
  const created = await one(
    `INSERT INTO po_assignments(purchase_order_id,customer_id,contract_line_id,equipment_id,billing_period_id,job_number,work_order_number,status,source,import_row_id,reason,assigned_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11) RETURNING *`,
    [poRow.id, ctx.customer.id, ctx.line.id, ctx.equipment.id, period.id,
     job ?? ctx.contract.job_number ?? null, wo ?? ctx.contract.work_order_number ?? null,
     input.source ?? (current ? "correction" : "manual"), input.importRowId ?? null, input.reason ?? null, user.id], db);
  if (superseded) {
    superseded = await one(`UPDATE po_assignments SET superseded_by=$2 WHERE id=$1 RETURNING *`, [superseded.id, created.id], db);
    const fin = await one(`SELECT invoice_number, status FROM invoices WHERE billing_period_id=$1 AND finalized_at IS NOT NULL AND status NOT IN ('voided','corrected')`, [period.id], db);
    if (fin) warnings.push(`Invoice ${fin.invoice_number} for this period is already finalized and still shows PO ${current.po_number}. Create a revision of that invoice to reissue it with PO ${po}.`);
  }
  await audit(db, user.id, current ? "correct_po" : "assign_po", "po_assignment", created.id,
    current ? { assignment_id: current.id, po_number: current.po_number, job_number: current.job_number, work_order_number: current.work_order_number } : null,
    { assignment_id: created.id, po_number: po, unit: ctx.equipment.unit_number, period_start: period.period_start, period_end: period.period_end, job_number: created.job_number, work_order_number: created.work_order_number, source: created.source },
    input.reason ?? undefined);

  if (job && ctx.contract.job_number && job !== ctx.contract.job_number) warnings.push(`Job ${job} differs from the rental's job ${ctx.contract.job_number}.`);
  if (wo && ctx.contract.work_order_number && wo !== ctx.contract.work_order_number) warnings.push(`Work order ${wo} differs from the rental's work order ${ctx.contract.work_order_number}.`);
  return { assignment: created, superseded, warnings };
}

export async function assignPo(user: SessionUser, input: AssignPoInput) {
  requirePerm(user, "assign_po");
  return tx((db) => assignPoInTx(db, user, input));
}

/** Remove a mistaken PO assignment (not allowed once a finalized invoice uses it). */
export async function removePoAssignment(user: SessionUser, assignmentId: string, reason: string) {
  requirePerm(user, "correct_po");
  if (!reason || reason.trim().length < 5) throw new AppError("Enter the reason for removing this PO.");
  return tx(async (db) => {
    const a = await one(`SELECT * FROM po_assignments WHERE id=$1 FOR UPDATE`, [assignmentId], db);
    if (!a || a.status !== "active") throw new AppError("Active PO assignment not found", "not_found");
    const fin = await one(`SELECT invoice_number FROM invoices WHERE po_assignment_id=$1 AND finalized_at IS NOT NULL AND status NOT IN ('voided','corrected')`, [assignmentId], db);
    if (fin) throw new AppError(`Finalized invoice ${fin.invoice_number} uses this PO. Revise or void that invoice instead.`);
    const after = await one(`UPDATE po_assignments SET status='removed', ended_by=$2, ended_at=now() WHERE id=$1 RETURNING *`, [assignmentId, user.id], db);
    await audit(db, user.id, "remove_po", "po_assignment", assignmentId, a, after, reason);
    return after;
  });
}

export async function poHistoryForLine(lineId: string, db: Db = pool()) {
  return q(`SELECT a.*, p.po_number, p.estimated_total, p.valid_from, p.valid_to, p.expires_on, bp.period_start, bp.period_end,
                   u.name AS assigned_by_name, ue.name AS ended_by_name
            FROM po_assignments a JOIN purchase_orders p ON p.id=a.purchase_order_id JOIN billing_periods bp ON bp.id=a.billing_period_id
            LEFT JOIN users u ON u.id=a.assigned_by LEFT JOIN users ue ON ue.id=a.ended_by
            WHERE a.contract_line_id=$1 ORDER BY bp.period_start DESC, a.assigned_at DESC`, [lineId], db);
}

export async function activePoForPeriod(periodId: string, db: Db = pool()) {
  return one(`SELECT a.*, p.po_number, p.estimated_total, p.valid_from, p.valid_to, p.expires_on
              FROM po_assignments a JOIN purchase_orders p ON p.id=a.purchase_order_id
              WHERE a.billing_period_id=$1 AND a.status='active'`, [periodId], db);
}
