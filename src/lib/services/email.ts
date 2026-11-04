// Email finalized invoices (and credit memos) to the customer's AP address, with the PO in the subject.
// Switched off until SMTP settings are present. Every attempt, sent or failed, is logged permanently.
import nodemailer from "nodemailer";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { fmtDate, monthEnd, monthStart } from "../dates";
import { fmtUSD } from "../money";
import { invoicePdf, issueInvoice } from "./invoices";
import { creditPdf } from "./credits";

export interface MailSettings { host: string; port: number; user: string; pass: string; from: string; replyTo?: string }

/** SMTP settings from the environment, or null when email isn't set up. */
export function mailSettings(env: Record<string, string | undefined> = process.env): MailSettings | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, INVOICE_FROM, INVOICE_REPLY_TO } = env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !INVOICE_FROM) return null;
  return { host: SMTP_HOST, port: Number(SMTP_PORT || 587), user: SMTP_USER, pass: SMTP_PASS, from: INVOICE_FROM, replyTo: INVOICE_REPLY_TO || undefined };
}

type Sender = (msg: { from: string; replyTo?: string; to: string[]; subject: string; text: string; attachments: Array<{ filename: string; content: Buffer }> }) => Promise<{ messageId?: string }>;
let testSender: Sender | null = null;
/** Tests replace the SMTP transport with a stub. */
export function setTestSender(s: Sender | null) { testSender = s; }

function sender(): { send: Sender; settings: MailSettings } {
  const settings = mailSettings();
  if (testSender) return { send: testSender, settings: settings ?? { host: "test", port: 0, user: "", pass: "", from: "billing@test.local" } };
  if (!settings) throw new AppError("Email isn't set up yet. An administrator adds the mail server settings in Vercel (SMTP_HOST, SMTP_USER, SMTP_PASS, INVOICE_FROM).", "email_off");
  const t = nodemailer.createTransport({ host: settings.host, port: settings.port, secure: settings.port === 465, auth: { user: settings.user, pass: settings.pass } });
  return { send: (m) => t.sendMail(m), settings };
}

export function emailEnabled() { return !!testSender || !!mailSettings(); }

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;
export function parseAddresses(list: string | null | undefined): string[] {
  const out = String(list ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const bad = out.filter((a) => !EMAIL.test(a));
  if (bad.length) throw new AppError(`Not a valid email address: ${bad.join(", ")}`);
  return [...new Set(out.map((a) => a.toLowerCase()))];
}

async function recipients(db: Db, customerId: string) {
  const p = await one(`SELECT c.name, c.email, p.invoice_emails FROM customers c LEFT JOIN customer_billing_profiles p ON p.customer_id=c.id WHERE c.id=$1`, [customerId], db);
  const to = parseAddresses(p?.invoice_emails || p?.email);
  if (!to.length) throw new AppError(`${p?.name ?? "This customer"} has no invoice email address. Add one on the customer's billing profile.`);
  return to;
}

async function log(db: Db, r: { kind: string; docId: string; customerId: string; to: string[]; subject: string; sha?: string; status: "sent" | "failed"; error?: string; messageId?: string; userId: string }) {
  await db.query(`INSERT INTO document_emails(doc_kind,doc_id,customer_id,to_addresses,subject,pdf_sha256,status,error,message_id,sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [r.kind, r.docId, r.customerId, r.to.join(", "), r.subject, r.sha ?? null, r.status, r.error?.slice(0, 1000) ?? null, r.messageId ?? null, r.userId]);
}

export function invoiceSubject(inv: any) {
  const s = inv.snapshot;
  return `Invoice ${inv.invoice_number} | PO ${inv.po_number ?? "none"} | Unit ${s.equipment.unit_number} | ${fmtDate(inv.period_start)}-${fmtDate(inv.period_end)}`;
}

/** Send one finalized invoice. An approved invoice becomes "issued" once the email goes out. */
export async function emailInvoice(user: SessionUser, invoiceId: string) {
  requirePerm(user, "issue_invoice");
  const { send, settings } = sender();
  const inv = await one(`SELECT * FROM invoices WHERE id=$1`, [invoiceId]);
  if (!inv) throw new AppError("Invoice not found", "not_found");
  if (!inv.finalized_at || ["voided", "corrected"].includes(inv.status)) throw new AppError("Only approved invoices can be emailed.");
  const to = await recipients(pool(), inv.customer_id);
  const { pdf, filename, sha256 } = await invoicePdf(invoiceId);
  const company = await one(`SELECT legal_name, remit_to FROM company_settings WHERE id=1`);
  const subject = invoiceSubject(inv);
  const s = inv.snapshot;
  const text = [
    `Please find attached invoice ${inv.invoice_number} from ${company.legal_name}.`,
    ``,
    `PO: ${inv.po_number ?? "none"}`,
    `Unit: ${s.equipment.unit_number} ${s.equipment.description}`,
    `Rental agreement: ${s.contract.number}`,
    `Billing period: ${fmtDate(inv.period_start)} - ${fmtDate(inv.period_end)}`,
    `Amount due: ${fmtUSD(inv.total)}, due ${fmtDate(inv.due_date)}`,
    company.remit_to ? `Remit to: ${company.remit_to}` : "",
    ``,
    `Please reference the invoice number and PO with payment.`,
  ].filter((l) => l !== null).join("\n");
  try {
    const r = await send({ from: settings.from, replyTo: settings.replyTo, to, subject, text, attachments: [{ filename, content: pdf }] });
    await log(pool(), { kind: "invoice", docId: invoiceId, customerId: inv.customer_id, to, subject, sha: sha256, status: "sent", messageId: r.messageId, userId: user.id });
  } catch (e: any) {
    await log(pool(), { kind: "invoice", docId: invoiceId, customerId: inv.customer_id, to, subject, sha: sha256, status: "failed", error: e.message, userId: user.id });
    throw new AppError(`The email to ${to.join(", ")} did not go out: ${e.message}`);
  }
  if (inv.status === "approved") await issueInvoice(user, invoiceId);
  return { to, subject };
}

/** Send every approved invoice of a customer's month that hasn't been emailed yet, one email per invoice. */
export async function emailMonth(user: SessionUser, customerId: string, month: string) {
  requirePerm(user, "issue_invoice");
  const rows = await q(`SELECT i.id, i.invoice_number FROM invoices i
                        WHERE i.customer_id=$1 AND i.finalized_at IS NOT NULL AND i.status NOT IN ('voided','corrected') AND i.period_start <= $3 AND i.period_end >= $2
                          AND NOT EXISTS (SELECT 1 FROM document_emails d WHERE d.doc_kind='invoice' AND d.doc_id=i.id AND d.status='sent')
                        ORDER BY i.snapshot->'equipment'->>'unit_number'`, [customerId, monthStart(month), monthEnd(month)]);
  const results: Array<{ invoice: string; ok: boolean; error?: string }> = [];
  for (const r of rows) {
    try { await emailInvoice(user, r.id); results.push({ invoice: r.invoice_number, ok: true }); }
    catch (e: any) { results.push({ invoice: r.invoice_number, ok: false, error: e.message }); }
  }
  await audit(pool(), user.id, "email_month", "customer", customerId, null, { month, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  return results;
}

export async function emailCredit(user: SessionUser, creditId: string) {
  requirePerm(user, "issue_invoice");
  const { send, settings } = sender();
  const c = await one(`SELECT c.*, i.invoice_number, i.po_number FROM credit_memos c JOIN invoices i ON i.id=c.invoice_id WHERE c.id=$1`, [creditId]);
  if (!c) throw new AppError("Credit memo not found", "not_found");
  const to = await recipients(pool(), c.customer_id);
  const { pdf, filename, sha256 } = await creditPdf(creditId);
  const subject = `Credit memo ${c.credit_number} | Invoice ${c.invoice_number} | PO ${c.po_number ?? "none"}`;
  const text = `Please find attached credit memo ${c.credit_number} for ${fmtUSD(c.total)} against invoice ${c.invoice_number} (PO ${c.po_number ?? "none"}).\n\nReason: ${c.reason}`;
  try {
    const r = await send({ from: settings.from, replyTo: settings.replyTo, to, subject, text, attachments: [{ filename, content: pdf }] });
    await log(pool(), { kind: "credit_memo", docId: creditId, customerId: c.customer_id, to, subject, sha: sha256, status: "sent", messageId: r.messageId, userId: user.id });
  } catch (e: any) {
    await log(pool(), { kind: "credit_memo", docId: creditId, customerId: c.customer_id, to, subject, sha: sha256, status: "failed", error: e.message, userId: user.id });
    throw new AppError(`The email to ${to.join(", ")} did not go out: ${e.message}`);
  }
  return { to, subject };
}

export async function emailsFor(kind: string, docId: string, db: Db = pool()) {
  return q(`SELECT d.*, u.name AS sent_by_name FROM document_emails d LEFT JOIN users u ON u.id=d.sent_by WHERE d.doc_kind=$1 AND d.doc_id=$2 ORDER BY d.sent_at DESC, d.id DESC`, [kind, docId], db);
}

/** Save where a customer's invoices are emailed. */
export async function setInvoiceEmails(user: SessionUser, customerId: string, list: string) {
  requirePerm(user, "edit_records");
  const addrs = parseAddresses(list);
  return tx(async (db) => {
    const before = await one(`SELECT invoice_emails FROM customer_billing_profiles WHERE customer_id=$1 FOR UPDATE`, [customerId], db);
    await db.query(`UPDATE customer_billing_profiles SET invoice_emails=$2 WHERE customer_id=$1`, [customerId, addrs.join(", ") || null]);
    await audit(db, user.id, "update", "invoice_emails", customerId, before, { invoice_emails: addrs.join(", ") });
    return addrs;
  });
}
