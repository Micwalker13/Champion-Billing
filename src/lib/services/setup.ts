import { createHash, timingSafeEqual } from "node:crypto";
import { AppError, Db, audit, one, tx } from "../db";
import { createUserInTx } from "./auth";

/** Creates RPM xConstruction with its billing rules. Idempotent: does nothing if it exists. */
export async function setupRpm(db: Db, address?: string | null, actorId: string | null = null) {
  const existing = await one(`SELECT id FROM customers WHERE customer_code='RPMX'`, [], db);
  if (existing) return { id: existing.id as string, created: false };
  const c = await one(`INSERT INTO customers(customer_code,name,billing_address) VALUES ('RPMX','RPM xConstruction',$1) RETURNING id`,
    [address?.trim() || "[PLACEHOLDER] RPM xConstruction billing address"], db);
  await db.query(`INSERT INTO customer_billing_profiles(customer_id,billing_method,proration_policy,bill_off_rent_day,require_monthly_po,unique_po_per_unit,po_pattern,po_pattern_description,
      require_work_order,require_job_number,require_jobsite_address,require_contract_attachment,require_manual_approval,invoice_level_po,po_variance_tolerance_pct,po_variance_tolerance_amount,
      tax_rate,tax_rate_is_placeholder,payment_terms_days,payment_terms_label)
    VALUES ($1,'calendar_month','unapproved',true,true,true,'[456][0-9]{5}','Exactly 6 digits, starting with 4, 5 or 6',true,true,true,true,true,true,1.0,25.00,0.08250,true,30,'Net 30')`, [c.id]);
  await audit(db, actorId, "create", "customer", c.id, null, { customer_code: "RPMX", note: "RPM billing rules set up" });
  return { id: c.id as string, created: true };
}

export async function ensureCompanySettings(db: Db) {
  await db.query(`INSERT INTO company_settings(id,legal_name,address_line1,city_state_zip) VALUES (1,'Champion Equipment','[PLACEHOLDER] Street address','[PLACEHOLDER] City, TX') ON CONFLICT (id) DO NOTHING`);
}

export async function needsSetup(): Promise<boolean> {
  const r = await one(`SELECT NOT EXISTS (SELECT 1 FROM users) AS empty`);
  return !!r?.empty;
}

function tokenMatches(given: string, expected: string) {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(given), h(expected));
}

/**
 * First-run setup for hosts without a terminal (Vercel). Works only while there are no users,
 * and only with the SETUP_TOKEN set in the host's environment, so a stranger who finds the page
 * first cannot claim the admin account.
 */
export async function firstRunSetup(input: { token: string; name: string; email: string; password: string; confirm: string; createRpm: boolean; rpmAddress?: string }) {
  const expected = process.env.SETUP_TOKEN ?? "";
  if (expected.length < 16) throw new AppError("Setup is turned off. Set SETUP_TOKEN (16+ characters) in the hosting environment, redeploy, then try again.");
  if (!tokenMatches(input.token.trim(), expected)) throw new AppError("The setup code is wrong.");
  if (input.password !== input.confirm) throw new AppError("The two passwords don't match.");
  return tx(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(727001)`); // one setup at a time
    const any = await one(`SELECT 1 FROM users LIMIT 1`, [], db);
    if (any) throw new AppError("Setup has already been done. Sign in instead.");
    await ensureCompanySettings(db);
    const u = await createUserInTx(db, { email: input.email, name: input.name, password: input.password, role: "admin" });
    const rpm = input.createRpm ? await setupRpm(db, input.rpmAddress, u.id) : null;
    return { user: u, rpm };
  });
}
