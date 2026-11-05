/**
 * Credit limits and holds. A customer can have a dollar limit on what they owe (open invoices and
 * open equipment sales), and can be put on credit hold. Either one stops a NEW rental from being
 * written for them, unless a manager overrides it with a reason (recorded in the audit log).
 *
 * Nothing here touches existing rentals, Quipli agreements, invoices or amounts. Rentals brought in
 * from a Quipli file are existing agreements, so they are never blocked.
 */
import { AppError, Db, audit, one, pool, tx } from "../db";
import { SessionUser, can, requirePerm } from "../permissions";
import { dec, fmtUSD, money } from "../money";
import { openInvoices } from "./reports";

export interface CreditStatus {
  limit: string | null; hold: boolean; note: string | null;
  owed: string; pastDue: string; available: string | null;
  /** Why a new rental would be stopped, or null when it wouldn't. */
  blocked: string | null;
}

export async function creditStatus(customerId: string, db: Db = pool()): Promise<CreditStatus> {
  const c = await one(`SELECT id, name, credit_limit, credit_hold, credit_note FROM customers WHERE id=$1`, [customerId], db);
  if (!c) throw new AppError("Customer not found", "not_found");
  const open = await openInvoices(undefined, customerId, db);
  const owed = open.reduce((s, i) => s.add(i.balance), dec(0));
  const pastDue = open.filter((i) => i.days_past_due > 0).reduce((s, i) => s.add(i.balance), dec(0));
  const available = c.credit_limit == null ? null : dec(c.credit_limit).sub(owed);
  let blocked: string | null = null;
  if (c.credit_hold) blocked = `${c.name} is on credit hold${c.credit_note ? ` (${c.credit_note})` : ""}.`;
  else if (available && available.lt(0)) blocked = `${c.name} owes ${fmtUSD(owed)}, over its ${fmtUSD(c.credit_limit)} credit limit.`;
  return { limit: c.credit_limit, hold: c.credit_hold, note: c.credit_note, owed: money(owed), pastDue: money(pastDue), available: available ? money(available) : null, blocked };
}

export async function setCreditTerms(user: SessionUser, customerId: string, input: { credit_limit: string; credit_hold: boolean; credit_note: string }) {
  requirePerm(user, "manage_credit");
  const raw = String(input.credit_limit ?? "").replace(/[$,\s]/g, "");
  let limit: string | null = null;
  if (raw) {
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new AppError("Enter the credit limit as a dollar amount, or leave it blank for no limit.");
    limit = money(dec(raw));
  }
  const note = String(input.credit_note ?? "").trim().slice(0, 500) || null;
  if (input.credit_hold && !note) throw new AppError("Say why the customer is on credit hold.");
  return tx(async (db) => {
    const before = await one(`SELECT credit_limit, credit_hold, credit_note FROM customers WHERE id=$1 FOR UPDATE`, [customerId], db);
    if (!before) throw new AppError("Customer not found", "not_found");
    const after = await one(`UPDATE customers SET credit_limit=$2, credit_hold=$3, credit_note=$4 WHERE id=$1 RETURNING credit_limit, credit_hold, credit_note`, [customerId, limit, !!input.credit_hold, note], db);
    await audit(db, user.id, "credit_terms", "customer", customerId, before, after);
    return after;
  });
}

/**
 * Called before a new rental is written. Stops it when the customer is on hold or over the limit,
 * unless a manager gives an override reason, which is audited.
 */
export async function checkCreditForNewRental(db: Db, user: SessionUser, customerId: string, overrideReason?: string | null) {
  const s = await creditStatus(customerId, db);
  if (!s.blocked) return null;
  const reason = String(overrideReason ?? "").trim();
  if (!reason) throw new AppError(`${s.blocked} A billing manager or administrator can write the rental anyway by giving a reason.`, "credit_blocked");
  if (!can(user, "override_validation")) throw new AppError(`${s.blocked} Only a billing manager or administrator can override a credit block.`, "credit_blocked");
  if (reason.length < 5) throw new AppError("Give a short reason for overriding the credit block.");
  await audit(db, user.id, "credit_override", "customer", customerId, null, { blocked: s.blocked, reason });
  return s.blocked;
}
