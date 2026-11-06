import { createHash } from "node:crypto";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { exemptionLabel, taxExemptionFor } from "./tax-exempt";
import { SessionUser, requirePerm } from "../permissions";
import { BILLING_METHOD_LABELS, OvertimeResult, ProrationNotApprovedError, RateBasisMismatchError, billedPeriodFor, computeOvertime, computeRentalCharge, computeTax, lastBillableDay } from "../billing";
import { D, cents, dec, money } from "../money";
import { addDays, fmtDate, todayCentral } from "../dates";
import { validatePoFormat } from "../po";
import { LineContext, loadLineContext, unitSegments } from "./records";
import { activePoForPeriod, ensureBillingPeriod } from "./pos";
import { RdwDecision, rdwDecision } from "./insurance";
import { applicableFees, computeFee, isExempt, rateOn } from "../fees";
import { renderInvoicePdf } from "../pdf";

export class DuplicateInvoiceError extends AppError {
  constructor(public existing: { id: string; invoice_number: string | null; status: string }) {
    super(`An invoice already exists for this unit and billing period (${existing.invoice_number ?? `draft #${existing.id}`}, status ${existing.status}). Open the existing invoice instead of creating a duplicate.`, "duplicate_invoice", existing);
  }
}

export const LIVE_STATUSES = ["draft", "pending_review", "approved", "issued", "partially_paid", "paid", "overdue"];
export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", pending_review: "Pending review", rejected: "Rejected", approved: "Approved", issued: "Issued",
  partially_paid: "Partially paid", paid: "Paid", overdue: "Overdue", voided: "Voided", corrected: "Corrected (superseded)", credited: "Credited in full",
};

export async function companySettings(db: Db = pool()) {
  return one(`SELECT * FROM company_settings WHERE id=1`, [], db);
}

// ───────────────────────── Calculation ─────────────────────────
export interface DraftCalc {
  lines: Array<{ kind: string; description: string; quantity: string; unit: string; unit_price: string; amount: string; taxable: boolean; fee_type_id?: string; fee_category?: string }>;
  subtotal: string; taxable_amount: string; tax_rate: string; tax_amount: string; total: string;
  calc: Record<string, unknown>;
  oneTimeFeeIds: string[];
}

/** Hour meter readings and fuel entered for one billing period, one row per unit on site. */
export interface UsageRow { equipment_id: string; start_hours: string | null; end_hours: string | null; fuel_gallons: string | null }

const fmtHours = (v: string) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pctText = (v: string) => `${dec(v).mul(100).toDecimalPlaces(2).toString()}%`;

export function calculatePeriod(ctx: LineContext, period: { period_start: string; period_end: string; usage?: UsageRow[] }): DraftCalc {
  const billed = { start: period.period_start, end: period.period_end };
  const bp = billedPeriodFor(ctx.window, billed.start);
  if (!bp || bp.start !== billed.start || bp.end !== billed.end)
    throw new AppError(`Billing period ${billed.start} – ${billed.end} no longer matches the rental's billable dates${bp ? ` (expected ${bp.start} – ${bp.end})` : ""}.`, "period_mismatch");
  let rc;
  try {
    rc = computeRentalCharge({ rateAmount: ctx.line.rate_amount, rateBasis: ctx.rateBasis, method: ctx.method, proration: ctx.profile.proration_policy, billed, nominal: bp.nominal });
  } catch (e) {
    if (e instanceof ProrationNotApprovedError || e instanceof RateBasisMismatchError) throw new AppError(e.message, e.code);
    throw e;
  }
  // Name the unit(s) actually on site in this period. An exchange keeps the same rental and rate, so the
  // charge is unchanged; the description just shows which machine was there on which days.
  const segs = unitSegments(ctx, billed.start, billed.end);
  const units = segs.length > 1
    ? segs.map((g, i) => `${i ? "exchanged for " : ""}Unit ${g.equipment.unit_number} ${g.equipment.description} (${fmtDate(g.from)} to ${fmtDate(g.to)})`).join(", ")
    : `Unit ${(segs[0]?.equipment ?? ctx.equipment).unit_number} ${(segs[0]?.equipment ?? ctx.equipment).description}`;
  const lines: DraftCalc["lines"] = [{
    kind: "rental",
    description: `Rental — ${units} — ${fmtDate(billed.start)} to ${fmtDate(billed.end)} (${rc.explanation})`,
    quantity: rc.quantity, unit: rc.unit, unit_price: rc.unitPrice, amount: rc.amount, taxable: ctx.line.taxable,
  }];
  // Usage-based charges. Each is off until the customer's billing profile turns it on.
  const p = ctx.profile;
  const usage = period.usage ?? [];
  const usageFor = (g: { equipment: any }) => usage.find((u) => String(u.equipment_id) === String(g.equipment.id));
  let overtime: OvertimeResult | null = null;
  if (p.overtime_enabled) {
    const readings = segs.map((g) => ({ unit: g.equipment.unit_number, start: usageFor(g)?.start_hours ?? null, end: usageFor(g)?.end_hours ?? null }));
    overtime = computeOvertime({ rateAmount: ctx.line.rate_amount, rateBasis: ctx.rateBasis, billedDays: rc.billedDays, isPartial: rc.isPartial,
      hoursPerDay: p.hours_per_day, hoursPerWeek: p.hours_per_week, hoursPerMonth: p.hours_per_month, multiplier: p.overtime_multiplier, readings });
    if (overtime.status === "ok" && dec(overtime.amount).gt(0)) {
      const meters = readings.map((r) => `${readings.length > 1 ? `${r.unit} ` : ""}meter ${fmtHours(r.start!)} to ${fmtHours(r.end!)}`).join("; ");
      lines.push({ kind: "overtime", description: `Extra hours — ${overtime.explanation} (${meters})`,
        quantity: dec(overtime.over).toFixed(4), unit: "hour", unit_price: overtime.unitPrice, amount: overtime.amount, taxable: ctx.line.taxable });
    }
  }
  const rentalAmount = dec(rc.amount);
  const rdw = rdwDecision({ pct: p.damage_waiver_pct, choice: p.rdw_choice ?? "rdw", lineWaived: !!ctx.line.damage_waiver_waived, cois: ctx.cois ?? [], start: billed.start, end: billed.end });
  if (rdw.status === "billed" && rentalAmount.gt(0)) {
    const amt = money(rentalAmount.mul(p.damage_waiver_pct));
    lines.push({ kind: "damage_waiver", description: `Damage waiver (${pctText(p.damage_waiver_pct)} of rental)`, quantity: "1.0000", unit: "each", unit_price: dec(amt).toFixed(4), amount: amt, taxable: ctx.line.taxable });
  }
  if (p.environmental_pct && rentalAmount.gt(0)) {
    const amt = money(rentalAmount.mul(p.environmental_pct));
    lines.push({ kind: "environmental", description: `Environmental fee (${pctText(p.environmental_pct)} of rental)`, quantity: "1.0000", unit: "each", unit_price: dec(amt).toFixed(4), amount: amt, taxable: ctx.line.taxable });
  }
  const gallons = usage.reduce((s, u) => s.add(dec(u.fuel_gallons)), new D(0));
  if (gallons.gt(0) && p.fuel_price_per_gallon) {
    lines.push({ kind: "fuel", description: `Fuel — ${gallons.toFixed(1)} gallons × ${dec(p.fuel_price_per_gallon).toFixed(2)}/gal`,
      quantity: gallons.toFixed(4), unit: "gallon", unit_price: dec(p.fuel_price_per_gallon).toFixed(4), amount: money(gallons.mul(p.fuel_price_per_gallon)), taxable: ctx.line.taxable });
  }

  const firstPeriod = billed.start === ctx.line.billing_start_date;
  // Equipment fees and taxes (HET, TERP, surcharges): each one its own line, worked out for this billing cycle.
  const feeNotes: Array<{ code: string; name: string; status: string }> = [];
  if (ctx.feeSetup) {
    const unit = segs.at(-1)?.equipment ?? ctx.equipment;
    const fs = ctx.feeSetup;
    const fees = applicableFees(fs.config.types, "rental", unit, fs.config.assignments, fs.unitSettings[String(unit.id)] ?? []);
    for (const fee of fees) {
      const o = computeFee({ fee, rate: rateOn(fs.config.rates, fee.id, billed.start), exempt: isExempt(fs.exemptions, fee.id, billed.start),
        override: fs.overrides.find((x) => String(x.fee_type_id) === String(fee.id)) ?? null, base: rc.amount, firstPeriod, baseLabel: "rental" });
      feeNotes.push({ code: fee.code, name: fee.name, status: o.status });
      if (o.status === "billed" && dec(o.amount).gt(0))
        lines.push({ kind: "equipment_fee", description: o.description, quantity: "1.0000", unit: "each", unit_price: dec(o.amount).toFixed(4), amount: o.amount,
          taxable: fee.taxable && !!ctx.line.taxable, fee_type_id: fee.id, fee_category: fee.category });
    }
  }
  if (firstPeriod && ctx.line.billing_start_date === ctx.line.on_rent_date && dec(ctx.line.delivery_charge).gt(0)) {
    lines.push({ kind: "delivery", description: "Delivery", quantity: "1.0000", unit: "each", unit_price: dec(ctx.line.delivery_charge).toFixed(4), amount: money(ctx.line.delivery_charge), taxable: ctx.line.taxable });
  }
  const last = lastBillableDay(ctx.window);
  if (last && billed.end === last && dec(ctx.line.pickup_charge).gt(0)) {
    lines.push({ kind: "pickup", description: "Pickup", quantity: "1.0000", unit: "each", unit_price: dec(ctx.line.pickup_charge).toFixed(4), amount: money(ctx.line.pickup_charge), taxable: ctx.line.taxable });
  }
  const oneTimeFeeIds: string[] = [];
  for (const f of ctx.fees) {
    if (f.frequency === "one_time") {
      if (f.billed_on_invoice_id) continue;
      oneTimeFeeIds.push(f.id);
    }
    lines.push({ kind: "fee", description: f.description, quantity: "1.0000", unit: "each", unit_price: dec(f.amount).toFixed(4), amount: money(f.amount), taxable: f.taxable });
  }
  const subtotal = lines.reduce((s, l) => s.add(l.amount), new D(0));
  // A sales tax exemption certificate (ag, resale, interstate) covering the period start: no sales tax.
  const exempt = taxExemptionFor(ctx.taxExemptions, ctx.contract.id, billed.start);
  const taxable = exempt ? new D(0) : lines.filter((l) => l.taxable).reduce((s, l) => s.add(l.amount), new D(0));
  const taxRate = exempt ? "0.00000" : dec(ctx.profile.tax_rate).toFixed(5);
  const tax = computeTax(taxable, taxRate);
  const total = cents(subtotal.add(tax));
  return {
    lines, subtotal: money(subtotal), taxable_amount: money(taxable), tax_rate: taxRate, tax_amount: tax, total: total.toFixed(2), oneTimeFeeIds,
    calc: { method: ctx.method, rate_basis: ctx.rateBasis, rate: ctx.line.rate_amount, proration_policy: ctx.profile.proration_policy,
      billed_days: rc.billedDays, period_days: rc.periodDays, partial: rc.isPartial, nominal: bp.nominal, explanation: rc.explanation,
      overtime, rdw, fees: feeNotes, tax_exempt: exempt ? { id: exempt.id, reason: exempt.reason, certificate_number: exempt.certificate_number, label: exemptionLabel(exempt) } : null, fuel_gallons: gallons.toFixed(1), fuel_unpriced: gallons.gt(0) && !p.fuel_price_per_gallon },
  };
}

function buildSnapshot(ctx: LineContext, company: any, assignment: any | null, period: any) {
  const segs = unitSegments(ctx, period.period_start, period.period_end);
  const eq = segs.at(-1)?.equipment ?? ctx.equipment;
  return {
    company: { legal_name: company.legal_name, address_line1: company.address_line1, address_line2: company.address_line2, city_state_zip: company.city_state_zip,
      phone: company.phone, email: company.email, remit_to: company.remit_to, is_placeholder: company.is_placeholder },
    customer: { id: ctx.customer.id, code: ctx.customer.customer_code, name: ctx.customer.name, billing_address: ctx.customer.billing_address },
    contract: { id: ctx.contract.id, number: ctx.contract.contract_number, start_date: ctx.contract.start_date, quipli_reference: ctx.contract.quipli_reference },
    line: { id: ctx.line.id, on_rent_date: ctx.line.on_rent_date, rate_amount: ctx.line.rate_amount, rate_basis: ctx.line.rate_basis, equipment_id: eq.id },
    equipment: { id: eq.id, unit_number: eq.unit_number, description: eq.description, serial_number: eq.serial_number, make: eq.make, model: eq.model },
    // Only present when the unit was exchanged during this period.
    ...(segs.length > 1 ? { units: segs.map((g) => ({ id: g.equipment.id, unit_number: g.equipment.unit_number, description: g.equipment.description, serial_number: g.equipment.serial_number, from: g.from, to: g.to })) } : {}),
    jobsite: ctx.jobsite ? { name: ctx.jobsite.name, address: ctx.jobsite.address } : null,
    job_number: assignment?.job_number ?? ctx.contract.job_number ?? null,
    work_order_number: assignment?.work_order_number ?? ctx.contract.work_order_number ?? null,
    po: assignment ? { number: assignment.po_number, assignment_id: assignment.id, estimated_total: assignment.estimated_total } : null,
    period: { start: period.period_start, end: period.period_end, billing_method: BILLING_METHOD_LABELS[ctx.method] },
    terms: { days: ctx.contract.payment_terms_days ?? ctx.profile.payment_terms_days, label: ctx.contract.payment_terms_days ? `Net ${ctx.contract.payment_terms_days}` : ctx.profile.payment_terms_label },
    tax: (() => {
      const x = taxExemptionFor(ctx.taxExemptions, ctx.contract.id, period.period_start);
      return x ? { rate: "0", is_placeholder: false, exempt: exemptionLabel(x) } : { rate: ctx.profile.tax_rate, is_placeholder: ctx.profile.tax_rate_is_placeholder };
    })(),
  };
}

async function writeLines(db: Db, invoiceId: string, lines: DraftCalc["lines"]) {
  await db.query(`DELETE FROM invoice_lines WHERE invoice_id=$1`, [invoiceId]);
  let n = 1;
  for (const l of lines) {
    await db.query(`INSERT INTO invoice_lines(invoice_id,line_no,kind,description,quantity,unit,unit_price,amount,taxable,fee_type_id,fee_category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [invoiceId, n++, l.kind, l.description, l.quantity, l.unit, l.unit_price, l.amount, l.taxable, l.fee_type_id ?? null, l.fee_category ?? null]);
  }
}

async function history(db: Db, invoiceId: string, from: string | null, to: string, userId: string | null, note?: string) {
  await db.query(`INSERT INTO invoice_status_history(invoice_id,from_status,to_status,user_id,note) VALUES ($1,$2,$3,$4,$5)`, [invoiceId, from, to, userId, note ?? null]);
}

export async function periodUsage(db: Db, periodId: string): Promise<UsageRow[]> {
  return q(`SELECT equipment_id, start_hours, end_hours, fuel_gallons FROM period_usage WHERE billing_period_id=$1 ORDER BY id`, [periodId], db) as Promise<UsageRow[]>;
}

/** Estimate (no writes besides the idempotent billing period) used for import reconciliation. */
export async function estimateForMonth(db: Db, lineId: string, month: string) {
  const ctx = await loadLineContext(lineId, db);
  const period = await ensureBillingPeriod(db, ctx, month);
  return calculatePeriod(ctx, { ...period, usage: await periodUsage(db, period.id) });
}

// ───────────────────────── Generation ─────────────────────────
async function generateInTx(db: Db, user: SessionUser, lineId: string, periodRef: string, revisionOf?: any) {
  const ctx = await loadLineContext(lineId, db);
  const period = await ensureBillingPeriod(db, ctx, periodRef);
  await db.query(`SELECT id FROM billing_periods WHERE id=$1 FOR UPDATE`, [period.id]);
  const existing = await one(`SELECT id, invoice_number, status FROM invoices WHERE billing_period_id=$1 AND status <> ALL($2)`, [period.id, ["voided", "rejected", "corrected"]], db);
  if (existing) throw new DuplicateInvoiceError(existing);
  // Belt and braces: no live invoice on this line may overlap these dates (the DB constraint on billing_periods also guarantees this).
  const overlap = await one(`SELECT id, invoice_number FROM invoices WHERE contract_line_id=$1 AND status <> ALL($2) AND daterange(period_start,period_end,'[]') && daterange($3::date,$4::date,'[]')`,
    [lineId, ["voided", "rejected", "corrected"], period.period_start, period.period_end], db);
  if (overlap) throw new DuplicateInvoiceError({ id: overlap.id, invoice_number: overlap.invoice_number, status: "overlapping" });

  const assignment = await activePoForPeriod(period.id, db);
  const calc = calculatePeriod(ctx, { ...period, usage: await periodUsage(db, period.id) });
  const company = await companySettings(db);
  const snapshot = buildSnapshot(ctx, company, assignment, period);
  const inv = await one(
    `INSERT INTO invoices(customer_id,contract_id,contract_line_id,billing_period_id,po_assignment_id,po_number,period_start,period_end,
       subtotal,taxable_amount,tax_rate,tax_amount,total,snapshot,calc_details,created_by,revision_of,revision_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [ctx.customer.id, ctx.contract.id, ctx.line.id, period.id, assignment?.id ?? null, assignment?.po_number ?? null, period.period_start, period.period_end,
     calc.subtotal, calc.taxable_amount, calc.tax_rate, calc.tax_amount, calc.total, JSON.stringify(snapshot), JSON.stringify(calc.calc), user.id,
     revisionOf?.id ?? null, revisionOf ? revisionOf.revision_no + 1 : 0], db);
  await writeLines(db, inv.id, calc.lines);
  // Attach the original rental agreement(s) automatically.
  await db.query(`INSERT INTO invoice_attachments(invoice_id,contract_document_id,attached_by)
                  SELECT $1, d.id, $2 FROM contract_documents d WHERE d.contract_id=$3 AND d.is_original_agreement ON CONFLICT DO NOTHING`, [inv.id, user.id, ctx.contract.id]);
  await history(db, inv.id, null, "draft", user.id, revisionOf ? `Revision of ${revisionOf.invoice_number}` : undefined);
  await audit(db, user.id, "generate", "invoice", inv.id, null, { unit: ctx.equipment.unit_number, period: [period.period_start, period.period_end], po: assignment?.po_number ?? null, total: calc.total });
  return inv;
}

export async function generateInvoice(user: SessionUser, lineId: string, periodRef: string) {
  requirePerm(user, "generate_invoice");
  return tx((db) => generateInTx(db, user, lineId, periodRef));
}

/** Generate drafts for every billable rental of a customer for one month. Each invoice is its own atomic transaction. */
export async function generateMonthForCustomer(user: SessionUser, customerId: string, month: string) {
  requirePerm(user, "generate_invoice");
  const lines = await q(`SELECT l.id, e.unit_number FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id JOIN equipment e ON e.id=l.equipment_id
                         WHERE c.customer_id=$1 AND l.status IN ('active','off_rent','returned') AND l.billing_start_date <= ($2::date + interval '1 month' - interval '1 day')
                           AND (l.off_rent_date IS NULL OR l.off_rent_date >= $2::date) ORDER BY e.unit_number`, [customerId, month]);
  const results: Array<{ unit: string; status: "created" | "exists" | "error"; invoiceId?: string; message?: string }> = [];
  for (const l of lines) {
    try {
      const inv = await tx((db) => generateInTx(db, user, l.id, month));
      results.push({ unit: l.unit_number, status: "created", invoiceId: inv.id });
    } catch (e: any) {
      if (e instanceof DuplicateInvoiceError) results.push({ unit: l.unit_number, status: "exists", invoiceId: e.existing.id });
      else results.push({ unit: l.unit_number, status: "error", message: e.message });
    }
  }
  return results;
}

async function lockInvoice(db: Db, id: string) {
  const inv = await one(`SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [id], db);
  if (!inv) throw new AppError("Invoice not found", "not_found");
  return inv;
}

/** Recompute a draft/rejected invoice from current rental + PO data. Never allowed after finalization. */
async function refreshInTx(db: Db, user: SessionUser, inv: any) {
  if (inv.finalized_at || !["draft", "rejected"].includes(inv.status)) throw new AppError("Only draft or rejected invoices can be recalculated.");
  const ctx = await loadLineContext(inv.contract_line_id, db);
  const period = await ensureBillingPeriod(db, ctx, inv.period_start);
  if (period.id !== inv.billing_period_id) throw new AppError("The rental's billable dates changed so this period no longer exists. Void this draft and generate a new one.");
  const assignment = await activePoForPeriod(period.id, db);
  const calc = calculatePeriod(ctx, { ...period, usage: await periodUsage(db, period.id) });
  const snapshot = buildSnapshot(ctx, await companySettings(db), assignment, period);
  const after = await one(
    `UPDATE invoices SET po_assignment_id=$2, po_number=$3, period_start=$4, period_end=$5, subtotal=$6, taxable_amount=$7, tax_rate=$8, tax_amount=$9, total=$10,
       snapshot=$11, calc_details=$12 WHERE id=$1 RETURNING *`,
    [inv.id, assignment?.id ?? null, assignment?.po_number ?? null, period.period_start, period.period_end, calc.subtotal, calc.taxable_amount, calc.tax_rate,
     calc.tax_amount, calc.total, JSON.stringify(snapshot), JSON.stringify(calc.calc)], db);
  await writeLines(db, inv.id, calc.lines);
  await db.query(`INSERT INTO invoice_attachments(invoice_id,contract_document_id,attached_by)
                  SELECT $1, d.id, $2 FROM contract_documents d WHERE d.contract_id=$3 AND d.is_original_agreement ON CONFLICT DO NOTHING`, [inv.id, user.id, ctx.contract.id]);
  return after;
}

export async function refreshInvoice(user: SessionUser, id: string) {
  requirePerm(user, "generate_invoice");
  return tx(async (db) => {
    const inv = await lockInvoice(db, id);
    const after = await refreshInTx(db, user, inv);
    if (inv.status === "rejected") {
      await db.query(`UPDATE invoices SET status='draft', rejection_reason=NULL WHERE id=$1`, [id]);
      await history(db, id, "rejected", "draft", user.id, "Reopened for correction");
    }
    await audit(db, user.id, "recalculate", "invoice", id, { po: inv.po_number, total: inv.total }, { po: after.po_number, total: after.total });
    return after;
  });
}

// ───────────────────────── Validation ─────────────────────────
export interface Check { rule: string; label: string; status: "pass" | "fail" | "warn" | "info"; message: string; overridable: boolean; override?: any }

export async function validateInvoice(id: string, db: Db = pool()): Promise<Check[]> {
  const inv = await one(`SELECT * FROM invoices WHERE id=$1`, [id], db);
  if (!inv) throw new AppError("Invoice not found", "not_found");
  const overrides = await q(`SELECT o.*, u.name AS user_name FROM invoice_overrides o JOIN users u ON u.id=o.user_id WHERE invoice_id=$1`, [id], db);
  const ov = (rule: string) => overrides.find((o) => o.rule === rule);
  const checks: Check[] = [];
  const add = (rule: string, label: string, status: Check["status"], message: string, overridable = true) =>
    checks.push({ rule, label, status, message, overridable, override: status === "fail" || status === "warn" ? ov(rule) : undefined });

  const ctx = await loadLineContext(inv.contract_line_id, db).catch(() => null);
  if (!ctx) { add("rental_exists", "Active rental exists", "fail", "The rental line for this invoice no longer exists.", false); return checks; }
  const p = ctx.profile;
  const snap = inv.snapshot;

  // 1. Rental exists and is billable
  const last = lastBillableDay(ctx.window);
  if (ctx.contract.status === "closed" && !(last && inv.period_end <= last)) add("rental_exists", "Active rental exists", "fail", `Rental ${ctx.contract.contract_number} is closed.`);
  else add("rental_exists", "Active rental exists", "pass", `Rental ${ctx.contract.contract_number} (${ctx.line.status.replace("_", "-")}), on rent since ${fmtDate(ctx.line.on_rent_date)}.`);

  // 2. Correct equipment
  const onSite = unitSegments(ctx, inv.period_start, inv.period_end);
  const expectedUnit = onSite.at(-1)?.equipment ?? ctx.equipment;
  const swapNote = onSite.length > 1 ? ` Exchanged during the period: ${onSite.map((g) => `${g.equipment.unit_number} ${fmtDate(g.from)}–${fmtDate(g.to)}`).join(", ")}.` : "";
  if (String(snap.equipment.id) !== String(expectedUnit.id)) {
    if (inv.finalized_at) add("equipment_match", "Correct equipment", "info", `Finalized showing unit ${snap.equipment.unit_number}. Unit ${expectedUnit.unit_number} was exchanged in afterwards; the amount is unchanged and the next invoice shows the new unit.`, false);
    else add("equipment_match", "Correct equipment", "fail", `Invoice shows unit ${snap.equipment.unit_number} but unit ${expectedUnit.unit_number} is on this rental for these dates. Recalculate the invoice.`, false);
  } else add("equipment_match", "Correct equipment", "pass", `Unit ${snap.equipment.unit_number}${snap.equipment.serial_number ? `, serial ${snap.equipment.serial_number}` : ""}.${swapNote}`);

  // 3. Billing period
  const bp = billedPeriodFor(ctx.window, inv.period_start);
  if (!bp || bp.start !== inv.period_start || bp.end !== inv.period_end)
    add("billing_period", "Billing period is accurate", "fail", `Expected ${bp ? `${fmtDate(bp.start)} – ${fmtDate(bp.end)}` : "no billable period"} but invoice covers ${fmtDate(inv.period_start)} – ${fmtDate(inv.period_end)}.`, false);
  else add("billing_period", "Billing period is accurate", "pass", `${fmtDate(inv.period_start)} – ${fmtDate(inv.period_end)} (${BILLING_METHOD_LABELS[ctx.method]}).`);

  // 4–7. PO checks
  const active = await activePoForPeriod(inv.billing_period_id, db);
  const poRequired = p.require_monthly_po || p.invoice_level_po;
  if (!inv.po_number) {
    add("po_present", "Valid PO for this billing period", poRequired ? "fail" : "info",
      poRequired ? `No purchase order is assigned to unit ${snap.equipment.unit_number} for ${fmtDate(inv.period_start)} – ${fmtDate(inv.period_end)}. ${ctx.customer.name} requires a new PO every month. Assign or import this month's PO, then recalculate the invoice.` : "No PO on this invoice (not required for this customer).");
  } else {
    const fmt = validatePoFormat(inv.po_number, p);
    if (!fmt.ok) add("po_format", "PO format", "fail", fmt.message);
    else add("po_format", "PO format", "pass", `PO ${inv.po_number}${p.po_pattern_description ? ` matches: ${p.po_pattern_description}` : ""}.`);
    if (!active || active.po_number !== inv.po_number) {
      add("po_current", "PO matches current assignment", inv.finalized_at ? "info" : "fail",
        inv.finalized_at ? `Invoice was finalized with PO ${inv.po_number}; the period's current PO assignment is ${active?.po_number ?? "none"}. Finalized invoices keep their original PO.`
          : `The PO assigned to this period is now ${active?.po_number ?? "none"}, but this draft shows ${inv.po_number}. Recalculate the invoice.`, false);
    } else {
      const po = await one(`SELECT * FROM purchase_orders WHERE po_number=$1 AND customer_id=$2`, [inv.po_number, inv.customer_id], db);
      const problems: string[] = [];
      if (po.valid_from && inv.period_start < po.valid_from) problems.push(`PO is only valid from ${fmtDate(po.valid_from)}`);
      if (po.valid_to && inv.period_end > po.valid_to) problems.push(`PO is only valid through ${fmtDate(po.valid_to)}`);
      if (po.expires_on && po.expires_on < (inv.invoice_date ?? todayCentral())) problems.push(`PO expired on ${fmtDate(po.expires_on)}`);
      if (problems.length) add("po_validity", "PO valid for this period", "fail", problems.join("; ") + ".");
      else add("po_validity", "PO valid for this period", "pass", "PO dates cover this billing period.");
    }
  }

  // 8. Job / work order / jobsite
  const jobProblems: string[] = [];
  if (p.require_job_number && !snap.job_number) jobProblems.push("Job number is required");
  if (p.require_work_order && !snap.work_order_number) jobProblems.push("Work order is required");
  if (p.require_jobsite_address && !snap.jobsite?.address) jobProblems.push("Jobsite address is required");
  if (jobProblems.length) add("job_work_order", "Job and work order", "fail", jobProblems.join("; ") + ".");
  else {
    const diffs: string[] = [];
    if (snap.job_number && ctx.contract.job_number && snap.job_number !== ctx.contract.job_number) diffs.push(`job ${snap.job_number} (PO) vs ${ctx.contract.job_number} (rental)`);
    if (snap.work_order_number && ctx.contract.work_order_number && snap.work_order_number !== ctx.contract.work_order_number) diffs.push(`work order ${snap.work_order_number} (PO) vs ${ctx.contract.work_order_number} (rental)`);
    if (diffs.length) add("job_work_order", "Job and work order", "warn", `Customer's PO references differ from the rental: ${diffs.join("; ")}. The invoice uses the PO's values. Approve the difference to continue.`);
    else add("job_work_order", "Job and work order", "pass", `Job ${snap.job_number ?? "—"}, work order ${snap.work_order_number ?? "—"}.`);
  }

  // 9. Amount recalculation
  if (!inv.finalized_at) {
    try {
      const calc = calculatePeriod(ctx, { period_start: inv.period_start, period_end: inv.period_end, usage: await periodUsage(db, inv.billing_period_id) });
      const lines = await q(`SELECT amount FROM invoice_lines WHERE invoice_id=$1`, [id], db);
      const lineSum = lines.reduce((s, l) => s.add(l.amount), new D(0));
      if (calc.total !== inv.total || !lineSum.eq(inv.subtotal)) add("amount", "Amount calculated correctly", "fail", `Recalculated total is ${calc.total} but invoice shows ${inv.total}. Recalculate the invoice.`, false);
      else add("amount", "Amount calculated correctly", "pass", `Subtotal ${inv.subtotal} + tax ${inv.tax_amount} = ${inv.total}.`);
    } catch (e: any) {
      add("amount", "Amount calculated correctly", "fail", e.message, false);
    }
  } else add("amount", "Amount calculated correctly", "pass", `Frozen at finalization: ${inv.total}.`);

  // 10. Duplicates / overlaps
  const dup = await q(`SELECT id, invoice_number FROM invoices WHERE contract_line_id=$1 AND id<>$2 AND status <> ALL($3)
                       AND daterange(period_start,period_end,'[]') && daterange($4::date,$5::date,'[]')`, [inv.contract_line_id, id, ["voided", "rejected", "corrected"], inv.period_start, inv.period_end], db);
  if (dup.length) add("duplicates", "No duplicate or overlapping charges", "fail", `Overlaps invoice ${dup.map((d) => d.invoice_number ?? `#${d.id}`).join(", ")}.`, false);
  else add("duplicates", "No duplicate or overlapping charges", "pass", "No other invoice covers these dates for this unit.");

  // 11. Attachments
  const atts = await q(`SELECT d.filename FROM invoice_attachments a JOIN contract_documents d ON d.id=a.contract_document_id WHERE a.invoice_id=$1 AND d.is_original_agreement`, [id], db);
  if (p.require_contract_attachment && !atts.length) add("attachment", "Original rental agreement attached", "fail", `Upload the original rental agreement for ${ctx.contract.contract_number} on the rental page, then recalculate.`);
  else add("attachment", "Original rental agreement attached", atts.length ? "pass" : "info", atts.length ? `Attached: ${atts.map((a) => a.filename).join(", ")}.` : "No attachment required.");

  // 12. PO value reconciliation
  const rec = reconcile(inv, p);
  if (rec) {
    if (!rec.within) add("po_variance", "Invoice total vs PO estimate", "warn", `Invoice total ${rec.total} differs from RPM's PO estimate ${rec.poTotal} by ${rec.variance} (${rec.pct}%), outside tolerance of ${rec.tolerance}. Rates were not changed. Approve the variance with a reason to continue.`);
    else add("po_variance", "Invoice total vs PO estimate", rec.variance === "0.00" ? "pass" : "info", `Variance ${rec.variance} (${rec.pct}%) is within tolerance ${rec.tolerance}.`);
  }

  // 13. Hour meter readings (extra hours) and fuel
  const ot = inv.calc_details?.overtime as OvertimeResult | null | undefined;
  if (inv.finalized_at) {
    if (ot?.status === "ok") add("hour_meter", "Hour meter readings", "info", `Frozen at finalization: ${ot.explanation}.`, false);
  } else if (p.overtime_enabled) {
    const units = onSite.map((g) => g.equipment.unit_number).join(" and ");
    if (!ot || ot.status === "missing")
      add("hour_meter", "Hour meter readings", "fail", `${ctx.customer.name} is billed for extra hours, but the start and end hour meter readings for unit ${units} aren't entered. Enter them on this invoice, or approve the exception to bill without extra hours.`);
    else if (ot.status === "invalid")
      add("hour_meter", "Hour meter readings", "fail", `The end reading is lower than the start reading for unit ${ot.units.join(", ")}. Correct the readings.`, false);
    else if (ot.status === "partial")
      add("hour_meter", "Hour meter readings", "warn", "This is a partial billing period, so extra hours aren't calculated automatically. Approve the exception to bill without them, or add them as an adjustment.");
    else add("hour_meter", "Hour meter readings", "pass", `${ot.explanation}${dec(ot.amount).gt(0) ? ` = ${ot.amount}` : " (none billed)"}.`);
  }
  if (!inv.finalized_at && inv.calc_details?.fuel_unpriced)
    add("fuel_price", "Fuel price", "warn", "Fuel gallons were entered but no fuel price per gallon is set for this customer, so fuel isn't billed. Set the price on the customer page and recalculate, or approve the exception.");

  // 13b. Damage waiver vs certificate of insurance
  const rdw = inv.calc_details?.rdw as RdwDecision | undefined;
  if (rdw?.status === "waived_coi")
    add("damage_waiver", "Damage waiver", "info", `Not billed: ${rdw.coi.insurer} certificate${rdw.coi.policy_number ? ` (policy ${rdw.coi.policy_number})` : ""} covers this period, valid through ${fmtDate(rdw.coi.expires_on)}.`, false);
  else if (rdw?.status === "billed" && rdw.reason !== "rdw")
    add("damage_waiver", "Damage waiver", "info", rdw.reason === "no_coi"
      ? `Billed: ${ctx.customer.name} is set to use their own insurance, but no certificate is on file. Upload one on the customer page and recalculate to remove the waiver.`
      : `Billed: ${ctx.customer.name}'s certificate on file (valid ${fmtDate(rdw.latest!.effective_on)} to ${fmtDate(rdw.latest!.expires_on)}) doesn't cover this whole period. Upload a current certificate and recalculate to remove the waiver.`, false);
  else if (rdw?.status === "waived_line")
    add("damage_waiver", "Damage waiver", "info", "Not billed: waived on this rental.", false);

  // 13c. Equipment fees and taxes with no rate for this period
  const noRate = ((inv.calc_details?.fees ?? []) as Array<{ code: string; name: string; status: string }>).filter((f) => f.status === "no_rate");
  if (!inv.finalized_at && noRate.length)
    add("fee_rate", "Equipment fee rates", "warn", `${noRate.map((f) => `${f.name} (${f.code})`).join(", ")} applies to this unit but has no rate in effect for this period, so it isn't billed. Add the rate under Settings → Fees and taxes and recalculate, or approve the exception.`);

  // 14. Placeholders
  if (snap.company?.is_placeholder || snap.tax?.is_placeholder)
    add("placeholders", "Company and tax details confirmed", "warn", "The invoice still uses placeholder company information or a placeholder tax rate. Confirm them in Settings, or approve the exception.");
  return checks;
}

export function reconcile(inv: any, profile: any) {
  const est = inv.snapshot?.po?.estimated_total;
  if (est == null) return null;
  const total = dec(inv.total), poTotal = dec(est);
  const variance = total.sub(poTotal);
  const pct = poTotal.isZero() ? new D(0) : variance.div(poTotal).mul(100);
  const tolAmt = D.max(dec(profile.po_variance_tolerance_amount), poTotal.mul(dec(profile.po_variance_tolerance_pct)).div(100));
  return {
    poTotal: money(poTotal), subtotal: money(inv.subtotal), tax: money(inv.tax_amount), total: money(total),
    variance: money(variance), pct: pct.toDecimalPlaces(2).toFixed(2), tolerance: money(tolAmt), within: variance.abs().lte(cents(tolAmt)),
  };
}

export function blockingChecks(checks: Check[]) {
  return checks.filter((c) => (c.status === "fail" || c.status === "warn") && !c.override);
}

export async function overrideCheck(user: SessionUser, invoiceId: string, rule: string, reason: string) {
  requirePerm(user, "override_validation");
  if (!reason || reason.trim().length < 5) throw new AppError("Enter a reason for the override (at least 5 characters).");
  return tx(async (db) => {
    const inv = await lockInvoice(db, invoiceId);
    if (inv.finalized_at) throw new AppError("This invoice is already finalized.");
    const checks = await validateInvoice(invoiceId, db);
    const c = checks.find((x) => x.rule === rule);
    if (!c || (c.status !== "fail" && c.status !== "warn")) throw new AppError("That check is not failing.");
    if (!c.overridable) throw new AppError(`"${c.label}" protects data integrity and cannot be overridden. Fix the underlying problem instead.`);
    await db.query(`INSERT INTO invoice_overrides(invoice_id,rule,message,reason,user_id) VALUES ($1,$2,$3,$4,$5)
                    ON CONFLICT (invoice_id, rule) DO UPDATE SET message=EXCLUDED.message, reason=EXCLUDED.reason, user_id=EXCLUDED.user_id, at=now()`,
      [invoiceId, rule, c.message, reason.trim(), user.id]);
    await audit(db, user.id, "override", "invoice", invoiceId, null, { rule, message: c.message }, reason);
  });
}

// ───────────────────────── Workflow ─────────────────────────
export async function submitForReview(user: SessionUser, id: string) {
  requirePerm(user, "submit_invoice");
  return tx(async (db) => {
    const inv = await lockInvoice(db, id);
    if (inv.status !== "draft") throw new AppError(`Only drafts can be submitted (this invoice is ${STATUS_LABELS[inv.status]}).`);
    await refreshInTx(db, user, inv);
    await db.query(`UPDATE invoices SET status='pending_review', submitted_by=$2, submitted_at=now() WHERE id=$1`, [id, user.id]);
    await history(db, id, "draft", "pending_review", user.id);
    await audit(db, user.id, "submit", "invoice", id, null, null);
  });
}

export async function rejectInvoice(user: SessionUser, id: string, reason: string) {
  requirePerm(user, "approve_invoice");
  if (!reason || reason.trim().length < 3) throw new AppError("Enter a rejection reason.");
  return tx(async (db) => {
    const inv = await lockInvoice(db, id);
    if (inv.status !== "pending_review") throw new AppError("Only invoices pending review can be rejected.");
    await db.query(`UPDATE invoices SET status='rejected', rejection_reason=$2 WHERE id=$1`, [id, reason]);
    await history(db, id, "pending_review", "rejected", user.id, reason);
    await audit(db, user.id, "reject", "invoice", id, null, null, reason);
  });
}

async function nextInvoiceNumber(db: Db, inv: any) {
  if (inv.revision_of) {
    let root = await one(`SELECT * FROM invoices WHERE id=$1`, [inv.revision_of], db);
    while (root.revision_of) root = await one(`SELECT * FROM invoices WHERE id=$1`, [root.revision_of], db);
    return `${root.invoice_number}-R${inv.revision_no}`;
  }
  const s = await one(`SELECT invoice_prefix, next_invoice_number FROM company_settings WHERE id=1 FOR UPDATE`, [], db);
  await db.query(`UPDATE company_settings SET next_invoice_number = next_invoice_number + 1 WHERE id=1`);
  return `${s.invoice_prefix}${s.next_invoice_number}`;
}

/** Approve = finalize. Validations must pass (or be overridden by an authorized user). Freezes period, PO, money and the PDF. */
export async function approveInvoice(user: SessionUser, id: string, opts: { invoiceNumber?: string | null } = {}) {
  const manual = opts.invoiceNumber?.trim() || null;
  if (manual && !/^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/.test(manual)) throw new AppError("Invoice numbers may contain letters, digits and dashes (max 40).");
  requirePerm(user, "approve_invoice");
  return tx(async (db) => {
    const inv = await lockInvoice(db, id);
    if (inv.status !== "pending_review") throw new AppError("Only invoices pending review can be approved.");
    if (inv.submitted_by && String(inv.submitted_by) === String(user.id) && user.role !== "admin")
      throw new AppError("A different employee must approve an invoice than the one who submitted it.");
    const checks = await validateInvoice(id, db);
    const blocking = blockingChecks(checks);
    if (blocking.length) throw new AppError(`Cannot approve: ${blocking.map((c) => `${c.label}: ${c.message}`).join(" | ")}`, "validation_failed", blocking);

    if (manual && (await one(`SELECT 1 FROM invoices WHERE invoice_number=$1`, [manual], db))) throw new AppError(`Invoice number ${manual} is already used.`);
    const number = manual ?? (await nextInvoiceNumber(db, inv));
    const invoiceDate = todayCentral();
    const days = Number(inv.snapshot.terms.days ?? 30);
    const due = addDays(invoiceDate, days);
    // Mark one-time fees as billed by this invoice.
    const ctx = await loadLineContext(inv.contract_line_id, db);
    const calc = calculatePeriod(ctx, inv);
    for (const fid of calc.oneTimeFeeIds) await db.query(`UPDATE contract_line_fees SET billed_on_invoice_id=$2 WHERE id=$1 AND billed_on_invoice_id IS NULL`, [fid, id]);

    const staged = await one(`UPDATE invoices SET invoice_number=$2, invoice_date=$3, due_date=$4 WHERE id=$1 RETURNING *`, [id, number, invoiceDate, due], db);
    const lines = await q(`SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no`, [id], db);
    const attachments = await attachmentFiles(db, id);
    const pdf = await renderInvoicePdf({ invoice: staged, lines, attachments, draft: false });
    const sha = createHash("sha256").update(pdf).digest("hex");
    await db.query(`INSERT INTO invoice_documents(invoice_id,pdf,sha256) VALUES ($1,$2,$3)`, [id, Buffer.from(pdf), sha]);
    await db.query(`UPDATE invoices SET status='approved', approved_by=$2, approved_at=now(), finalized_at=now(), pdf_sha256=$3 WHERE id=$1`, [id, user.id, sha]);
    if (inv.revision_of) {
      await history(db, inv.revision_of, null, "corrected", user.id, `Superseded by ${number}`);
    }
    await history(db, id, "pending_review", "approved", user.id, `Finalized as ${number}`);
    await audit(db, user.id, "approve", "invoice", id, null, { invoice_number: number, po: inv.po_number, total: inv.total, pdf_sha256: sha });
    return { invoice_number: number, pdf_sha256: sha };
  });
}

export async function issueInvoice(user: SessionUser, id: string) {
  requirePerm(user, "issue_invoice");
  return tx(async (db) => {
    const inv = await lockInvoice(db, id);
    if (inv.status !== "approved") throw new AppError("Only approved invoices can be issued.");
    await db.query(`UPDATE invoices SET status='issued', issued_by=$2, issued_at=now() WHERE id=$1`, [id, user.id]);
    await history(db, id, "approved", "issued", user.id);
    await audit(db, user.id, "issue", "invoice", id, null, { invoice_number: inv.invoice_number });
  });
}

export async function voidInvoice(user: SessionUser, id: string, reason: string) {
  requirePerm(user, "void_invoice");
  if (!reason || reason.trim().length < 5) throw new AppError("Enter a reason for voiding.");
  return tx(async (db) => {
    const inv = await lockInvoice(db, id);
    if (["voided", "corrected", "paid", "partially_paid"].includes(inv.status)) throw new AppError(`A ${STATUS_LABELS[inv.status]} invoice cannot be voided${dec(inv.amount_paid).gt(0) ? " because payments were recorded against it; issue a credit instead" : ""}.`);
    if (dec(inv.amount_paid).gt(0)) throw new AppError("Payments were recorded against this invoice; issue a credit instead of voiding.");
    if (dec(inv.amount_credited).gt(0)) throw new AppError("Credits were issued against this invoice, so it can't be voided. Issue another credit instead.");
    if (!inv.finalized_at) {
      await db.query(`UPDATE invoices SET status='voided', voided_by=$2, voided_at=now(), void_reason=$3 WHERE id=$1`, [id, user.id, reason]);
    } else {
      await db.query(`UPDATE invoices SET status='voided', voided_by=$2, voided_at=now(), void_reason=$3 WHERE id=$1`, [id, user.id, reason]);
      await db.query(`UPDATE contract_line_fees SET billed_on_invoice_id=NULL WHERE billed_on_invoice_id=$1`, [id]);
    }
    await history(db, id, inv.status, "voided", user.id, reason);
    await audit(db, user.id, "void", "invoice", id, { status: inv.status }, { status: "voided" }, reason);
  });
}

/** Correction workflow for a finalized invoice: the original is kept unchanged (status "corrected" once the revision is approved) and a new revision draft is created from current data. */
export async function reviseInvoice(user: SessionUser, id: string, reason: string) {
  requirePerm(user, "void_invoice");
  if (!reason || reason.trim().length < 5) throw new AppError("Enter the reason for the correction.");
  return tx(async (db) => {
    const inv = await lockInvoice(db, id);
    if (!inv.finalized_at || !["approved", "issued", "overdue"].includes(inv.status)) throw new AppError("Only approved, issued or overdue invoices can be revised.");
    if (dec(inv.amount_paid).gt(0) || dec(inv.amount_credited).gt(0)) throw new AppError("Payments or credits were recorded against this invoice; issue a credit and bill the difference instead.");
    await db.query(`UPDATE invoices SET status='corrected' WHERE id=$1`, [id]);
    await db.query(`UPDATE contract_line_fees SET billed_on_invoice_id=NULL WHERE billed_on_invoice_id=$1`, [id]);
    await history(db, id, inv.status, "corrected", user.id, reason);
    const rev = await generateInTx(db, user, inv.contract_line_id, inv.period_start, inv);
    await audit(db, user.id, "revise", "invoice", id, { invoice_number: inv.invoice_number, po: inv.po_number, total: inv.total }, { revision_id: rev.id, po: rev.po_number, total: rev.total }, reason);
    return rev;
  });
}

export async function recordPayment(user: SessionUser, id: string, input: { amount: string; paid_on: string; method?: string; reference?: string }) {
  requirePerm(user, "record_payment");
  const amt = dec(input.amount);
  if (!/^\d+(\.\d{1,2})?$/.test(String(input.amount).trim()) || amt.lte(0)) throw new AppError("Enter a positive payment amount.");
  return tx(async (db) => {
    const inv = await lockInvoice(db, id);
    if (!["issued", "overdue", "partially_paid"].includes(inv.status)) throw new AppError("Payments can only be recorded on issued invoices.");
    const balance = dec(inv.total).sub(inv.amount_paid).sub(dec(inv.amount_credited));
    if (amt.gt(balance)) throw new AppError(`Payment exceeds the balance due (${money(balance)}).`);
    await db.query(`INSERT INTO payments(invoice_id,amount,paid_on,method,reference,recorded_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, money(amt), input.paid_on, input.method ?? null, input.reference ?? null, user.id]);
    const paid = dec(inv.amount_paid).add(amt);
    const status = paid.add(dec(inv.amount_credited)).gte(inv.total) ? "paid" : "partially_paid";
    await db.query(`UPDATE invoices SET amount_paid=$2, status=$3 WHERE id=$1`, [id, money(paid), status]);
    await history(db, id, inv.status, status, user.id, `Payment ${money(amt)}`);
    await audit(db, user.id, "payment", "invoice", id, { amount_paid: inv.amount_paid }, { amount_paid: money(paid) });
  });
}

export async function refreshOverdue(db: Db = pool()) {
  const rows = await q(`UPDATE invoices SET status='overdue' WHERE status IN ('issued') AND due_date < $1 RETURNING id`, [todayCentral()], db);
  for (const r of rows) await history(db, r.id, "issued", "overdue", null, "Past due date");
  return rows.length;
}

// ───────────────────────── Documents ─────────────────────────
async function attachmentFiles(db: Db, invoiceId: string) {
  return q(`SELECT d.id, d.filename, d.mime_type, d.content FROM invoice_attachments a JOIN contract_documents d ON d.id=a.contract_document_id WHERE a.invoice_id=$1 ORDER BY d.id`, [invoiceId], db);
}

/** Finalized invoices return their stored, never-regenerated PDF. Drafts are rendered live with a DRAFT watermark. */
export async function invoicePdf(id: string, db: Db = pool()): Promise<{ pdf: Buffer; filename: string; finalized: boolean; sha256: string }> {
  const inv = await one(`SELECT * FROM invoices WHERE id=$1`, [id], db);
  if (!inv) throw new AppError("Invoice not found", "not_found");
  if (inv.finalized_at) {
    const doc = await one(`SELECT pdf, sha256 FROM invoice_documents WHERE invoice_id=$1`, [id], db);
    const sha = createHash("sha256").update(doc.pdf).digest("hex");
    if (sha !== doc.sha256 || sha !== inv.pdf_sha256) throw new AppError("Stored PDF failed its integrity check. Contact an administrator.", "integrity");
    return { pdf: doc.pdf, filename: `${inv.invoice_number}.pdf`, finalized: true, sha256: sha };
  }
  const lines = await q(`SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no`, [id], db);
  const pdf = Buffer.from(await renderInvoicePdf({ invoice: inv, lines, attachments: await attachmentFiles(db, id), draft: true }));
  return { pdf, filename: `DRAFT-${inv.snapshot.equipment.unit_number}-${inv.period_start}.pdf`, finalized: false, sha256: createHash("sha256").update(pdf).digest("hex") };
}

export async function invoiceDetail(id: string, db: Db = pool()) {
  const inv = await one(`SELECT i.*, ua.name AS approved_by_name, us.name AS submitted_by_name, uc.name AS created_by_name
                         FROM invoices i LEFT JOIN users ua ON ua.id=i.approved_by LEFT JOIN users us ON us.id=i.submitted_by LEFT JOIN users uc ON uc.id=i.created_by WHERE i.id=$1`, [id], db);
  if (!inv) return null;
  const [lines, attachments, hist, payments, profile, revisions] = await Promise.all([
    q(`SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no`, [id], db),
    q(`SELECT d.id, d.filename, d.mime_type, d.uploaded_at FROM invoice_attachments a JOIN contract_documents d ON d.id=a.contract_document_id WHERE a.invoice_id=$1`, [id], db),
    q(`SELECT h.*, u.name AS user_name FROM invoice_status_history h LEFT JOIN users u ON u.id=h.user_id WHERE invoice_id=$1 ORDER BY h.at, h.id`, [id], db),
    q(`SELECT * FROM payments WHERE invoice_id=$1 ORDER BY paid_on`, [id], db),
    one(`SELECT * FROM customer_billing_profiles WHERE customer_id=$1`, [inv.customer_id], db),
    q(`SELECT id, invoice_number, status, revision_no FROM invoices WHERE revision_of=$1 OR id=$2 ORDER BY revision_no`, [id, inv.revision_of ?? 0], db),
  ]);
  const checks = await validateInvoice(id, db);
  return { inv, lines, attachments, history: hist, payments, checks, reconciliation: reconcile(inv, profile), revisions, profile };
}
