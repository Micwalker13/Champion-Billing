/**
 * Certificates of insurance (COI) and the damage waiver (RDW) choice.
 *
 * Rule (Michael, 2026-11-05): each customer either buys Champion's damage waiver or keeps a COI on
 * file. A customer set to "COI" whose certificate is missing or doesn't cover the whole billing
 * period is billed the damage waiver for that period, and the invoice check says why.
 */
import { createHash } from "node:crypto";
import { maxUploadMb } from "../limits";
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { addDays, isIsoDate, todayCentral } from "../dates";

export type RdwChoice = "rdw" | "coi";
export interface Coi { id: string; insurer: string; policy_number: string | null; effective_on: string; expires_on: string; filename: string }

/** The certificate on file covering every day of [start, end], or null. Removed certificates never count. */
export function coiCovering(cois: Coi[], start: string, end: string): Coi | null {
  const fits = cois.filter((c) => c.effective_on <= start && c.expires_on >= end);
  fits.sort((a, b) => (a.expires_on < b.expires_on ? 1 : -1));
  return fits[0] ?? null;
}

export type RdwDecision =
  | { status: "off" }                                 // no waiver percent set for this customer
  | { status: "billed"; reason: "rdw" }               // customer chose the waiver
  | { status: "billed"; reason: "no_coi" | "coi_gap"; latest?: Coi | null } // chose COI, nothing covering the period
  | { status: "waived_coi"; coi: Coi }                // a certificate covers the period
  | { status: "waived_line" };                        // waived on this one rental

export function rdwDecision(input: { pct: string | null; choice: RdwChoice; lineWaived: boolean; cois: Coi[]; start: string; end: string }): RdwDecision {
  if (!input.pct) return { status: "off" };
  if (input.lineWaived) return { status: "waived_line" };
  if (input.choice === "rdw") return { status: "billed", reason: "rdw" };
  const cov = coiCovering(input.cois, input.start, input.end);
  if (cov) return { status: "waived_coi", coi: cov };
  const latest = [...input.cois].sort((a, b) => (a.expires_on < b.expires_on ? 1 : -1))[0] ?? null;
  return { status: "billed", reason: latest ? "coi_gap" : "no_coi", latest };
}

export async function activeCois(customerId: string, db: Db = pool()): Promise<Coi[]> {
  return q<Coi>(`SELECT id, insurer, policy_number, effective_on, expires_on, filename FROM customer_insurance_certificates
                 WHERE customer_id=$1 AND removed_at IS NULL ORDER BY expires_on DESC, id DESC`, [customerId], db);
}

export async function listCois(customerId: string) {
  return q(`SELECT c.id, c.insurer, c.policy_number, c.effective_on, c.expires_on, c.filename, c.uploaded_at, u.name AS uploaded_by_name,
                   c.removed_at, c.removed_reason, r.name AS removed_by_name
            FROM customer_insurance_certificates c LEFT JOIN users u ON u.id=c.uploaded_by LEFT JOIN users r ON r.id=c.removed_by
            WHERE c.customer_id=$1 ORDER BY (c.removed_at IS NULL) DESC, c.expires_on DESC, c.id DESC`, [customerId]);
}

/** Customers set to COI whose newest certificate is missing, expired, or expires within `days`. */
export async function coiAlerts(days = 30) {
  const today = todayCentral();
  const soon = addDays(today, days);
  return q(`SELECT cu.id, cu.name, cu.customer_code, MAX(c.expires_on) AS expires_on
            FROM customers cu JOIN customer_billing_profiles p ON p.customer_id=cu.id
            LEFT JOIN customer_insurance_certificates c ON c.customer_id=cu.id AND c.removed_at IS NULL
            WHERE cu.active AND p.rdw_choice='coi'
            GROUP BY cu.id HAVING MAX(c.expires_on) IS NULL OR MAX(c.expires_on) <= $1
            ORDER BY MAX(c.expires_on) NULLS FIRST, cu.name`, [soon]);
}

export async function setRdwChoice(user: SessionUser, customerId: string, choice: string) {
  requirePerm(user, "configure_billing");
  if (choice !== "rdw" && choice !== "coi") throw new AppError("Choose damage waiver or certificate of insurance.");
  return tx(async (db) => {
    const before = await one(`SELECT rdw_choice FROM customer_billing_profiles WHERE customer_id=$1 FOR UPDATE`, [customerId], db);
    if (!before) throw new AppError("Billing profile not found", "not_found");
    await db.query(`UPDATE customer_billing_profiles SET rdw_choice=$2, updated_at=now() WHERE customer_id=$1`, [customerId, choice]);
    await audit(db, user.id, "update", "rdw_choice", customerId, before, { rdw_choice: choice });
  });
}

export async function uploadCoi(user: SessionUser, customerId: string, input: {
  insurer: string; policy_number?: string; effective_on: string; expires_on: string; file: { filename: string; mime: string; content: Buffer };
}) {
  requirePerm(user, "edit_records");
  const insurer = String(input.insurer ?? "").trim();
  if (insurer.length < 2) throw new AppError("Enter the insurance company's name.");
  if (!isIsoDate(input.effective_on) || !isIsoDate(input.expires_on)) throw new AppError("Enter the certificate's start and expiration dates.");
  if (input.expires_on < input.effective_on) throw new AppError("The expiration date is before the start date.");
  const f = input.file;
  if (!f || f.content.length === 0) throw new AppError("Attach the certificate (PDF, PNG or JPG).");
  if (f.content.length > maxUploadMb() * 1024 * 1024) throw new AppError(`Files must be under ${maxUploadMb()} MB.`);
  if (!["application/pdf", "image/png", "image/jpeg"].includes(f.mime)) throw new AppError("Upload the certificate as a PDF, PNG or JPG.");
  const sha = createHash("sha256").update(f.content).digest("hex");
  return tx(async (db) => {
    const cust = await one(`SELECT id FROM customers WHERE id=$1`, [customerId], db);
    if (!cust) throw new AppError("Customer not found", "not_found");
    const row = await one(`INSERT INTO customer_insurance_certificates(customer_id, insurer, policy_number, effective_on, expires_on, filename, mime_type, content, sha256, uploaded_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, insurer, policy_number, effective_on, expires_on, filename`,
      [customerId, insurer.slice(0, 200), String(input.policy_number ?? "").trim().slice(0, 100) || null, input.effective_on, input.expires_on,
       f.filename.slice(0, 200), f.mime, f.content, sha, user.id], db);
    await audit(db, user.id, "upload", "insurance_certificate", row.id, null, { customerId, ...row, sha256: sha });
    return row as Coi;
  });
}

export async function removeCoi(user: SessionUser, coiId: string, reason: string) {
  requirePerm(user, "edit_records");
  if (String(reason ?? "").trim().length < 5) throw new AppError("Enter why this certificate is being removed.");
  return tx(async (db) => {
    const before = await one(`SELECT id, customer_id, insurer, expires_on, removed_at FROM customer_insurance_certificates WHERE id=$1 FOR UPDATE`, [coiId], db);
    if (!before) throw new AppError("Certificate not found", "not_found");
    if (before.removed_at) throw new AppError("That certificate was already removed.");
    await db.query(`UPDATE customer_insurance_certificates SET removed_at=now(), removed_by=$2, removed_reason=$3 WHERE id=$1`, [coiId, user.id, reason.trim()]);
    await audit(db, user.id, "remove", "insurance_certificate", coiId, before, null, reason.trim());
    return before.customer_id as string;
  });
}
