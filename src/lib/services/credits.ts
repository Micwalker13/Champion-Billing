// Credit memos against finalized rental invoices. The original invoice and its PDF stay exactly as
// sent; the credit is its own numbered, permanent document that lowers the invoice's balance.
import { createHash } from "node:crypto";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { computeTax } from "../billing";
import { dec, money } from "../money";
import { todayCentral } from "../dates";
import { renderCreditMemoPdf } from "../pdf";

const CREDITABLE = ["approved", "issued", "partially_paid", "overdue"];

export function invoiceBalance(inv: { total: string; amount_paid: string; amount_credited?: string | null }) {
  return dec(inv.total).sub(dec(inv.amount_paid)).sub(dec(inv.amount_credited));
}

/**
 * Issue a credit for part or all of an invoice's open balance. `amount` is before tax; when the
 * invoice charged sales tax and `creditTax` is set, the matching tax is credited too.
 */
export async function issueCredit(user: SessionUser, invoiceId: string, input: { amount: string; creditTax?: boolean; reason: string }) {
  requirePerm(user, "void_invoice");
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 5) throw new AppError("Enter the reason for the credit (at least 5 characters).");
  if (!/^\d+(\.\d{1,2})?$/.test(String(input.amount ?? "").trim()) || dec(input.amount).lte(0)) throw new AppError("Enter the credit amount before tax, like 500.00.");
  return tx(async (db) => {
    const inv = await one(`SELECT * FROM invoices WHERE id=$1 FOR UPDATE`, [invoiceId], db);
    if (!inv) throw new AppError("Invoice not found", "not_found");
    if (!inv.finalized_at || !CREDITABLE.includes(inv.status)) throw new AppError("Credits can only be issued on an approved or sent invoice that still has a balance.");
    const prior = await one(`SELECT coalesce(sum(subtotal),0) AS sub, count(*)::int AS n FROM credit_memos WHERE invoice_id=$1`, [invoiceId], db);
    const subtotal = dec(input.amount);
    if (subtotal.add(prior.sub).gt(inv.subtotal)) throw new AppError(`Credits can't exceed the invoice's charges (${money(inv.subtotal)} before tax; ${money(prior.sub)} already credited).`);
    const taxed = input.creditTax !== false && dec(inv.taxable_amount).gt(0);
    const tax = taxed ? computeTax(subtotal, inv.tax_rate) : "0.00";
    const total = subtotal.add(tax);
    const balance = invoiceBalance(inv);
    if (total.gt(balance)) throw new AppError(`This credit (${money(total)} with tax) is more than the open balance of ${money(balance)}. Payments already received are not refunded here.`);

    const number = `${inv.invoice_number}-CM${prior.n + 1}`;
    const s = inv.snapshot;
    const company = await one(`SELECT * FROM company_settings WHERE id=1`, [], db);
    const snapshot = {
      company: { legal_name: company.legal_name, address_line1: company.address_line1, address_line2: company.address_line2, city_state_zip: company.city_state_zip, phone: company.phone, email: company.email, remit_to: company.remit_to, is_placeholder: company.is_placeholder },
      customer: s.customer, contract: s.contract, equipment: s.equipment, po_number: inv.po_number,
      invoice: { number: inv.invoice_number, date: inv.invoice_date, total: inv.total, period_start: inv.period_start, period_end: inv.period_end },
    };
    const memo = { credit_number: number, credit_date: todayCentral(), reason, subtotal: money(subtotal), tax_rate: inv.tax_rate, tax_amount: tax, total: money(total), snapshot, created_at: new Date() };
    const pdf = Buffer.from(await renderCreditMemoPdf(memo));
    const sha = createHash("sha256").update(pdf).digest("hex");
    const row = await one(
      `INSERT INTO credit_memos(credit_number,invoice_id,customer_id,credit_date,reason,subtotal,tax_rate,tax_amount,total,snapshot,pdf,pdf_sha256,created_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, credit_number, total`,
      [number, invoiceId, inv.customer_id, memo.credit_date, reason, memo.subtotal, inv.tax_rate, tax, memo.total, JSON.stringify(snapshot), pdf, sha, user.id, memo.created_at], db);

    const credited = dec(inv.amount_credited).add(total);
    const settled = dec(inv.amount_paid).add(credited).gte(inv.total);
    const status = settled ? (dec(inv.amount_paid).gt(0) ? "paid" : "credited") : inv.status;
    await db.query(`UPDATE invoices SET amount_credited=$2, status=$3 WHERE id=$1`, [invoiceId, money(credited), status]);
    await db.query(`INSERT INTO invoice_status_history(invoice_id,from_status,to_status,user_id,note) VALUES ($1,$2,$3,$4,$5)`,
      [invoiceId, inv.status, status, user.id, `Credit ${number} for ${money(total)}: ${reason}`]);
    await audit(db, user.id, "credit", "invoice", invoiceId, { amount_credited: inv.amount_credited, status: inv.status }, { credit_number: number, total: money(total), amount_credited: money(credited), status, pdf_sha256: sha }, reason);
    return row;
  });
}

export async function creditsForInvoice(invoiceId: string, db: Db = pool()) {
  return q(`SELECT c.id, c.credit_number, c.credit_date, c.reason, c.subtotal, c.tax_amount, c.total, u.name AS created_by_name
            FROM credit_memos c LEFT JOIN users u ON u.id=c.created_by WHERE c.invoice_id=$1 ORDER BY c.id`, [invoiceId], db);
}

/** The stored credit memo PDF, checked against its fingerprint. */
export async function creditPdf(id: string, db: Db = pool()) {
  const c = await one(`SELECT credit_number, pdf, pdf_sha256 FROM credit_memos WHERE id=$1`, [id], db);
  if (!c) throw new AppError("Credit memo not found", "not_found");
  const sha = createHash("sha256").update(c.pdf).digest("hex");
  if (sha !== c.pdf_sha256) throw new AppError("Stored PDF failed its integrity check. Contact an administrator.", "integrity");
  return { pdf: c.pdf as Buffer, filename: `${c.credit_number}.pdf`, sha256: sha };
}
