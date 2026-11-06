// Equipment sales: sell a unit from inventory to a customer on a numbered invoice.
// Draft → finalized (numbered, PDF stored and fingerprinted, unit marked sold) → paid, or voided.
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { activeTaxExemptions, exemptionLabel, taxExemptionFor } from "./tax-exempt";
import { SessionUser, requirePerm } from "../permissions";
import { computeTax } from "../billing";
import { D, dec, money } from "../money";
import { addDays, isIsoDate, todayCentral } from "../dates";
import { normalizeUnit } from "../po";
import { renderSalePdf } from "../pdf";
import { logEvent, openRentalFor } from "./inventory";
import { feesFor } from "./fees";

const moneyStr = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "Enter an amount like 45000.00");

export const saleSchema = z.object({
  customer_id: z.coerce.string().regex(/^\d+$/, "Choose a customer"),
  unit_number: z.string().trim().min(1, "Enter the unit number").transform(normalizeUnit),
  price: moneyStr,
  freight: z.union([moneyStr, z.literal("")]).optional().nullable().transform((v) => (v ? v : "0")),
  taxable: z.boolean().default(true),
  // Percent as typed (8.25 means 8.25%). Blank uses the customer's tax rate.
  tax_percent: z.union([z.string().trim().regex(/^\d{1,2}(\.\d{1,4})?$/, "Enter the tax rate as a percent, like 8.25"), z.literal("")]).optional().nullable(),
  terms_days: z.union([z.literal(""), z.coerce.number().int().min(0).max(365)]).optional().nullable().transform((v) => (v === "" || v == null ? null : v)),
  hours_at_sale: z.union([z.literal(""), z.coerce.number().min(0).max(999999)]).optional().nullable().transform((v) => (v === "" || v == null ? null : v)),
  notes: z.string().trim().max(2000).optional().nullable().transform((v) => (v ? v : null)),
});

function amounts(price: string, freight: string, taxable: boolean, taxRate: string, fees: Array<{ amount: string; taxable: boolean }> = []) {
  const feeTotal = fees.reduce((t, f) => t.add(dec(f.amount)), new D(0));
  const taxableFees = fees.filter((f) => f.taxable).reduce((t, f) => t.add(dec(f.amount)), new D(0));
  const subtotal = dec(price).add(dec(freight)).add(feeTotal);
  const tax = taxable ? computeTax(dec(price).add(dec(freight)).add(taxableFees), taxRate) : "0.00";
  return { subtotal: money(subtotal), tax_amount: tax, total: money(subtotal.add(tax)) };
}

/**
 * Work out the unit's sale fees (HET, TERP, surcharges) as of `date` and store them on the draft sale,
 * then update its totals. Percent fees are a percent of the sale price.
 */
export async function refreshSaleFees(db: Db, saleId: string, date = todayCentral()) {
  const sale = await one(`SELECT * FROM equipment_sales WHERE id=$1`, [saleId], db);
  if (!sale || sale.finalized_at) return sale;
  const unit = await one(`SELECT id, equipment_class, category FROM equipment WHERE id=$1`, [sale.equipment_id], db);
  const applied = await feesFor({ txn: "sale", equipment: unit, customerId: sale.customer_id, date, base: sale.price, firstPeriod: true, saleId }, db);
  await db.query(`DELETE FROM sale_fees WHERE sale_id=$1`, [saleId]);
  const billed: Array<{ amount: string; taxable: boolean }> = [];
  for (const { fee, outcome } of applied) {
    if (outcome.status !== "billed" || dec(outcome.amount).lte(0)) continue;
    await db.query(`INSERT INTO sale_fees(sale_id,fee_type_id,fee_category,description,amount,taxable) VALUES ($1,$2,$3,$4,$5,$6)`,
      [saleId, fee.id, fee.category, outcome.description, outcome.amount, fee.taxable]);
    billed.push({ amount: outcome.amount, taxable: fee.taxable });
  }
  const a = amounts(sale.price, sale.freight, sale.taxable, sale.tax_rate, billed);
  return one(`UPDATE equipment_sales SET subtotal=$2, tax_amount=$3, total=$4 WHERE id=$1 RETURNING *`, [saleId, a.subtotal, a.tax_amount, a.total], db);
}

/** Fees on a sale that apply but have no rate for the date, for the sale page. */
export async function saleFeeGaps(saleId: string, db: Db = pool()) {
  const sale = await one(`SELECT * FROM equipment_sales WHERE id=$1`, [saleId], db);
  if (!sale || sale.finalized_at) return [];
  const unit = await one(`SELECT id, equipment_class, category FROM equipment WHERE id=$1`, [sale.equipment_id], db);
  const applied = await feesFor({ txn: "sale", equipment: unit, customerId: sale.customer_id, date: todayCentral(), base: sale.price, firstPeriod: true, saleId }, db);
  return applied.map(({ fee, outcome }) => ({ id: fee.id, code: fee.code, name: fee.name, status: outcome.status, allow_override: fee.allow_override, calc_type: fee.calc_type }));
}

/** Start a sale as a draft. Nothing changes on the unit until the sale is finalized. */
export async function createSale(user: SessionUser, input: unknown) {
  requirePerm(user, "edit_records");
  const s = saleSchema.parse(input);
  return tx(async (db) => {
    const customer = await one(`SELECT c.*, p.tax_rate, p.payment_terms_days FROM customers c LEFT JOIN customer_billing_profiles p ON p.customer_id=c.id WHERE c.id=$1`, [s.customer_id], db);
    if (!customer) throw new AppError("Customer not found.");
    const unit = await one(`SELECT * FROM equipment WHERE unit_number=$1 FOR UPDATE`, [s.unit_number], db);
    if (!unit) throw new AppError(`Unit ${s.unit_number} is not in the equipment list.`);
    await assertSellable(db, unit);
    // A customer-wide sales tax exemption certificate (ag, resale) covering today means no sales tax.
    const exempt = taxExemptionFor(await activeTaxExemptions(customer.id, db), null, todayCentral());
    if (exempt) { s.taxable = false; s.notes = [s.notes, `Sales tax exempt: ${exemptionLabel(exempt)}.`].filter(Boolean).join(" "); }
    const taxRate = s.tax_percent ? new D(s.tax_percent).div(100).toFixed(5) : dec(customer.tax_rate).toFixed(5);
    const a = amounts(s.price, s.freight, s.taxable, taxRate);
    const row = await one(
      `INSERT INTO equipment_sales(customer_id,equipment_id,price,freight,taxable,tax_rate,subtotal,tax_amount,total,terms_days,hours_at_sale,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [customer.id, unit.id, money(s.price), money(s.freight), s.taxable, taxRate, a.subtotal, a.tax_amount, a.total, s.terms_days ?? customer.payment_terms_days ?? 30, s.hours_at_sale ?? unit.hour_meter, s.notes, user.id], db);
    const withFees = await refreshSaleFees(db, row.id);
    await audit(db, user.id, "create", "equipment_sale", row.id, null, { unit: unit.unit_number, customer: customer.name, total: withFees.total });
    return withFees;
  });
}

async function assertSellable(db: Db, unit: any, saleId?: string) {
  if (unit.status === "sold") throw new AppError(`Unit ${unit.unit_number} is already sold.`);
  const open = await openRentalFor(db, unit.id);
  if (open) throw new AppError(`Unit ${unit.unit_number} is on rent to ${open.customer_name} (${open.contract_number}). Return it before selling it.`);
  const other = await one(`SELECT id, sale_number FROM equipment_sales WHERE equipment_id=$1 AND status <> 'voided' AND ($2::bigint IS NULL OR id <> $2)`, [unit.id, saleId ?? null], db);
  if (other) throw new AppError(`Unit ${unit.unit_number} is already on sale ${other.sale_number ?? `draft #${other.id}`}.`);
}

async function lockSale(db: Db, id: string) {
  const s = await one(`SELECT * FROM equipment_sales WHERE id=$1 FOR UPDATE`, [id], db);
  if (!s) throw new AppError("Sale not found", "not_found");
  return s;
}

/** Finalize: number the sale from the same sequence as rental invoices, store its PDF, and mark the unit sold. */
export async function finalizeSale(user: SessionUser, id: string) {
  requirePerm(user, "approve_invoice");
  return tx(async (db) => {
    const sale = await lockSale(db, id);
    if (sale.status !== "draft") throw new AppError("Only a draft sale can be finalized.");
    const unit = await one(`SELECT * FROM equipment WHERE id=$1 FOR UPDATE`, [sale.equipment_id], db);
    await assertSellable(db, unit, id);
    const s = await one(`SELECT * FROM company_settings WHERE id=1 FOR UPDATE`, [], db);
    await db.query(`UPDATE company_settings SET next_invoice_number = next_invoice_number + 1 WHERE id=1`);
    const number = `${s.invoice_prefix}${s.next_invoice_number}`;
    if (await one(`SELECT 1 FROM invoices WHERE invoice_number=$1`, [number], db)) throw new AppError(`Invoice number ${number} is already used. Check the next invoice number in Settings.`);
    const customer = await one(`SELECT * FROM customers WHERE id=$1`, [sale.customer_id], db);
    const saleDate = todayCentral();
    Object.assign(sale, await refreshSaleFees(db, id, saleDate));
    sale.fees = await q(`SELECT description, amount, taxable, fee_category FROM sale_fees WHERE sale_id=$1 ORDER BY id`, [id], db);
    const snapshot = {
      company: { legal_name: s.legal_name, address_line1: s.address_line1, address_line2: s.address_line2, city_state_zip: s.city_state_zip, phone: s.phone, email: s.email, remit_to: s.remit_to, is_placeholder: s.is_placeholder },
      customer: { id: customer.id, code: customer.customer_code, name: customer.name, billing_address: customer.billing_address },
      equipment: { id: unit.id, unit_number: unit.unit_number, description: unit.description, serial_number: unit.serial_number, make: unit.make, model: unit.model, year: unit.year, category: unit.category },
    };
    const staged = { ...sale, sale_number: number, sale_date: saleDate, due_date: addDays(saleDate, Number(sale.terms_days)), snapshot, finalized_at: new Date() };
    const pdf = Buffer.from(await renderSalePdf({ sale: staged, draft: false }));
    const sha = createHash("sha256").update(pdf).digest("hex");
    await db.query(`UPDATE equipment_sales SET sale_number=$2, sale_date=$3, due_date=$4, snapshot=$5, pdf=$6, pdf_sha256=$7, status='issued', finalized_by=$8, finalized_at=$9 WHERE id=$1`,
      [id, number, saleDate, staged.due_date, JSON.stringify(snapshot), pdf, sha, user.id, staged.finalized_at]);
    await db.query(`UPDATE equipment SET status='sold', hour_meter=COALESCE($2,hour_meter) WHERE id=$1`, [unit.id, sale.hours_at_sale]);
    await logEvent(db, { equipmentId: unit.id, kind: "sold", date: saleDate, status: "sold", hours: sale.hours_at_sale, note: `Sold to ${customer.name} on ${number}`, saleId: id, userId: user.id });
    await audit(db, user.id, "finalize", "equipment_sale", id, null, { sale_number: number, total: sale.total, pdf_sha256: sha });
    return { sale_number: number, pdf_sha256: sha };
  });
}

/** Void a sale that has no payments. A finalized sale keeps its number and PDF; the unit goes back to available. */
export async function voidSale(user: SessionUser, id: string, reason: string) {
  requirePerm(user, "void_invoice");
  if (!reason || reason.trim().length < 5) throw new AppError("Enter a reason for voiding.");
  return tx(async (db) => {
    const sale = await lockSale(db, id);
    if (sale.status === "voided") throw new AppError("This sale is already voided.");
    if (dec(sale.amount_paid).gt(0)) throw new AppError("Payments were recorded on this sale, so it can't be voided.");
    await db.query(`UPDATE equipment_sales SET status='voided', voided_by=$2, voided_at=now(), void_reason=$3 WHERE id=$1`, [id, user.id, reason.trim()]);
    if (sale.finalized_at) {
      await db.query(`UPDATE equipment SET status='available' WHERE id=$1 AND status='sold'`, [sale.equipment_id]);
      await logEvent(db, { equipmentId: sale.equipment_id, kind: "sale_voided", status: "available", note: `${sale.sale_number} voided: ${reason.trim()}`, saleId: id, userId: user.id });
    }
    await audit(db, user.id, "void", "equipment_sale", id, { status: sale.status }, { status: "voided" }, reason);
  });
}

export async function recordSalePayment(user: SessionUser, id: string, input: { amount: string; paid_on: string; method?: string; reference?: string }) {
  requirePerm(user, "record_payment");
  if (!/^\d+(\.\d{1,2})?$/.test(String(input.amount).trim()) || dec(input.amount).lte(0)) throw new AppError("Enter a positive payment amount.");
  if (!isIsoDate(input.paid_on)) throw new AppError("Enter the payment date.");
  return tx(async (db) => {
    const sale = await lockSale(db, id);
    if (!["issued", "partially_paid"].includes(sale.status)) throw new AppError("Payments can only be recorded on a finalized, unpaid sale.");
    const balance = dec(sale.total).sub(sale.amount_paid);
    if (dec(input.amount).gt(balance)) throw new AppError(`Payment exceeds the balance due (${money(balance)}).`);
    await db.query(`INSERT INTO sale_payments(sale_id,amount,paid_on,method,reference,recorded_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, money(input.amount), input.paid_on, input.method || null, input.reference || null, user.id]);
    const paid = dec(sale.amount_paid).add(input.amount);
    await db.query(`UPDATE equipment_sales SET amount_paid=$2, status=$3 WHERE id=$1`, [id, money(paid), paid.gte(sale.total) ? "paid" : "partially_paid"]);
    await audit(db, user.id, "payment", "equipment_sale", id, { amount_paid: sale.amount_paid }, { amount_paid: money(paid) });
  });
}

/** Finalized sales return their stored PDF (checked against its fingerprint); drafts render live with a DRAFT mark. */
export async function salePdf(id: string, db: Db = pool()) {
  const sale = await one(`SELECT s.*, e.unit_number FROM equipment_sales s JOIN equipment e ON e.id=s.equipment_id WHERE s.id=$1`, [id], db);
  if (!sale) throw new AppError("Sale not found", "not_found");
  if (sale.finalized_at) {
    const sha = createHash("sha256").update(sale.pdf).digest("hex");
    if (sha !== sale.pdf_sha256) throw new AppError("Stored PDF failed its integrity check. Contact an administrator.", "integrity");
    return { pdf: sale.pdf as Buffer, filename: `${sale.sale_number}.pdf`, finalized: true, sha256: sha };
  }
  const company = await one(`SELECT * FROM company_settings WHERE id=1`, [], db);
  const customer = await one(`SELECT * FROM customers WHERE id=$1`, [sale.customer_id], db);
  const unit = await one(`SELECT * FROM equipment WHERE id=$1`, [sale.equipment_id], db);
  sale.fees = await q(`SELECT description, amount, taxable, fee_category FROM sale_fees WHERE sale_id=$1 ORDER BY id`, [id], db);
  const pdf = Buffer.from(await renderSalePdf({ sale: { ...sale, snapshot: { company, customer: { ...customer, code: customer.customer_code }, equipment: unit } }, draft: true }));
  return { pdf, filename: `DRAFT-SALE-${sale.unit_number}.pdf`, finalized: false, sha256: createHash("sha256").update(pdf).digest("hex") };
}

export async function listSales(db: Db = pool()) {
  return q(`SELECT s.id, s.sale_number, s.status, s.sale_date, s.due_date, s.total, s.amount_paid, s.created_at, e.unit_number, e.description, c.name AS customer_name
            FROM equipment_sales s JOIN equipment e ON e.id=s.equipment_id JOIN customers c ON c.id=s.customer_id ORDER BY s.created_at DESC, s.id DESC`, [], db);
}

export async function saleDetail(id: string, db: Db = pool()) {
  const sale = await one(`SELECT s.*, e.unit_number, e.description, e.serial_number, e.make, e.model, e.year, c.name AS customer_name, c.customer_code,
                                 uc.name AS created_by_name, uf.name AS finalized_by_name, uv.name AS voided_by_name
                          FROM equipment_sales s JOIN equipment e ON e.id=s.equipment_id JOIN customers c ON c.id=s.customer_id
                          LEFT JOIN users uc ON uc.id=s.created_by LEFT JOIN users uf ON uf.id=s.finalized_by LEFT JOIN users uv ON uv.id=s.voided_by WHERE s.id=$1`, [id], db);
  if (!sale) return null;
  const payments = await q(`SELECT * FROM sale_payments WHERE sale_id=$1 ORDER BY paid_on, id`, [id], db);
  const fees = await q(`SELECT f.*, t.code FROM sale_fees f JOIN fee_types t ON t.id=f.fee_type_id WHERE f.sale_id=$1 ORDER BY f.id`, [id], db);
  return { sale, payments, fees };
}
