// Creates the RPM xConstruction customer with its billing rules (no rentals, no sample data).
// Usage: npm run setup-rpm -- "<billing address>"   (address can be edited later in the app)
import { one, tx } from "../src/lib/db";
try { process.loadEnvFile(".env"); } catch {}
(async () => {
  const address = process.argv[2] || "[PLACEHOLDER] RPM xConstruction billing address";
  const r = await tx(async (db) => {
    const existing = await one(`SELECT id FROM customers WHERE customer_code='RPMX'`, [], db);
    if (existing) return { id: existing.id, created: false };
    const c = await one(`INSERT INTO customers(customer_code,name,billing_address) VALUES ('RPMX','RPM xConstruction',$1) RETURNING id`, [address], db);
    await db.query(`INSERT INTO customer_billing_profiles(customer_id,billing_method,proration_policy,bill_off_rent_day,require_monthly_po,unique_po_per_unit,po_pattern,po_pattern_description,
        require_work_order,require_job_number,require_jobsite_address,require_contract_attachment,require_manual_approval,invoice_level_po,po_variance_tolerance_pct,po_variance_tolerance_amount,
        tax_rate,tax_rate_is_placeholder,payment_terms_days,payment_terms_label)
      VALUES ($1,'calendar_month','unapproved',true,true,true,'[456][0-9]{5}','Exactly 6 digits, starting with 4, 5 or 6',true,true,true,true,true,true,1.0,25.00,0.08250,true,30,'Net 30')`, [c.id]);
    await db.query(`INSERT INTO audit_log(action,entity,entity_id,note) VALUES ('create','customer',$1,'setup-rpm script')`, [c.id]);
    return { id: c.id, created: true };
  });
  console.log(r.created ? `RPM xConstruction created (id ${r.id}). Confirm tax rate, terms and proration in the app.` : `RPM xConstruction already exists (id ${r.id}); nothing changed.`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
