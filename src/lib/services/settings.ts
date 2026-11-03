import { z } from "zod";
import { audit, one, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";

const schema = z.object({
  legal_name: z.string().trim().min(1).max(200),
  address_line1: z.string().trim().min(1).max(200),
  address_line2: z.string().trim().max(200).optional().nullable().transform((v) => v || null),
  city_state_zip: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(60).optional().nullable().transform((v) => v || null),
  email: z.string().trim().max(200).optional().nullable().transform((v) => v || null),
  remit_to: z.string().trim().max(500).optional().nullable().transform((v) => v || null),
  invoice_prefix: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9-]+$/, "Prefix may contain letters, digits and dashes"),
  next_invoice_number: z.coerce.number().int().min(1),
  is_placeholder: z.boolean(),
});

export async function updateCompanySettings(user: SessionUser, input: unknown) {
  requirePerm(user, "configure_billing");
  const s = schema.parse(input);
  return tx(async (db) => {
    const before = await one(`SELECT * FROM company_settings WHERE id=1 FOR UPDATE`, [], db);
    const used = await one(`SELECT count(*)::int AS n FROM invoices WHERE invoice_number IS NOT NULL`, [], db);
    if (used.n > 0 && s.next_invoice_number < Number(before.next_invoice_number))
      throw new Error("The next invoice number cannot go backwards once invoices have been numbered.");
    const after = await one(`UPDATE company_settings SET legal_name=$1,address_line1=$2,address_line2=$3,city_state_zip=$4,phone=$5,email=$6,remit_to=$7,invoice_prefix=$8,next_invoice_number=$9,is_placeholder=$10,updated_at=now() WHERE id=1 RETURNING *`,
      [s.legal_name, s.address_line1, s.address_line2, s.city_state_zip, s.phone, s.email, s.remit_to, s.invoice_prefix, s.next_invoice_number, s.is_placeholder], db);
    await audit(db, user.id, "update", "company_settings", 1, before, after);
    return after;
  });
}
