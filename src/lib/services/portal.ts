/**
 * Customer portal. A customer's own people sign in with a one-time emailed link (no passwords) and
 * see only their own company's rentals, finalized invoices and certificates. They can download
 * invoice PDFs and send requests (pickup, extension, certificate of insurance, question).
 *
 * Every query here is filtered by the signed-in portal user's customer. Requests change nothing by
 * themselves: an employee handles each one. Drafts and invoices still in review are never shown.
 */
import { createHash, randomBytes } from "node:crypto";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { isIsoDate } from "../dates";
import { dec, money } from "../money";
import { maxUploadMb } from "../limits";
import { emailEnabled, parseAddresses, sendPlainEmail } from "./email";
import { invoicePdf } from "./invoices";
import { uploadCoi } from "./insurance";

export const PORTAL_COOKIE = "cb_portal";
export const PORTAL_SESSION_HOURS = 12;
const LINK_MINUTES = 30;
const MAX_LINKS_PER_HOUR = 5;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export interface PortalUser { id: string; customer_id: string; email: string; name: string; customer_name: string }

export const REQUEST_LABELS: Record<string, string> = { pickup: "Pickup / call off", extension: "Extend rental", coi: "Insurance certificate", question: "Question" };
export const REQUEST_STATUS_LABELS: Record<string, string> = { open: "Open", done: "Done", declined: "Declined" };
const VISIBLE = `i.finalized_at IS NOT NULL AND i.status NOT IN ('draft','pending_review','rejected')`;

// ───────────────────────── Staff: who has access ─────────────────────────
export async function listPortalUsers(customerId: string, db: Db = pool()) {
  return q(`SELECT p.id, p.email, p.name, p.active, p.created_at, p.last_login_at, u.name AS invited_by_name
            FROM portal_users p LEFT JOIN users u ON u.id=p.invited_by WHERE p.customer_id=$1 ORDER BY p.active DESC, p.name`, [customerId], db);
}

/** Give someone at the customer access and email them a sign-in link. */
export async function invitePortalUser(user: SessionUser, customerId: string, input: { email: string; name: string }, origin: string) {
  requirePerm(user, "manage_portal");
  const [email] = parseAddresses(input.email);
  if (!email || String(input.email).split(/[,;\s]+/).filter(Boolean).length !== 1) throw new AppError("Enter one email address.");
  const name = String(input.name ?? "").trim();
  if (name.length < 2) throw new AppError("Enter the person's name.");
  if (!emailEnabled()) throw new AppError("Email isn't set up yet, so a sign-in link can't be sent. An administrator adds the mail server settings in Vercel first.");
  const pu = await tx(async (db) => {
    const cust = await one(`SELECT id, name FROM customers WHERE id=$1 AND active`, [customerId], db);
    if (!cust) throw new AppError("Customer not found", "not_found");
    const existing = await one(`SELECT * FROM portal_users WHERE email=$1 FOR UPDATE`, [email], db);
    if (existing && String(existing.customer_id) !== String(customerId)) throw new AppError("That email already has portal access for a different customer.");
    const row = existing
      ? await one(`UPDATE portal_users SET active=true, name=$2 WHERE id=$1 RETURNING *`, [existing.id, name], db)
      : await one(`INSERT INTO portal_users(customer_id,email,name,invited_by) VALUES ($1,$2,$3,$4) RETURNING *`, [customerId, email, name, user.id], db);
    await audit(db, user.id, existing ? "portal_reinvite" : "portal_invite", "portal_user", row.id, existing ? { active: existing.active } : null, { customer_id: customerId, email, name });
    return { ...row, customer_name: cust.name };
  });
  await sendLink(pu, origin, true);
  return pu;
}

export async function setPortalUserActive(user: SessionUser, portalUserId: string, active: boolean) {
  requirePerm(user, "manage_portal");
  return tx(async (db) => {
    const before = await one(`SELECT * FROM portal_users WHERE id=$1 FOR UPDATE`, [portalUserId], db);
    if (!before) throw new AppError("Portal user not found", "not_found");
    await db.query(`UPDATE portal_users SET active=$2 WHERE id=$1`, [portalUserId, active]);
    if (!active) {
      await db.query(`DELETE FROM portal_sessions WHERE portal_user_id=$1`, [portalUserId]);
      await db.query(`UPDATE portal_login_tokens SET used_at=now() WHERE portal_user_id=$1 AND used_at IS NULL`, [portalUserId]);
    }
    await audit(db, user.id, active ? "portal_enable" : "portal_disable", "portal_user", portalUserId, { active: before.active }, { active });
  });
}

// ───────────────────────── Sign-in ─────────────────────────
async function sendLink(pu: { id: string; email: string; name: string; customer_name?: string }, origin: string, invite: boolean) {
  const token = randomBytes(32).toString("base64url");
  await q(`INSERT INTO portal_login_tokens(portal_user_id, token_hash, expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`, [pu.id, hash(token), String(LINK_MINUTES)]);
  const url = `${origin.replace(/\/$/, "")}/portal/auth?token=${token}`;
  const company = (await one(`SELECT legal_name FROM company_settings WHERE id=1`))?.legal_name ?? "Champion Equipment";
  const text = [
    `Hi ${pu.name},`, "",
    invite ? `${company} has given you access to its customer portal, where you can see your rentals and invoices and send requests.` : `Here is your sign-in link for the ${company} customer portal.`, "",
    `Sign in: ${url}`, "",
    `This link works once and expires in ${LINK_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
  ].join("\n");
  await sendPlainEmail(pu.email, `${company} customer portal sign-in`, text);
}

/**
 * Email a sign-in link if the address has access. Always answers the same way, so the form can't be
 * used to find out who has access. At most 5 links per address per hour.
 */
export async function requestPortalLink(emailInput: string, origin: string) {
  let email: string | undefined;
  try { [email] = parseAddresses(emailInput); } catch { return; }
  if (!email) return;
  const pu = await one(`SELECT p.*, c.name AS customer_name FROM portal_users p JOIN customers c ON c.id=p.customer_id WHERE p.email=$1 AND p.active AND c.active`, [email]);
  if (!pu) return;
  const recent = await one(`SELECT count(*)::int AS n FROM portal_login_tokens WHERE portal_user_id=$1 AND created_at > now() - interval '1 hour'`, [pu.id]);
  if (recent.n >= MAX_LINKS_PER_HOUR) return;
  try { await sendLink(pu, origin, false); } catch (e) { console.error("portal link email", e); }
}

/** Use a sign-in link once. Returns a new session token, or null if the link is no good. */
export async function consumePortalLink(token: string): Promise<{ token: string; expires: Date } | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  return tx(async (db) => {
    const t = await one(`SELECT t.*, p.active FROM portal_login_tokens t JOIN portal_users p ON p.id=t.portal_user_id
                         WHERE t.token_hash=$1 FOR UPDATE OF t`, [hash(token)], db);
    if (!t || t.used_at || new Date(t.expires_at) < new Date() || !t.active) return null;
    await db.query(`UPDATE portal_login_tokens SET used_at=now() WHERE id=$1`, [t.id]);
    const session = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + PORTAL_SESSION_HOURS * 3600_000);
    await db.query(`INSERT INTO portal_sessions(token_hash, portal_user_id, expires_at) VALUES ($1,$2,$3)`, [hash(session), t.portal_user_id, expires]);
    await db.query(`UPDATE portal_users SET last_login_at=now() WHERE id=$1`, [t.portal_user_id]);
    await db.query(`DELETE FROM portal_sessions WHERE expires_at < now()`);
    await db.query(`DELETE FROM portal_login_tokens WHERE expires_at < now() - interval '30 days'`);
    await audit(db, null, "portal_login", "portal_user", t.portal_user_id, null, null);
    return { token: session, expires };
  });
}

export async function portalUserForToken(token: string | undefined | null, db: Db = pool()): Promise<PortalUser | null> {
  if (!token) return null;
  return one(`SELECT p.id, p.customer_id, p.email, p.name, c.name AS customer_name
              FROM portal_sessions s JOIN portal_users p ON p.id=s.portal_user_id JOIN customers c ON c.id=p.customer_id
              WHERE s.token_hash=$1 AND s.expires_at > now() AND p.active AND c.active`, [hash(token)], db);
}

export async function portalLogout(token: string | undefined | null) {
  if (token) await q(`DELETE FROM portal_sessions WHERE token_hash=$1`, [hash(token)]);
}

// ───────────────────────── What the customer sees ─────────────────────────
export async function portalOverview(pu: PortalUser, db: Db = pool()) {
  const [rentals, invoices, cois, requests] = await Promise.all([
    q(`SELECT l.id, l.status, l.on_rent_date, l.off_rent_date, l.rate_amount, l.rate_basis, c.contract_number, e.unit_number, e.description, j.address AS jobsite
       FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id JOIN equipment e ON e.id=l.equipment_id LEFT JOIN jobsites j ON j.id=c.jobsite_id
       WHERE c.customer_id=$1 AND l.status IN ('active','off_rent') ORDER BY l.on_rent_date, e.unit_number`, [pu.customer_id], db),
    q(`SELECT i.id, i.invoice_number, i.invoice_date, i.due_date, i.po_number, i.period_start, i.period_end, i.total, i.amount_paid, i.amount_credited, i.status,
              i.snapshot->'equipment'->>'unit_number' AS unit_number
       FROM invoices i WHERE i.customer_id=$1 AND ${VISIBLE} ORDER BY i.invoice_date DESC NULLS LAST, i.id DESC LIMIT 200`, [pu.customer_id], db),
    q(`SELECT insurer, policy_number, effective_on, expires_on FROM customer_insurance_certificates WHERE customer_id=$1 AND removed_at IS NULL ORDER BY expires_on DESC`, [pu.customer_id], db),
    q(`SELECT r.id, r.kind, r.requested_date, r.message, r.status, r.response, r.created_at, r.handled_at, e.unit_number
       FROM portal_requests r LEFT JOIN rental_contract_lines l ON l.id=r.contract_line_id LEFT JOIN equipment e ON e.id=l.equipment_id
       WHERE r.customer_id=$1 ORDER BY r.created_at DESC LIMIT 50`, [pu.customer_id], db),
  ]);
  const withBalance = invoices.map((i: any) => {
    const balance = ["voided", "corrected"].includes(i.status) ? dec(0) : dec(i.total).sub(i.amount_paid).sub(i.amount_credited);
    return { ...i, balance: money(balance.lt(0) ? 0 : balance) };
  });
  const open = withBalance.reduce((s: any, i: any) => s.add(i.balance), dec(0));
  return { rentals, invoices: withBalance, cois, requests, openBalance: money(open) };
}

/** An invoice PDF, only if it belongs to the signed-in customer and is finalized. */
export async function portalInvoicePdf(pu: PortalUser, invoiceId: string) {
  if (!/^\d+$/.test(invoiceId)) throw new AppError("Not found", "not_found");
  const inv = await one(`SELECT i.id FROM invoices i WHERE i.id=$1 AND i.customer_id=$2 AND ${VISIBLE}`, [invoiceId, pu.customer_id]);
  if (!inv) throw new AppError("Not found", "not_found");
  const r = await invoicePdf(invoiceId);
  await audit(pool(), null, "portal_download_pdf", "invoice", invoiceId, null, { portal_user_id: pu.id, sha256: r.sha256 });
  return r;
}

export async function submitPortalRequest(pu: PortalUser, input: {
  kind: string; contract_line_id?: string | null; requested_date?: string | null; message?: string | null;
  file?: { filename: string; mime: string; content: Buffer } | null; coi_insurer?: string | null; coi_policy?: string | null; coi_effective_on?: string | null; coi_expires_on?: string | null;
}) {
  const kind = input.kind;
  if (!["pickup", "extension", "coi", "question"].includes(kind)) throw new AppError("Pick what you need.");
  const message = String(input.message ?? "").trim().slice(0, 2000) || null;
  let lineId: string | null = null, date: string | null = null;
  if (kind === "pickup" || kind === "extension") {
    const l = await one(`SELECT l.id FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id
                         WHERE l.id=$1 AND c.customer_id=$2 AND l.status IN ('active','off_rent')`, [String(input.contract_line_id ?? "0").replace(/\D/g, "") || "0", pu.customer_id]);
    if (!l) throw new AppError("Pick the machine.");
    lineId = l.id;
    if (!input.requested_date || !isIsoDate(input.requested_date)) throw new AppError(kind === "pickup" ? "Pick the date the machine can be picked up." : "Pick the new end date.");
    date = input.requested_date;
  }
  if (kind === "question" && !message) throw new AppError("Type your question.");
  let file = null as null | { filename: string; mime: string; content: Buffer };
  if (kind === "coi") {
    file = input.file ?? null;
    if (!file || !file.content.length) throw new AppError("Attach the certificate (PDF, PNG or JPG).");
    if (file.content.length > maxUploadMb() * 1024 * 1024) throw new AppError(`Files must be under ${maxUploadMb()} MB.`);
    if (!["application/pdf", "image/png", "image/jpeg"].includes(file.mime)) throw new AppError("Upload the certificate as a PDF, PNG or JPG.");
    for (const d of [input.coi_effective_on, input.coi_expires_on]) if (d && !isIsoDate(d)) throw new AppError("Enter the certificate dates.");
  }
  const row = await one(
    `INSERT INTO portal_requests(customer_id, portal_user_id, kind, contract_line_id, requested_date, message, file_name, file_mime, file_content, coi_insurer, coi_policy, coi_effective_on, coi_expires_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [pu.customer_id, pu.id, kind, lineId, date, message, file?.filename.slice(0, 200) ?? null, file?.mime ?? null, file?.content ?? null,
     String(input.coi_insurer ?? "").trim().slice(0, 200) || null, String(input.coi_policy ?? "").trim().slice(0, 100) || null, input.coi_effective_on || null, input.coi_expires_on || null]);
  await audit(pool(), null, "portal_request", "portal_request", row.id, null, { portal_user_id: pu.id, kind, contract_line_id: lineId, requested_date: date });
  return row;
}

// ───────────────────────── Staff: requests ─────────────────────────
export async function listPortalRequests(f: { status?: string | null } = {}, db: Db = pool()) {
  return q(`SELECT r.id, r.kind, r.requested_date, r.message, r.status, r.response, r.created_at, r.handled_at, r.customer_id, r.contract_line_id,
                   r.file_name, r.coi_insurer, r.coi_policy, r.coi_effective_on, r.coi_expires_on,
                   cu.name AS customer_name, p.name AS portal_user_name, p.email AS portal_user_email, e.unit_number, c.contract_number, u.name AS handled_by_name
            FROM portal_requests r JOIN customers cu ON cu.id=r.customer_id JOIN portal_users p ON p.id=r.portal_user_id
            LEFT JOIN rental_contract_lines l ON l.id=r.contract_line_id LEFT JOIN rental_contracts c ON c.id=l.contract_id LEFT JOIN equipment e ON e.id=l.equipment_id
            LEFT JOIN users u ON u.id=r.handled_by
            WHERE ($1::text IS NULL OR r.status=$1) ORDER BY (r.status='open') DESC, r.created_at DESC LIMIT 200`, [f.status ?? null], db);
}

export async function openPortalRequestCount(db: Db = pool()) {
  return (await one(`SELECT count(*)::int AS n FROM portal_requests WHERE status='open'`, [], db)).n as number;
}

/** Close a request with a note the customer sees. Staff make the actual change (call-off, extension) on the rental. */
export async function closePortalRequest(user: SessionUser, id: string, input: { status: "done" | "declined"; response: string }) {
  requirePerm(user, "edit_records");
  if (!["done", "declined"].includes(input.status)) throw new AppError("Pick done or declined.");
  const response = String(input.response ?? "").trim();
  if (input.status === "declined" && response.length < 3) throw new AppError("Tell the customer why.");
  return tx(async (db) => {
    const r = await one(`SELECT * FROM portal_requests WHERE id=$1 FOR UPDATE`, [id], db);
    if (!r || r.status !== "open") throw new AppError("Only an open request can be closed.");
    await db.query(`UPDATE portal_requests SET status=$2, response=$3, handled_by=$4, handled_at=now() WHERE id=$1`, [id, input.status, response || null, user.id]);
    await audit(db, user.id, "portal_request_" + input.status, "portal_request", id, { status: "open" }, { status: input.status, response });
  });
}

/** Accept a certificate the customer sent: file it on the customer (an employee confirms the details). */
export async function acceptPortalCoi(user: SessionUser, id: string, input: { insurer: string; policy_number?: string; effective_on: string; expires_on: string }) {
  requirePerm(user, "edit_records");
  const r = await one(`SELECT * FROM portal_requests WHERE id=$1`, [id]);
  if (!r || r.kind !== "coi" || r.status !== "open") throw new AppError("Only an open certificate request can be accepted.");
  const coi = await uploadCoi(user, r.customer_id, { ...input, file: { filename: r.file_name, mime: r.file_mime, content: r.file_content } });
  await closePortalRequest(user, id, { status: "done", response: `Certificate from ${coi.insurer} filed, good through ${coi.expires_on}.` });
  return coi;
}

export async function portalRequestFile(id: string) {
  return one(`SELECT file_name, file_mime, file_content FROM portal_requests WHERE id=$1 AND file_content IS NOT NULL`, [id]);
}
