// Hour meter readings, fuel, and the per-customer settings for extra-hours and add-on charges.
// Readings are entered on a draft invoice, one row per unit on site during the period, and the
// invoice is recalculated. They lock once the invoice is approved.
import { z } from "zod";
import { AppError, audit, one, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { dec } from "../money";
import { addDays } from "../dates";
import { loadLineContext, unitSegments } from "./records";
import { logEvent } from "./inventory";
import { refreshInvoice } from "./invoices";

const hoursStr = z.union([z.literal(""), z.string().trim().regex(/^\d{1,7}(\.\d)?$/, "Enter hours like 1234.5")]).optional().nullable()
  .transform((v) => (v ? v : null));

export interface UsageFormRow {
  equipment_id: string; unit_number: string; description: string; from: string; to: string;
  start_hours: string | null; end_hours: string | null; fuel_gallons: string;
  saved: boolean; start_hint: string | null; start_source: string | null; end_hint: string | null; end_source: string | null;
}

/** The units on site for an invoice's period, with saved readings or suggestions for blank ones. */
export async function usageForm(invoiceId: string): Promise<UsageFormRow[]> {
  const inv = await one(`SELECT id, contract_line_id, billing_period_id, period_start, period_end FROM invoices WHERE id=$1`, [invoiceId]);
  if (!inv) throw new AppError("Invoice not found", "not_found");
  const ctx = await loadLineContext(inv.contract_line_id);
  const saved = await q(`SELECT * FROM period_usage WHERE billing_period_id=$1`, [inv.billing_period_id]);
  const exchanges = await q(`SELECT exchange_date, out_equipment_id, in_equipment_id, out_hours, in_hours FROM equipment_exchanges WHERE contract_line_id=$1`, [inv.contract_line_id]);
  const out: UsageFormRow[] = [];
  for (const g of unitSegments(ctx, inv.period_start, inv.period_end)) {
    const eid = String(g.equipment.id);
    const row = saved.find((r) => String(r.equipment_id) === eid);
    let start_hint: string | null = null, start_source: string | null = null, end_hint: string | null = null, end_source: string | null = null;
    const exIn = exchanges.find((e) => String(e.in_equipment_id) === eid && e.exchange_date === g.from);
    const exOut = exchanges.find((e) => String(e.out_equipment_id) === eid && e.exchange_date === addDays(g.to, 1));
    if (exIn?.in_hours != null) { start_hint = exIn.in_hours; start_source = "reading when exchanged in"; }
    else {
      const prev = await one(`SELECT u.end_hours FROM period_usage u JOIN billing_periods b ON b.id=u.billing_period_id
                              WHERE u.contract_line_id=$1 AND u.equipment_id=$2 AND b.period_end < $3 AND u.end_hours IS NOT NULL ORDER BY b.period_end DESC LIMIT 1`,
        [inv.contract_line_id, eid, g.from]);
      if (prev) { start_hint = prev.end_hours; start_source = "last period's end reading"; }
      else {
        const ev = await one(`SELECT hours FROM equipment_events WHERE equipment_id=$1 AND hours IS NOT NULL AND event_date <= $2 ORDER BY event_date DESC, id DESC LIMIT 1`, [eid, g.from]);
        if (ev) { start_hint = ev.hours; start_source = "unit's latest hour meter reading"; }
      }
    }
    if (exOut?.out_hours != null) { end_hint = exOut.out_hours; end_source = "reading when exchanged out"; }
    out.push({
      equipment_id: eid, unit_number: g.equipment.unit_number, description: g.equipment.description, from: g.from, to: g.to,
      start_hours: row?.start_hours ?? null, end_hours: row?.end_hours ?? null, fuel_gallons: row?.fuel_gallons ?? "0.0",
      saved: !!row, start_hint, start_source, end_hint, end_source,
    });
  }
  return out;
}

const usageInput = z.array(z.object({
  equipment_id: z.coerce.string().regex(/^\d+$/),
  start_hours: hoursStr,
  end_hours: hoursStr,
  fuel_gallons: hoursStr,
}));

/** Save the period's hour meter readings and fuel, then recalculate the draft invoice. */
export async function saveUsage(user: SessionUser, invoiceId: string, input: unknown) {
  requirePerm(user, "generate_invoice");
  const rows = usageInput.parse(input);
  await tx(async (db) => {
    const inv = await one(`SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [invoiceId], db);
    if (!inv) throw new AppError("Invoice not found", "not_found");
    if (inv.finalized_at || !["draft", "rejected"].includes(inv.status))
      throw new AppError("Hour meter readings can only be changed while the invoice is a draft. Send it back to draft first.");
    const ctx = await loadLineContext(inv.contract_line_id, db);
    const segs = unitSegments(ctx, inv.period_start, inv.period_end);
    for (const r of rows) {
      const seg = segs.find((g) => String(g.equipment.id) === r.equipment_id);
      if (!seg) throw new AppError("That unit wasn't on this rental during the billing period.");
      if (r.start_hours && r.end_hours && dec(r.end_hours).lt(r.start_hours))
        throw new AppError(`Unit ${seg.equipment.unit_number}: the end reading (${r.end_hours}) is lower than the start reading (${r.start_hours}).`);
      const before = await one(`SELECT * FROM period_usage WHERE billing_period_id=$1 AND equipment_id=$2`, [inv.billing_period_id, r.equipment_id], db);
      const after = await one(
        `INSERT INTO period_usage(billing_period_id,contract_line_id,equipment_id,start_hours,end_hours,fuel_gallons,updated_by,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (billing_period_id, equipment_id) DO UPDATE SET start_hours=EXCLUDED.start_hours, end_hours=EXCLUDED.end_hours,
           fuel_gallons=EXCLUDED.fuel_gallons, updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING *`,
        [inv.billing_period_id, inv.contract_line_id, r.equipment_id, r.start_hours, r.end_hours, r.fuel_gallons ?? "0", user.id], db);
      const changed = !before || String(before.start_hours) !== String(after.start_hours) || String(before.end_hours) !== String(after.end_hours) || String(before.fuel_gallons) !== String(after.fuel_gallons);
      if (!changed) continue;
      await audit(db, user.id, "usage", "invoice", invoiceId, before, after);
      // Keep the unit's hour meter history current.
      if (after.end_hours != null && String(before?.end_hours) !== String(after.end_hours)) {
        await logEvent(db, { equipmentId: r.equipment_id, kind: "hours", date: seg.to, hours: after.end_hours, note: `End-of-period reading for invoice period ${seg.from} to ${seg.to}`, lineId: inv.contract_line_id, userId: user.id });
        await db.query(`UPDATE equipment SET hour_meter=$2 WHERE id=$1 AND (hour_meter IS NULL OR hour_meter < $2)`, [r.equipment_id, after.end_hours]);
      }
    }
  });
  return refreshInvoice(user, invoiceId);
}

// ───────────────────────── Customer settings ─────────────────────────
const pct = z.union([z.literal(""), z.string().trim().regex(/^\d{1,2}(\.\d{1,2})?$/, "Enter a percent like 15 or 2.5")]).optional().nullable()
  .transform((v) => (v && dec(v).gt(0) ? dec(v).div(100).toFixed(4) : null));
const positive = (label: string, re: RegExp) => z.string().trim().regex(re, label).refine((v) => dec(v).gt(0), label);

export const usageSettingsSchema = z.object({
  overtime_enabled: z.boolean(),
  hours_per_day: positive("Hours per day must be more than 0", /^\d{1,3}(\.\d)?$/),
  hours_per_week: positive("Hours per week must be more than 0", /^\d{1,3}(\.\d)?$/),
  hours_per_month: positive("Hours per month must be more than 0", /^\d{1,4}(\.\d)?$/),
  overtime_multiplier: positive("Enter the multiplier like 1.5", /^\d(\.\d{1,3})?$/),
  damage_waiver_pct: pct,
  environmental_pct: pct,
  fuel_price_per_gallon: z.union([z.literal(""), z.string().trim().regex(/^\d{1,4}(\.\d{1,4})?$/, "Enter the fuel price like 4.25")]).optional().nullable()
    .transform((v) => (v && dec(v).gt(0) ? v : null)),
});

/** Turn extra-hours billing and add-on charges on or off for a customer. Applies to invoices generated or recalculated afterwards. */
export async function updateUsageSettings(user: SessionUser, customerId: string, input: unknown) {
  requirePerm(user, "configure_billing");
  const s = usageSettingsSchema.parse(input);
  return tx(async (db) => {
    const before = await one(`SELECT overtime_enabled, hours_per_day, hours_per_week, hours_per_month, overtime_multiplier, damage_waiver_pct, environmental_pct, fuel_price_per_gallon
                              FROM customer_billing_profiles WHERE customer_id=$1 FOR UPDATE`, [customerId], db);
    if (!before) throw new AppError("Billing profile not found", "not_found");
    const after = await one(
      `UPDATE customer_billing_profiles SET overtime_enabled=$2, hours_per_day=$3, hours_per_week=$4, hours_per_month=$5, overtime_multiplier=$6,
         damage_waiver_pct=$7, environmental_pct=$8, fuel_price_per_gallon=$9, updated_at=now() WHERE customer_id=$1
       RETURNING overtime_enabled, hours_per_day, hours_per_week, hours_per_month, overtime_multiplier, damage_waiver_pct, environmental_pct, fuel_price_per_gallon`,
      [customerId, s.overtime_enabled, s.hours_per_day, s.hours_per_week, s.hours_per_month, s.overtime_multiplier, s.damage_waiver_pct, s.environmental_pct, s.fuel_price_per_gallon], db);
    await audit(db, user.id, "update", "usage_charges", customerId, before, after);
    return after;
  });
}

/** Excuse one rental from the damage waiver (e.g. the customer sent its own insurance certificate). */
export async function setDamageWaiverWaived(user: SessionUser, lineId: string, waived: boolean, reason: string) {
  requirePerm(user, "edit_records");
  if (waived && String(reason ?? "").trim().length < 5) throw new AppError("Enter why the damage waiver is waived (for example, the insurance certificate on file).");
  return tx(async (db) => {
    const before = await one(`SELECT id, damage_waiver_waived FROM rental_contract_lines WHERE id=$1 FOR UPDATE`, [lineId], db);
    if (!before) throw new AppError("Rental line not found", "not_found");
    await db.query(`UPDATE rental_contract_lines SET damage_waiver_waived=$2 WHERE id=$1`, [lineId, waived]);
    await audit(db, user.id, "update", "damage_waiver", lineId, before, { damage_waiver_waived: waived }, reason?.trim() || undefined);
  });
}

