/**
 * Rent-to-own (rental purchase option), as Champion runs it:
 *  - Staff set a purchase price, the percent of rent that counts toward it, and a number of months.
 *  - Only rent paid on time counts: the invoice must be fully paid within 30 days of its invoice date
 *    (net 30). Rent on a late or unpaid invoice earns no credit.
 *  - "Rent" means the invoice's rental charge lines only, not tax, delivery, pickup, fees or the
 *    damage waiver. A credit memo on an invoice reduces the rent counted from it.
 *  - When the credit reaches the price, or the months run out, the machine is ready to sell to the
 *    customer for the purchase price less the credit (the balloon payment). An employee confirms that
 *    step; it ends the rental and creates a DRAFT equipment sale for review. Nothing happens on its own.
 *
 * Nothing here changes rentals, invoices, Quipli or amounts until that confirmed step.
 */
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { D, cents, dec, fmtUSD, money } from "../money";
import { addDays, fmtDate, isIsoDate, todayCentral } from "../dates";
import { changeLineStatus } from "./records";
import { createSale } from "./sales";

const PCT = /^\d{1,3}(\.\d{1,2})?$/;
const MONEY = /^\d+(\.\d{1,2})?$/;

/** Same day-of-month n months later; a day past the month's end (Jan 31 + 1) becomes its last day. */
export function plusMonths(date: string, n: number) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

export async function optionForLine(lineId: string, db: Db = pool()) {
  return one(`SELECT o.*, s.sale_number, s.status AS sale_status FROM rental_purchase_options o LEFT JOIN equipment_sales s ON s.id=o.sale_id WHERE o.contract_line_id=$1`, [lineId], db);
}

export async function setUpPurchaseOption(user: SessionUser, lineId: string, input: { purchase_price: string; credit_percent: string; term_months: string; starts_on?: string; notes?: string }) {
  requirePerm(user, "approve_invoice");
  const price = String(input.purchase_price ?? "").replace(/[$,\s]/g, "");
  if (!MONEY.test(price) || dec(price).lte(0)) throw new AppError("Enter the purchase price, like 45000.00.");
  const pctRaw = String(input.credit_percent ?? "").replace(/[%\s]/g, "");
  if (!PCT.test(pctRaw) || dec(pctRaw).lte(0) || dec(pctRaw).gt(100)) throw new AppError("Enter the percent of rent that counts toward the purchase, between 1 and 100.");
  const months = Number(input.term_months);
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new AppError("Enter the number of months, 1 to 120.");
  return tx(async (db) => {
    const line = await one(`SELECT l.*, c.customer_id, c.contract_number FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id WHERE l.id=$1 FOR UPDATE OF l`, [lineId], db);
    if (!line) throw new AppError("Rental not found", "not_found");
    if (!["active", "off_rent"].includes(line.status)) throw new AppError("Rent-to-own can only be set up on an open rental.");
    const starts = input.starts_on || line.on_rent_date;
    if (!isIsoDate(starts)) throw new AppError("Enter the start date.");
    if (starts < line.on_rent_date) throw new AppError("Rent-to-own can't start before the machine went on rent.");
    const existing = await one(`SELECT * FROM rental_purchase_options WHERE contract_line_id=$1`, [lineId], db);
    if (existing && existing.status !== "cancelled") throw new AppError("This rental already has a rent-to-own option.");
    if (existing) await db.query(`DELETE FROM rental_purchase_options WHERE id=$1`, [existing.id]);
    const row = await one(
      `INSERT INTO rental_purchase_options(contract_line_id, purchase_price, credit_pct, term_months, starts_on, ends_on, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [lineId, money(price), new D(pctRaw).div(100).toFixed(4), months, starts, plusMonths(starts, months), String(input.notes ?? "").trim().slice(0, 1000) || null, user.id], db);
    await audit(db, user.id, existing ? "rto_replace" : "rto_create", "rental_line", lineId, existing ?? null, row);
    return row;
  });
}

export async function cancelPurchaseOption(user: SessionUser, lineId: string, reason: string) {
  requirePerm(user, "approve_invoice");
  const r = String(reason ?? "").trim();
  if (r.length < 5) throw new AppError("Say why the rent-to-own is being cancelled.");
  return tx(async (db) => {
    const o = await one(`SELECT * FROM rental_purchase_options WHERE contract_line_id=$1 FOR UPDATE`, [lineId], db);
    if (!o || o.status !== "active") throw new AppError("Only an active rent-to-own can be cancelled.");
    await db.query(`UPDATE rental_purchase_options SET status='cancelled', cancel_reason=$2, closed_by=$3, closed_at=now() WHERE id=$1`, [o.id, r, user.id]);
    await audit(db, user.id, "rto_cancel", "rental_line", lineId, { status: "active" }, { status: "cancelled", reason: r });
  });
}

export interface RtoInvoice { id: string; invoice_number: string; invoice_date: string; period_start: string; total: string; rent: string; counted: string; on_time: boolean; why: string }

/** Where a rent-to-own stands today: each invoice in the term, what counted, the credit and the balance. */
export async function purchaseOptionStatus(lineId: string, asOf = todayCentral(), db: Db = pool()) {
  const o = await optionForLine(lineId, db);
  if (!o) return null;
  const invs = await q(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.period_start, i.total, i.status, i.amount_paid, i.amount_credited,
            COALESCE((SELECT sum(amount) FROM invoice_lines WHERE invoice_id=i.id AND kind='rental'),0) AS rent,
            COALESCE((SELECT sum(amount) FROM payments WHERE invoice_id=i.id AND paid_on <= i.invoice_date + $2::int),0) AS paid_in_time,
            COALESCE((SELECT sum(total) FROM credit_memos WHERE invoice_id=i.id AND credit_date <= i.invoice_date + $2::int),0) AS credited_in_time,
            COALESCE((SELECT sum(subtotal) FROM credit_memos WHERE invoice_id=i.id),0) AS credit_subtotal
     FROM invoices i
     WHERE i.contract_line_id=$1 AND i.finalized_at IS NOT NULL AND i.status NOT IN ('draft','pending_review','rejected','voided','corrected')
       AND i.period_start >= $3 AND i.period_start < $4
     ORDER BY i.period_start, i.id`, [lineId, o.on_time_days, o.starts_on, o.ends_on], db);
  let counted = dec(0);
  const invoices: RtoInvoice[] = invs.map((i: any) => {
    const settled = dec(i.paid_in_time).add(i.credited_in_time);
    const dueBy = addDays(i.invoice_date, o.on_time_days);
    const onTime = settled.gte(i.total);
    let why = "Paid on time";
    const settledNow = dec(i.amount_paid).add(i.amount_credited).gte(i.total);
    if (!onTime) why = settledNow ? `Paid late (after ${fmtDate(dueBy)})` : asOf <= dueBy ? `Not paid yet (counts if paid by ${fmtDate(dueBy)})` : `Not paid in full by ${fmtDate(dueBy)}`;
    let c = dec(i.rent).sub(i.credit_subtotal);
    if (c.lt(0)) c = dec(0);
    if (!onTime) c = dec(0);
    counted = counted.add(c);
    return { id: i.id, invoice_number: i.invoice_number, invoice_date: i.invoice_date, period_start: i.period_start, total: i.total, rent: money(i.rent), counted: money(c), on_time: onTime, why };
  });
  const rawCredit = cents(counted.mul(o.credit_pct));
  const credit = o.status === "exercised" ? dec(o.credit_at_exercise) : D.min(rawCredit, dec(o.purchase_price));
  const balance = dec(o.purchase_price).sub(credit);
  const paidOff = balance.lte(0);
  const termEnded = asOf >= o.ends_on;
  const ready = o.status === "active" && (paidOff || termEnded);
  return {
    option: o, invoices, rentCounted: money(counted), credit: money(credit), balance: money(balance), paidOff, termEnded, ready,
    readyText: !ready ? null : paidOff ? "On-time rent has covered the purchase price. The machine is ready to be sold to the customer." :
      `The ${o.term_months}-month term ended ${fmtDate(o.ends_on)}. The customer owes the balloon payment of ${fmtUSD(balance)} to buy it.`,
  };
}

/** Open rent-to-own agreements that are paid off or past their term, for the dashboard. */
export async function purchaseOptionsReady(asOf = todayCentral()) {
  const rows = await q(`SELECT o.contract_line_id, c.contract_number, e.unit_number, cu.name AS customer_name FROM rental_purchase_options o
                        JOIN rental_contract_lines l ON l.id=o.contract_line_id JOIN rental_contracts c ON c.id=l.contract_id JOIN equipment e ON e.id=l.equipment_id JOIN customers cu ON cu.id=c.customer_id
                        WHERE o.status='active'`);
  const out = [];
  for (const r of rows) {
    const s = await purchaseOptionStatus(r.contract_line_id, asOf);
    if (s?.ready) out.push({ ...r, balance: s.balance, paidOff: s.paidOff });
  }
  return out;
}

/**
 * Employee-confirmed: end the rental as of its call-off date and create a draft sale for the purchase
 * price less the credit. The rental must be called off first (with its final rent billed), so no rent
 * is lost. The sale stays a draft so tax and details are reviewed before it is finalized.
 */
export async function exercisePurchaseOption(user: SessionUser, lineId: string) {
  requirePerm(user, "approve_invoice");
  const s = await purchaseOptionStatus(lineId);
  if (!s || s.option.status !== "active") throw new AppError("This rental has no active rent-to-own.");
  const line = await one(`SELECT l.*, c.customer_id, e.unit_number FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id JOIN equipment e ON e.id=l.equipment_id WHERE l.id=$1`, [lineId]);
  if (line.status !== "off_rent" || !line.off_rent_date) throw new AppError("Call off the rental first (with the purchase date as the off-rent date) and bill its final rent, then convert it to a sale.");
  const draft = await one(`SELECT id FROM invoices WHERE contract_line_id=$1 AND finalized_at IS NULL AND status IN ('draft','pending_review')`, [lineId]);
  if (draft) throw new AppError("Finish or remove the rental's draft invoice first, so the credit is final.");
  const o = s.option;
  const note = `Rent-to-own buyout: purchase price ${fmtUSD(o.purchase_price)} less rent credit ${fmtUSD(s.credit)} (${new D(o.credit_pct).mul(100).toFixed(2).replace(/\.00$/, "")}% of ${fmtUSD(s.rentCounted)} rent paid on time).`;
  await changeLineStatus(user, lineId, { status: "returned", date: line.off_rent_date, note: "Bought by the customer under rent-to-own" });
  const sale = await createSale(user, { customer_id: line.customer_id, unit_number: line.unit_number, price: s.balance, notes: note });
  await tx(async (db) => {
    await db.query(`UPDATE rental_purchase_options SET status='exercised', sale_id=$2, credit_at_exercise=$3, closed_by=$4, closed_at=now() WHERE id=$1`, [o.id, sale.id, s.credit, user.id]);
    await audit(db, user.id, "rto_exercise", "rental_line", lineId, { status: "active" }, { status: "exercised", sale_id: sale.id, credit: s.credit, balance: s.balance });
  });
  return sale;
}
