import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PoolClient } from "pg";
import { one, tx } from "./db";
import { RPM_SAMPLE_UNITS } from "./sample-data";

export async function sampleAgreementPdf(contract: string, unit: string, customer: string, start: string) {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date(0)); doc.setModificationDate(new Date(0));
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  const lines = [
    "SAMPLE RENTAL AGREEMENT (placeholder for the signed original)",
    "", `Agreement: ${contract}`, `Customer: ${customer}`, `Equipment unit: ${unit}`, `Rental start: ${start}`,
    "", "Continuous rental. Billed by calendar month until the equipment is called off or returned.",
  ];
  lines.forEach((l, i) => p.drawText(l, { x: 50, y: 730 - i * 18, size: 12, font: f }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

export interface SeedOptions { password?: string; withAgreements?: boolean }

/** Development / test seed. Everything is clearly labeled SAMPLE or PLACEHOLDER. */
export async function seedDemo(opts: SeedOptions = {}) {
  const password = opts.password ?? "champion-demo-2026";
  const hash = await bcrypt.hash(password, 10);
  return tx(async (db: PoolClient) => {
    await db.query(`INSERT INTO company_settings(id,legal_name,address_line1,address_line2,city_state_zip,phone,email,remit_to,invoice_prefix,next_invoice_number,is_placeholder)
      VALUES (1,'Champion Equipment','[PLACEHOLDER] Street address',NULL,'[PLACEHOLDER] City, TX 00000','[PLACEHOLDER] (000) 000-0000','billing@championequipmentco.com','[PLACEHOLDER] Remit-to address','CE-INV-',100001,true)
      ON CONFLICT (id) DO NOTHING`);
    const users: Array<[string, string, string]> = [
      ["admin@champion.local", "Admin (sample)", "admin"],
      ["manager@champion.local", "Billing Manager (sample)", "billing_manager"],
      ["clerk@champion.local", "Billing Clerk (sample)", "billing_clerk"],
      ["viewer@champion.local", "Viewer (sample)", "viewer"],
    ];
    const ids: Record<string, string> = {};
    for (const [email, name, role] of users) {
      const u = await one(`INSERT INTO users(email,name,password_hash,role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [email, name, hash, role], db);
      ids[role] = u.id;
    }
    const existing = await one(`SELECT id FROM customers WHERE customer_code='RPMX'`, [], db);
    if (existing) return { ids, rpmId: existing.id };

    const rpm = await one(`INSERT INTO customers(customer_code,name,billing_address,email) VALUES ('RPMX','RPM xConstruction','[PLACEHOLDER] RPM xConstruction AP\n[PLACEHOLDER] Billing address\nTX','ap@rpm.example') RETURNING id`, [], db);
    await db.query(`INSERT INTO customer_billing_profiles(customer_id,billing_method,proration_policy,bill_off_rent_day,require_monthly_po,unique_po_per_unit,po_pattern,po_pattern_description,
        require_work_order,require_job_number,require_jobsite_address,require_contract_attachment,require_manual_approval,invoice_level_po,po_variance_tolerance_pct,po_variance_tolerance_amount,
        tax_rate,tax_rate_is_placeholder,payment_terms_days,payment_terms_label)
      VALUES ($1,'calendar_month','unapproved',true,true,true,'[456][0-9]{5}','Exactly 6 digits, starting with 4, 5 or 6',true,true,true,true,true,true,1.0,25.00,0.08250,true,30,'Net 30')`, [rpm.id]);
    const other = await one(`INSERT INTO customers(customer_code,name,billing_address) VALUES ('SAMPLE-OTHER','Sample Contractor LLC (sample)','123 Sample Rd\nHouston, TX 77001') RETURNING id`, [], db);
    await db.query(`INSERT INTO customer_billing_profiles(customer_id,billing_method,proration_policy,require_monthly_po,tax_rate,tax_rate_is_placeholder,payment_terms_days,payment_terms_label)
      VALUES ($1,'cycle_28','unapproved',false,0.08250,true,30,'Net 30')`, [other.id]);

    for (const u of RPM_SAMPLE_UNITS) {
      const eq = await one(`INSERT INTO equipment(unit_number,description,serial_number,make,model) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [u.unit, u.description, u.serial, u.make, u.model], db);
      const js = await one(`INSERT INTO jobsites(customer_id,name,address) VALUES ($1,$2,$3) RETURNING id`, [rpm.id, `RPM Job ${u.job}`, `[SAMPLE] Job ${u.job} site\nHouston, TX`], db);
      const c = await one(`INSERT INTO rental_contracts(contract_number,customer_id,jobsite_id,job_number,work_order_number,start_date,quipli_reference,internal_notes,created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [u.contract, rpm.id, js.id, u.job, u.wo, u.onRent, `Quipli ${u.contract} (reference only)`, u.real ? "Unit/PO/WO/job from Champion's example" : "SAMPLE data", ids.admin], db);
      await db.query(`INSERT INTO rental_contract_lines(contract_id,equipment_id,rate_amount,rate_basis,on_rent_date,billing_start_date) VALUES ($1,$2,$3,'monthly',$4,'2026-11-01')`,
        [c.id, eq.id, u.rate, u.onRent]);
      if (opts.withAgreements !== false) {
        const pdf = await sampleAgreementPdf(u.contract, u.unit, "RPM xConstruction", u.onRent);
        await db.query(`INSERT INTO contract_documents(contract_id,filename,mime_type,content,sha256,uploaded_by) VALUES ($1,$2,'application/pdf',$3,$4,$5)`,
          [c.id, `${u.contract}-agreement-SAMPLE.pdf`, pdf, createHash("sha256").update(pdf).digest("hex"), ids.admin]);
      }
    }
    // A returned unit that RPM might still list (exercise "already returned" flag)
    const eq = await one(`INSERT INTO equipment(unit_number,description,serial_number) VALUES ('SSL018877','Skid steer loader (returned, sample)','SAMPLE-SN-8877') RETURNING id`, [], db);
    const c = await one(`INSERT INTO rental_contracts(contract_number,customer_id,job_number,work_order_number,start_date,status) VALUES ('CE-09990',$1,'5276','170001','2026-03-01','returned') RETURNING id`, [rpm.id], db);
    await db.query(`INSERT INTO rental_contract_lines(contract_id,equipment_id,rate_amount,rate_basis,on_rent_date,billing_start_date,off_rent_date,returned_date,status) VALUES ($1,$2,2927.94,'monthly','2026-03-01','2026-03-01','2026-10-15','2026-10-15','returned')`, [c.id, eq.id]);
    // Non-RPM customer on 28-day billing to show RPM's rules are not forced on everyone.
    const eq2 = await one(`INSERT INTO equipment(unit_number,description,serial_number) VALUES ('TLB000501','Backhoe loader (sample)','SAMPLE-SN-501') RETURNING id`, [], db);
    const c2 = await one(`INSERT INTO rental_contracts(contract_number,customer_id,start_date) VALUES ('CE-20001',$1,'2026-10-06') RETURNING id`, [other.id], db);
    await db.query(`INSERT INTO rental_contract_lines(contract_id,equipment_id,rate_amount,rate_basis,on_rent_date,billing_start_date,delivery_charge) VALUES ($1,$2,2400.00,'cycle_28','2026-10-06','2026-10-06',250.00)`, [c2.id, eq2.id]);
    return { ids, rpmId: rpm.id, otherId: other.id };
  });
}
