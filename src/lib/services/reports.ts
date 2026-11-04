// Receivables and rental reports: AR aging, customer statements, the month's invoice packet,
// and rental activity. Read-only: nothing here changes an invoice or its amounts.
import { PDFDocument } from "pdf-lib";
import { AppError, Db, one, pool, q } from "../db";
import { D, Dec, cents, dec } from "../money";
import { diffDays, maxDate, minDate, monthEnd, monthStart, todayCentral, daysInclusive } from "../dates";
import { invoicePdf, refreshOverdue } from "./invoices";

/** Finalized invoices that can still owe money. Drafts, voided and replaced invoices never count. */
const OPEN_STATUSES = ["approved", "issued", "partially_paid", "overdue"];

export const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
export type Bucket = (typeof AGING_BUCKETS)[number];
export const BUCKET_LABELS: Record<Bucket, string> = { current: "Not yet due", d1_30: "1-30 days", d31_60: "31-60 days", d61_90: "61-90 days", d90_plus: "Over 90 days" };

export function bucketFor(daysPastDue: number): Bucket {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "d1_30";
  if (daysPastDue <= 60) return "d31_60";
  if (daysPastDue <= 90) return "d61_90";
  return "d90_plus";
}

const emptyTotals = () => Object.fromEntries([...AGING_BUCKETS, "total"].map((k) => [k, new D(0)])) as Record<Bucket | "total", Dec>;
const asStrings = (t: Record<string, Dec>) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, cents(v).toFixed(2)])) as Record<Bucket | "total", string>;

export interface OpenInvoice {
  id: string; invoice_number: string; customer_id: string; customer_name: string; customer_code: string; status: string;
  invoice_date: string; due_date: string; period_start: string; period_end: string; po_number: string | null; unit: string; contract: string;
  total: string; amount_paid: string; balance: string; days_past_due: number; bucket: Bucket;
  /** "rental" invoices live under /invoices, "sale" invoices (equipment sold) under /sales. */
  kind: "rental" | "sale"; href: string;
}

export async function openInvoices(asOf = todayCentral(), customerId?: string | null, db: Db = pool()): Promise<OpenInvoice[]> {
  const rows = await q(
    `SELECT i.id, i.invoice_number, i.customer_id, c.name AS customer_name, c.customer_code, i.status, i.invoice_date, i.due_date, i.period_start, i.period_end,
            i.po_number, i.snapshot->'equipment'->>'unit_number' AS unit, i.snapshot->'contract'->>'number' AS contract, i.total, i.amount_paid
     FROM invoices i JOIN customers c ON c.id=i.customer_id
     WHERE i.status = ANY($1) AND i.invoice_date <= $2 AND ($3::bigint IS NULL OR i.customer_id=$3)
     UNION ALL
     SELECT s.id, s.sale_number, s.customer_id, c.name, c.customer_code, s.status, s.sale_date, s.due_date, s.sale_date, s.sale_date,
            NULL, e.unit_number, 'Equipment sale', s.total, s.amount_paid
     FROM equipment_sales s JOIN customers c ON c.id=s.customer_id JOIN equipment e ON e.id=s.equipment_id
     WHERE s.status IN ('issued','partially_paid') AND s.sale_date <= $2 AND ($3::bigint IS NULL OR s.customer_id=$3)
     ORDER BY 4, 8, 2`, [OPEN_STATUSES, asOf, customerId || null], db);
  return rows
    .map((r) => {
      const balance = cents(dec(r.total).sub(dec(r.amount_paid)));
      const days = r.due_date ? diffDays(r.due_date, asOf) : 0;
      const kind = r.contract === "Equipment sale" ? "sale" : "rental";
      return { ...r, balance: balance.toFixed(2), days_past_due: Math.max(0, days), bucket: bucketFor(days), kind, href: `/${kind === "sale" ? "sales" : "invoices"}/${r.id}` };
    })
    .filter((r) => dec(r.balance).gt(0));
}

/** Accounts-receivable aging by customer, as of a date (default today, Central time). */
export async function agingReport(asOf = todayCentral()) {
  await refreshOverdue();
  const invoices = await openInvoices(asOf);
  const byCustomer = new Map<string, { customer_id: string; customer_name: string; customer_code: string; count: number; totals: Record<Bucket | "total", Dec> }>();
  const grand = emptyTotals();
  for (const inv of invoices) {
    let c = byCustomer.get(inv.customer_id);
    if (!c) byCustomer.set(inv.customer_id, (c = { customer_id: inv.customer_id, customer_name: inv.customer_name, customer_code: inv.customer_code, count: 0, totals: emptyTotals() }));
    c.count++;
    c.totals[inv.bucket] = c.totals[inv.bucket].add(inv.balance);
    c.totals.total = c.totals.total.add(inv.balance);
    grand[inv.bucket] = grand[inv.bucket].add(inv.balance);
    grand.total = grand.total.add(inv.balance);
  }
  const customers = [...byCustomer.values()].map((c) => ({ ...c, totals: asStrings(c.totals) }));
  return { asOf, customers, invoices, totals: asStrings(grand) };
}

/** Everything a customer statement needs: who, what's open, how old, and recent payments. */
export async function customerStatement(customerId: string, asOf = todayCentral()) {
  const customer = await one(`SELECT c.*, p.payment_terms_label FROM customers c LEFT JOIN customer_billing_profiles p ON p.customer_id=c.id WHERE c.id=$1`, [customerId]);
  if (!customer) throw new AppError("Customer not found", "not_found");
  const company = await one(`SELECT * FROM company_settings WHERE id=1`);
  const invoices = await openInvoices(asOf, customerId);
  const totals = emptyTotals();
  for (const inv of invoices) { totals[inv.bucket] = totals[inv.bucket].add(inv.balance); totals.total = totals.total.add(inv.balance); }
  const payments = await q(
    `SELECT p.paid_on, p.amount, p.method, p.reference, i.invoice_number FROM payments p JOIN invoices i ON i.id=p.invoice_id
     WHERE i.customer_id=$1 AND p.paid_on <= $2 AND p.paid_on > ($2::date - interval '90 days')
     UNION ALL
     SELECT sp.paid_on, sp.amount, sp.method, sp.reference, s.sale_number FROM sale_payments sp JOIN equipment_sales s ON s.id=sp.sale_id
     WHERE s.customer_id=$1 AND sp.paid_on <= $2 AND sp.paid_on > ($2::date - interval '90 days')
     ORDER BY 1 DESC`, [customerId, asOf]);
  return { asOf, company, customer, invoices, totals: asStrings(totals), payments };
}

/**
 * The month's finalized invoices for one customer as a single PDF, in unit order: what gets sent
 * to the customer. Each invoice is the stored, hash-checked original (agreement pages included).
 */
export async function monthPacket(customerId: string, month: string) {
  const ms = monthStart(month), me = monthEnd(month);
  const rows = await q(
    `SELECT i.id, i.invoice_number, i.snapshot->'equipment'->>'unit_number' AS unit FROM invoices i
     WHERE i.customer_id=$1 AND i.finalized_at IS NOT NULL AND i.status NOT IN ('voided','corrected') AND i.period_start <= $3 AND i.period_end >= $2
     ORDER BY unit, i.invoice_number`, [customerId, ms, me]);
  if (!rows.length) throw new AppError("No approved invoices for this customer and month yet.", "not_found");
  const out = await PDFDocument.create();
  out.setTitle(`Invoices ${month.slice(0, 7)}`);
  out.setCreator("Champion Billing");
  for (const r of rows) {
    const { pdf } = await invoicePdf(r.id); // throws if a stored PDF fails its integrity check
    const src = await PDFDocument.load(pdf);
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  return { pdf: Buffer.from(await out.save()), count: rows.length, invoiceNumbers: rows.map((r) => r.invoice_number) };
}

/**
 * Rental activity for a month: every rental line that was on rent at any point in it, how many
 * days, what was billed for that month, what it's billed through, and its lifetime billing.
 */
export async function rentalActivity(month: string, customerId?: string | null) {
  const ms = monthStart(month), me = monthEnd(month);
  const rows = await q(
    `SELECT l.id AS line_id, cu.name AS customer_name, rc.contract_number, e.unit_number, e.description, l.status, l.on_rent_date, l.billing_start_date, l.off_rent_date,
            l.rate_amount, l.rate_basis,
            (SELECT max(i.period_end) FROM invoices i WHERE i.contract_line_id=l.id AND i.finalized_at IS NOT NULL AND i.status NOT IN ('voided','corrected')) AS billed_through,
            (SELECT coalesce(sum(i.total),0) FROM invoices i WHERE i.contract_line_id=l.id AND i.finalized_at IS NOT NULL AND i.status NOT IN ('voided','corrected')
               AND i.period_start <= $2 AND i.period_end >= $1) AS billed_this_month,
            (SELECT coalesce(sum(i.total),0) FROM invoices i WHERE i.contract_line_id=l.id AND i.finalized_at IS NOT NULL AND i.status NOT IN ('voided','corrected')) AS billed_to_date,
            (SELECT coalesce(sum(i.amount_paid),0) FROM invoices i WHERE i.contract_line_id=l.id AND i.finalized_at IS NOT NULL AND i.status NOT IN ('voided','corrected')) AS paid_to_date
     FROM rental_contract_lines l JOIN rental_contracts rc ON rc.id=l.contract_id JOIN customers cu ON cu.id=rc.customer_id JOIN equipment e ON e.id=l.equipment_id
     WHERE l.on_rent_date <= $2 AND (l.off_rent_date IS NULL OR l.off_rent_date >= $1) AND ($3::bigint IS NULL OR cu.id=$3)
     ORDER BY cu.name, e.unit_number`, [ms, me, customerId || null]);
  let billed = new D(0);
  const out = rows.map((r) => {
    const from = maxDate(r.on_rent_date, ms), to = minDate(r.off_rent_date ?? me, me);
    billed = billed.add(r.billed_this_month);
    return { ...r, days_on_rent: daysInclusive(from, to) };
  });
  return { month: ms, rows: out, totals: { lines: out.length, billed_this_month: cents(billed).toFixed(2), unit_days: out.reduce((s, r) => s + r.days_on_rent, 0) } };
}
