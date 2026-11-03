import { createHash } from "node:crypto";
import Papa from "papaparse";
import ExcelJS from "exceljs";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { normalizePo, normalizeRef, normalizeUnit, similarUnits, validatePoFormat } from "../po";
import { D, dec, money, parseMoney } from "../money";
import { billedPeriodForMonth, lastBillableDay } from "../billing";
import { fmtDate, monthEnd, monthStart } from "../dates";
import { LineContext, loadLineContext } from "./records";
import { assignPoInTx } from "./pos";
import { calculatePeriod } from "./invoices";

export interface Issue { code: string; severity: "error" | "warning" | "info"; message: string; suggestions?: string[] }
export interface ParsedRow { row_number: number; raw: Record<string, unknown>; po_number: string; unit_number: string; work_order_number: string | null; job_number: string | null; po_total: string | null; parse_errors: string[] }

const HEADER_MAP: Record<string, keyof Omit<ParsedRow, "row_number" | "raw" | "parse_errors">> = {
  ponumber: "po_number", po: "po_number", "po#": "po_number", purchaseorder: "po_number", purchaseordernumber: "po_number",
  unit: "unit_number", unitnumber: "unit_number", "unit#": "unit_number", equipment: "unit_number", equipmentunit: "unit_number", unitno: "unit_number",
  workorder: "work_order_number", wo: "work_order_number", "wo#": "work_order_number", workordernumber: "work_order_number",
  job: "job_number", jobnumber: "job_number", "job#": "job_number", jobno: "job_number",
  pototal: "po_total", total: "po_total", poamount: "po_total", amount: "po_total", estimatedtotal: "po_total",
};
const normHeader = (h: unknown) => String(h ?? "").toLowerCase().replace(/[\s_\-.]/g, "");

export function cellValue(v: any): unknown {
  if (v == null) return null;
  if (typeof v === "object") {
    if ("result" in v) return v.result;          // formula
    if ("richText" in v) return v.richText.map((t: any) => t.text).join("");
    if ("text" in v) return v.text;              // hyperlink
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return v;
}

/** Parse an RPM PO list (CSV or XLSX). Headers are matched flexibly; unknown columns are kept in raw. */
/** Read the first worksheet of an .xlsx, or a .csv, into rows of cell values. */
export async function readTable(filename: string, content: Buffer): Promise<unknown[][]> {
  let table: unknown[][];
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(content as any);
    const ws = wb.worksheets[0];
    if (!ws) throw new AppError("The workbook has no worksheets.");
    table = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals: unknown[] = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellValue(row.getCell(c).value));
      table.push(vals);
    });
  } else if (/\.(csv|txt)$/i.test(filename)) {
    const parsed = Papa.parse<string[]>(content.toString("utf8").replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
    table = parsed.data;
  } else throw new AppError("Upload a .csv or .xlsx file.");

  return table;
}

export async function parsePoFile(filename: string, content: Buffer): Promise<ParsedRow[]> {
  const table = await readTable(filename, content);
  const headerIdx = table.findIndex((r) => r.some((c) => HEADER_MAP[normHeader(c)] === "po_number") && r.some((c) => HEADER_MAP[normHeader(c)] === "unit_number"));
  if (headerIdx < 0) throw new AppError("Could not find the header row. The file needs at least 'PO Number' and 'Unit' columns.");
  const headers = table[headerIdx].map((h) => String(h ?? "").trim());
  const mapping = headers.map((h) => HEADER_MAP[normHeader(h)]);
  const rows: ParsedRow[] = [];
  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i];
    if (!r || r.every((c) => c == null || String(c).trim() === "")) continue;
    const raw: Record<string, unknown> = {};
    headers.forEach((h, j) => { raw[h || `col${j + 1}`] = r[j] ?? null; });
    const get = (k: string) => { const j = mapping.indexOf(k as any); return j >= 0 ? r[j] : null; };
    const errs: string[] = [];
    let total: string | null = null;
    try { total = parseMoney(get("po_total"))?.toFixed(2) ?? null; } catch { errs.push(`PO total "${get("po_total")}" is not a valid amount`); }
    rows.push({
      row_number: i + 1, raw,
      po_number: normalizePo(get("po_number")),
      unit_number: normalizeUnit(get("unit_number")),
      work_order_number: normalizeRef(get("work_order_number")),
      job_number: normalizeRef(get("job_number")),
      po_total: total, parse_errors: errs,
    });
  }
  if (!rows.length) throw new AppError("The file has a header row but no data rows.");
  return rows;
}

export async function createImportBatch(user: SessionUser, input: { customerId: string; billingMonth: string; filename: string; content: Buffer }) {
  requirePerm(user, "import_po");
  const month = monthStart(input.billingMonth);
  const sha = createHash("sha256").update(input.content).digest("hex");
  const rows = await parsePoFile(input.filename, input.content);
  return tx(async (db) => {
    const dupe = await one(`SELECT id, billing_month, applied_at FROM import_batches WHERE customer_id=$1 AND file_sha256=$2 AND status='applied'`, [input.customerId, sha], db);
    if (dupe) throw new AppError(`This exact file was already imported and applied (import #${dupe.id} for ${fmtDate(dupe.billing_month)}). It will not be processed twice.`, "duplicate_import", dupe);
    const open = await one(`SELECT id FROM import_batches WHERE customer_id=$1 AND file_sha256=$2 AND status='review'`, [input.customerId, sha], db);
    if (open) throw new AppError(`This file is already waiting for review as import #${open.id}.`, "duplicate_import", open);
    const batch = await one(`INSERT INTO import_batches(customer_id,billing_month,filename,file_sha256,file_content,row_count,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.customerId, month, input.filename.slice(0, 200), sha, input.content, rows.length, user.id], db);
    for (const r of rows) {
      await db.query(`INSERT INTO import_rows(batch_id,row_number,raw,po_number,unit_number,work_order_number,job_number,po_total,issues) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [batch.id, r.row_number, JSON.stringify(r.raw), r.po_number || null, r.unit_number || null, r.work_order_number, r.job_number, r.po_total,
         JSON.stringify(r.parse_errors.map((m) => ({ code: "parse", severity: "error", message: m })))]);
    }
    await analyzeBatch(db, batch.id);
    await audit(db, user.id, "upload", "import_batch", batch.id, null, { filename: input.filename, sha256: sha, rows: rows.length, month });
    return batch;
  });
}

/** Re-run every check on every row of a batch. Pure analysis: never assigns anything. */
export async function analyzeBatch(db: Db, batchId: string) {
  const batch = await one(`SELECT * FROM import_batches WHERE id=$1`, [batchId], db);
  const month = batch.billing_month as string;
  const profile = await one(`SELECT * FROM customer_billing_profiles WHERE customer_id=$1`, [batch.customer_id], db);
  const customer = await one(`SELECT * FROM customers WHERE id=$1`, [batch.customer_id], db);
  const rows = await q(`SELECT * FROM import_rows WHERE batch_id=$1 ORDER BY row_number`, [batchId], db);
  const allUnits = (await q(`SELECT e.unit_number FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id JOIN equipment e ON e.id=l.equipment_id WHERE c.customer_id=$1`, [batch.customer_id], db)).map((r) => r.unit_number);
  const unitCount = new Map<string, number>(), poCount = new Map<string, number>();
  for (const r of rows) if (r.decision !== "skipped") {
    if (r.unit_number) unitCount.set(r.unit_number, (unitCount.get(r.unit_number) ?? 0) + 1);
    if (r.po_number) poCount.set(r.po_number, (poCount.get(r.po_number) ?? 0) + 1);
  }
  const ctxCache = new Map<string, LineContext>();

  for (const r of rows) {
    const issues: Issue[] = (r.issues as Issue[]).filter((i) => i.code === "parse" && !r.edited);
    let matched: string | null = null, expected: string | null = null;
    const unit = r.unit_number as string | null;
    if (!unit) issues.push({ code: "missing_unit", severity: "error", message: "Unit number is missing." });
    else {
      if ((unitCount.get(unit) ?? 0) > 1 && r.decision !== "skipped") issues.push({ code: "duplicate_unit", severity: "error", message: `Unit ${unit} appears ${unitCount.get(unit)} times in this file. Skip the extra row(s).` });
      const line = await one(
        `SELECT l.*, c.customer_id, c.contract_number FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id JOIN equipment e ON e.id=l.equipment_id
         WHERE e.unit_number=$1 ORDER BY (c.customer_id=$2) DESC, (l.status IN ('active','off_rent')) DESC, l.on_rent_date DESC LIMIT 1`, [unit, batch.customer_id], db);
      const eq = await one(`SELECT id FROM equipment WHERE unit_number=$1`, [unit], db);
      if (!eq) {
        const sugg = similarUnits(unit, allUnits);
        issues.push({ code: "unknown_unit", severity: "error", message: `Unit ${unit} is not in Champion's equipment list${sugg.length ? `. Did you mean ${sugg.join(" or ")}? Edit the row to confirm` : ""}.`, suggestions: sugg });
      } else if (!line || String(line.customer_id) !== String(batch.customer_id)) {
        issues.push({ code: "not_customer_rental", severity: "error", message: `Unit ${unit} is not on rent to ${customer.name}.` });
      } else {
        const ctx = ctxCache.get(line.id) ?? (await loadLineContext(line.id, db));
        ctxCache.set(line.id, ctx);
        const bp = billedPeriodForMonth(ctx.window, month);
        const last = lastBillableDay(ctx.window);
        if (["returned", "closed"].includes(line.status) && (!bp)) {
          issues.push({ code: "unit_returned", severity: "error", message: `Unit ${unit} was ${line.status} ${line.returned_date ? `on ${fmtDate(line.returned_date)}` : ""} and has no billable days in this month.` });
        } else if (!bp) {
          issues.push({ code: "not_billable", severity: "error", message: `Unit ${unit} has no billable days in ${fmtDate(month)} – ${fmtDate(monthEnd(month))} (billing starts ${fmtDate(line.billing_start_date)}${last ? `, last billable day ${fmtDate(last)}` : ""}).` });
        } else {
          matched = line.id;
          if (line.status === "returned" || line.status === "off_rent") issues.push({ code: "unit_off_rent", severity: "warning", message: `Unit ${unit} is ${line.status.replace("_", "-")} (last billable day ${fmtDate(last)}). Only ${fmtDate(bp.start)} – ${fmtDate(bp.end)} will be billed.` });
          // Job / work order
          if (profile.require_job_number && !r.job_number) issues.push({ code: "missing_job", severity: "error", message: "Job number is missing." });
          else if (r.job_number && ctx.contract.job_number && r.job_number !== ctx.contract.job_number)
            issues.push({ code: "job_conflict", severity: "warning", message: `Job ${r.job_number} in the file differs from the rental's job ${ctx.contract.job_number}. The invoice will show ${r.job_number}.` });
          if (profile.require_work_order && !r.work_order_number) issues.push({ code: "missing_wo", severity: "error", message: "Work order is missing." });
          else if (r.work_order_number && ctx.contract.work_order_number && r.work_order_number !== ctx.contract.work_order_number)
            issues.push({ code: "wo_conflict", severity: "warning", message: `Work order ${r.work_order_number} differs from the rental's ${ctx.contract.work_order_number}. The invoice will show ${r.work_order_number}.` });
          // Existing assignment for this period
          const existing = await one(`SELECT a.*, p.po_number FROM po_assignments a JOIN purchase_orders p ON p.id=a.purchase_order_id JOIN billing_periods bp ON bp.id=a.billing_period_id
                                      WHERE a.contract_line_id=$1 AND bp.period_start=$2 AND a.status='active'`, [line.id, bp.start], db);
          if (existing && existing.po_number === r.po_number) issues.push({ code: "already_assigned", severity: "info", message: `PO ${r.po_number} is already assigned to this unit for this month. Applying again changes nothing.` });
          else if (existing) issues.push({ code: "replaces_po", severity: "warning", message: `Unit ${unit} already has PO ${existing.po_number} for this month. Approving this row replaces it (recorded in the audit trail).` });
          const finalized = await one(`SELECT invoice_number FROM invoices i JOIN billing_periods bp ON bp.id=i.billing_period_id WHERE i.contract_line_id=$1 AND bp.period_start=$2 AND i.finalized_at IS NOT NULL AND i.status NOT IN ('voided','corrected')`, [line.id, bp.start], db);
          if (finalized && existing?.po_number !== r.po_number) issues.push({ code: "invoice_finalized", severity: "warning", message: `Invoice ${finalized.invoice_number} for this month is already finalized and will keep its PO. A revision is needed to reissue with the new PO.` });
          // Expected total vs PO total
          try {
            const calc = calculatePeriod(ctx, { period_start: bp.start, period_end: bp.end });
            expected = calc.total;
            if (r.po_total) {
              const variance = dec(calc.total).sub(r.po_total);
              const tol = D.max(dec(profile.po_variance_tolerance_amount), dec(r.po_total).mul(dec(profile.po_variance_tolerance_pct)).div(100));
              if (variance.abs().gt(tol)) issues.push({ code: "total_variance", severity: "warning", message: `PO total ${money(r.po_total)} vs Champion's calculated ${calc.total} (variance ${money(variance)}, tolerance ${money(tol)}). Rates are not changed automatically.` });
            }
          } catch (e: any) {
            issues.push({ code: "cannot_calculate", severity: "warning", message: `Expected total could not be calculated: ${e.message}` });
          }
        }
      }
    }
    if (!r.po_number) issues.push({ code: "missing_po", severity: "error", message: "PO number is missing." });
    else {
      const fmt = validatePoFormat(r.po_number, profile);
      if (!fmt.ok) issues.push({ code: "invalid_po", severity: "error", message: fmt.message });
      if ((poCount.get(r.po_number) ?? 0) > 1 && r.decision !== "skipped" && (profile.unique_po_per_unit || profile.require_monthly_po))
        issues.push({ code: "duplicate_po", severity: "error", message: `PO ${r.po_number} appears on ${poCount.get(r.po_number)} rows. ${customer.name} requires a unique PO per machine.` });
      const used = await one(`SELECT e.unit_number, bp.period_start, a.contract_line_id FROM po_assignments a JOIN purchase_orders p ON p.id=a.purchase_order_id JOIN equipment e ON e.id=a.equipment_id JOIN billing_periods bp ON bp.id=a.billing_period_id
                              WHERE p.customer_id=$1 AND p.po_number=$2 AND a.status='active' AND NOT (a.contract_line_id=$3 AND bp.period_start=$4) LIMIT 1`,
        [batch.customer_id, r.po_number, matched ?? 0, matched ? (billedPeriodForMonth(ctxCache.get(matched)!.window, month)?.start ?? month) : month], db);
      if (used && (profile.unique_po_per_unit || profile.require_monthly_po)) issues.push({ code: "po_in_use", severity: "error", message: `PO ${r.po_number} is already assigned to unit ${used.unit_number} for ${fmtDate(used.period_start)}.` });
    }
    if (r.po_total == null && !issues.some((i) => i.code === "parse")) issues.push({ code: "missing_total", severity: "warning", message: "PO total is blank, so the amount cannot be reconciled." });

    // A row whose errors appeared after approval goes back to pending.
    const hasError = issues.some((i) => i.severity === "error");
    const decision = r.decision === "approved" && hasError ? "pending" : r.decision;
    await db.query(`UPDATE import_rows SET issues=$2, matched_line_id=$3, expected_total=$4, decision=$5 WHERE id=$1`, [r.id, JSON.stringify(issues), matched, expected, decision]);
  }

  // Active rentals missing from the file
  const inFile = new Set(rows.filter((r) => r.decision !== "skipped").map((r) => r.unit_number));
  const active = await q(`SELECT l.id, e.unit_number, c.contract_number, l.billing_start_date, l.off_rent_date FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id JOIN equipment e ON e.id=l.equipment_id
                          WHERE c.customer_id=$1 AND l.status IN ('active','off_rent') AND l.billing_start_date <= $3 AND (l.off_rent_date IS NULL OR l.off_rent_date >= $2) ORDER BY e.unit_number`,
    [batch.customer_id, month, monthEnd(month)], db);
  const missing = active.filter((a) => !inFile.has(a.unit_number));
  const fresh = await q(`SELECT issues, decision, matched_line_id FROM import_rows WHERE batch_id=$1`, [batchId], db);
  const summary = {
    rows: fresh.length,
    matched: fresh.filter((r) => r.matched_line_id).length,
    with_errors: fresh.filter((r) => r.decision !== "skipped" && (r.issues as Issue[]).some((i) => i.severity === "error")).length,
    with_warnings: fresh.filter((r) => r.decision !== "skipped" && (r.issues as Issue[]).some((i) => i.severity === "warning")).length,
    approved: fresh.filter((r) => r.decision === "approved").length,
    skipped: fresh.filter((r) => r.decision === "skipped").length,
    pending: fresh.filter((r) => r.decision === "pending").length,
    active_rentals: active.length,
    missing_from_file: missing.map((m) => ({ unit_number: m.unit_number, contract_number: m.contract_number })),
  };
  await db.query(`UPDATE import_batches SET summary=$2 WHERE id=$1`, [batchId, JSON.stringify(summary)]);
  return summary;
}

async function lockBatch(db: Db, batchId: string) {
  const b = await one(`SELECT * FROM import_batches WHERE id=$1 FOR UPDATE`, [batchId], db);
  if (!b) throw new AppError("Import not found", "not_found");
  if (b.status !== "review") throw new AppError(`Import #${batchId} is already ${b.status}.`);
  return b;
}

export async function editImportRow(user: SessionUser, rowId: string, fields: { po_number?: string; unit_number?: string; job_number?: string | null; work_order_number?: string | null; po_total?: string | null; note?: string }) {
  requirePerm(user, "import_po");
  return tx(async (db) => {
    const row = await one(`SELECT * FROM import_rows WHERE id=$1 FOR UPDATE`, [rowId], db);
    if (!row) throw new AppError("Row not found", "not_found");
    await lockBatch(db, row.batch_id);
    let total: string | null = row.po_total;
    if (fields.po_total !== undefined) { try { total = parseMoney(fields.po_total)?.toFixed(2) ?? null; } catch { throw new AppError("PO total must be an amount like 2083.00"); } }
    const after = {
      po_number: fields.po_number !== undefined ? normalizePo(fields.po_number) || null : row.po_number,
      unit_number: fields.unit_number !== undefined ? normalizeUnit(fields.unit_number) || null : row.unit_number,
      job_number: fields.job_number !== undefined ? normalizeRef(fields.job_number) : row.job_number,
      work_order_number: fields.work_order_number !== undefined ? normalizeRef(fields.work_order_number) : row.work_order_number,
      po_total: total,
    };
    await db.query(`UPDATE import_rows SET po_number=$2, unit_number=$3, job_number=$4, work_order_number=$5, po_total=$6, edited=true, decision='pending', decided_by=NULL, decided_at=NULL WHERE id=$1`,
      [rowId, after.po_number, after.unit_number, after.job_number, after.work_order_number, after.po_total]);
    await audit(db, user.id, "edit_import_row", "import_row", rowId,
      { po_number: row.po_number, unit_number: row.unit_number, job_number: row.job_number, work_order_number: row.work_order_number, po_total: row.po_total }, after, fields.note);
    await analyzeBatch(db, row.batch_id);
  });
}

export async function decideImportRow(user: SessionUser, rowId: string, decision: "approved" | "skipped" | "pending", note?: string) {
  requirePerm(user, "import_po");
  return tx(async (db) => {
    const row = await one(`SELECT * FROM import_rows WHERE id=$1 FOR UPDATE`, [rowId], db);
    if (!row) throw new AppError("Row not found", "not_found");
    await lockBatch(db, row.batch_id);
    await db.query(`UPDATE import_rows SET decision=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1`, [rowId, decision, user.id, note ?? null]);
    await analyzeBatch(db, row.batch_id); // duplicates may resolve when a row is skipped
    const fresh = await one(`SELECT * FROM import_rows WHERE id=$1`, [rowId], db);
    if (decision === "approved" && (fresh.issues as Issue[]).some((i) => i.severity === "error"))
      throw new AppError(`Row ${row.row_number} still has errors: ${(fresh.issues as Issue[]).filter((i) => i.severity === "error").map((i) => i.message).join(" ")}`);
    await audit(db, user.id, `row_${decision}`, "import_row", rowId, { decision: row.decision }, { decision }, note);
  });
}

/** Approve every row that has no errors and no warnings. Rows with warnings need an individual decision. */
export async function approveCleanRows(user: SessionUser, batchId: string) {
  requirePerm(user, "import_po");
  return tx(async (db) => {
    await lockBatch(db, batchId);
    const rows = await q(`SELECT * FROM import_rows WHERE batch_id=$1 AND decision='pending'`, [batchId], db);
    let n = 0;
    for (const r of rows) {
      if ((r.issues as Issue[]).some((i) => i.severity !== "info")) continue;
      await db.query(`UPDATE import_rows SET decision='approved', decided_by=$2, decided_at=now(), decision_note='Approved (no issues)' WHERE id=$1`, [r.id, user.id]);
      n++;
    }
    await analyzeBatch(db, batchId);
    await audit(db, user.id, "approve_clean_rows", "import_batch", batchId, null, { approved: n });
    return n;
  });
}

/** Apply every approved row in ONE transaction. Any failure rolls back the whole import. */
export async function applyImportBatch(user: SessionUser, batchId: string) {
  requirePerm(user, "apply_import");
  return tx(async (db) => {
    const batch = await lockBatch(db, batchId);
    await analyzeBatch(db, batchId);
    const rows = await q(`SELECT * FROM import_rows WHERE batch_id=$1 ORDER BY row_number`, [batchId], db);
    const pending = rows.filter((r) => r.decision === "pending");
    if (pending.length) throw new AppError(`${pending.length} row(s) still need a decision (approve or skip): rows ${pending.map((r) => r.row_number).join(", ")}.`);
    const approved = rows.filter((r) => r.decision === "approved");
    if (!approved.length) throw new AppError("No rows are approved.");
    const results: Array<{ row: number; unit: string; po: string; assignmentId: string; warnings: string[] }> = [];
    for (const r of approved) {
      const errs = (r.issues as Issue[]).filter((i) => i.severity === "error");
      if (errs.length) throw new AppError(`Row ${r.row_number} has errors: ${errs.map((e) => e.message).join(" ")}`);
      const replaces = (r.issues as Issue[]).some((i) => i.code === "replaces_po");
      const res = await assignPoInTx(db, user, {
        lineId: r.matched_line_id, period: batch.billing_month, poNumber: r.po_number, estimatedTotal: r.po_total,
        jobNumber: r.job_number, workOrderNumber: r.work_order_number, source: "import", importRowId: r.id, importBatchId: batchId,
        replaceExisting: replaces, reason: replaces ? `Replaced by import #${batchId} row ${r.row_number}${r.decision_note ? `: ${r.decision_note}` : ""}` : null,
        validFrom: batch.billing_month, validTo: monthEnd(batch.billing_month),
      });
      await db.query(`UPDATE import_rows SET applied_assignment_id=$2 WHERE id=$1`, [r.id, res.assignment.id]);
      results.push({ row: r.row_number, unit: r.unit_number, po: r.po_number, assignmentId: res.assignment.id, warnings: res.warnings });
    }
    await db.query(`UPDATE import_batches SET status='applied', applied_by=$2, applied_at=now() WHERE id=$1`, [batchId, user.id]);
    await audit(db, user.id, "apply", "import_batch", batchId, null, { applied: results.length, skipped: rows.length - results.length });
    return results;
  });
}

export async function cancelImportBatch(user: SessionUser, batchId: string) {
  requirePerm(user, "import_po");
  return tx(async (db) => {
    await lockBatch(db, batchId);
    await db.query(`UPDATE import_batches SET status='cancelled', cancelled_by=$2, cancelled_at=now() WHERE id=$1`, [batchId, user.id]);
    await audit(db, user.id, "cancel", "import_batch", batchId, null, null);
  });
}

export async function importDetail(batchId: string, db: Db = pool()) {
  const batch = await one(`SELECT b.id, b.customer_id, b.billing_month, b.filename, b.file_sha256, b.status, b.row_count, b.summary, b.uploaded_at, b.applied_at,
                                  c.name AS customer_name, u.name AS uploaded_by_name, ua.name AS applied_by_name
                           FROM import_batches b JOIN customers c ON c.id=b.customer_id LEFT JOIN users u ON u.id=b.uploaded_by LEFT JOIN users ua ON ua.id=b.applied_by WHERE b.id=$1`, [batchId], db);
  if (!batch) return null;
  const rows = await q(`SELECT r.*, e.description AS equipment_description, c.contract_number, ud.name AS decided_by_name
                        FROM import_rows r LEFT JOIN rental_contract_lines l ON l.id=r.matched_line_id LEFT JOIN equipment e ON e.id=l.equipment_id LEFT JOIN rental_contracts c ON c.id=l.contract_id
                        LEFT JOIN users ud ON ud.id=r.decided_by WHERE r.batch_id=$1 ORDER BY r.row_number`, [batchId], db);
  return { batch, rows };
}
