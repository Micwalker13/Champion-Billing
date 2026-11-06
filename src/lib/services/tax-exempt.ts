/**
 * Sales tax exemptions (agricultural, resale, interstate). A certificate on file for a customer, or
 * for one of its rental contracts, takes sales tax off every invoice whose billing period STARTS
 * within the certificate's dates (the same rule as fee exemptions). Equipment sales dated within it
 * are not taxed either. Equipment fees such as HET or TERP are not sales tax and are not affected.
 */
import { AppError, Db, audit, one, pool, q, tx } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { isIsoDate } from "../dates";
import { maxUploadMb } from "../limits";

export const TAX_EXEMPT_REASONS: Record<string, string> = {
  agricultural: "Agricultural (ag/timber number)",
  resale: "Resale",
  interstate: "Interstate (used out of state)",
};

export interface TaxExemption { id: string; contract_id: string | null; reason: string; certificate_number: string | null; effective_from: string; effective_to: string | null }

export async function activeTaxExemptions(customerId: string, db: Db = pool()): Promise<TaxExemption[]> {
  return q(`SELECT id, contract_id, reason, certificate_number, effective_from, effective_to FROM sales_tax_exemptions
            WHERE customer_id=$1 AND removed_at IS NULL ORDER BY effective_from`, [customerId], db);
}

/** The certificate that makes this date tax-free, preferring one for this contract. */
export function taxExemptionFor(list: TaxExemption[] | undefined, contractId: string | null, date: string): TaxExemption | null {
  const ok = (x: TaxExemption) => x.effective_from <= date && (!x.effective_to || x.effective_to >= date);
  return (list ?? []).find((x) => contractId && String(x.contract_id) === String(contractId) && ok(x))
    ?? (list ?? []).find((x) => !x.contract_id && ok(x)) ?? null;
}

export function exemptionLabel(x: { reason: string; certificate_number: string | null }) {
  return `${TAX_EXEMPT_REASONS[x.reason] ?? x.reason}${x.certificate_number ? `, certificate ${x.certificate_number}` : ""}`;
}

export async function listTaxExemptions(customerId: string) {
  return q(`SELECT x.id, x.contract_id, x.reason, x.certificate_number, x.effective_from, x.effective_to, x.notes, x.file_name, x.created_at, x.removed_at, x.removed_reason,
                   c.contract_number, u.name AS created_by_name
            FROM sales_tax_exemptions x LEFT JOIN rental_contracts c ON c.id=x.contract_id LEFT JOIN users u ON u.id=x.created_by
            WHERE x.customer_id=$1 ORDER BY (x.removed_at IS NULL) DESC, x.effective_from DESC`, [customerId]);
}

export async function addTaxExemption(user: SessionUser, customerId: string, input: {
  reason: string; certificate_number?: string; contract_id?: string | null; effective_from: string; effective_to?: string | null; notes?: string;
  file?: { filename: string; mime: string; content: Buffer } | null;
}) {
  requirePerm(user, "manage_tax_exempt");
  if (!TAX_EXEMPT_REASONS[input.reason]) throw new AppError("Pick why the customer is exempt: agricultural, resale or interstate.");
  const cert = String(input.certificate_number ?? "").trim().slice(0, 100) || null;
  const file = input.file && input.file.content.length ? input.file : null;
  if (!cert && !file) throw new AppError("Enter the certificate or permit number, or attach the certificate.");
  if (input.reason === "agricultural" && !cert) throw new AppError("Enter the customer's ag/timber registration number.");
  if (file) {
    if (file.content.length > maxUploadMb() * 1024 * 1024) throw new AppError(`Files must be under ${maxUploadMb()} MB.`);
    if (!["application/pdf", "image/png", "image/jpeg"].includes(file.mime)) throw new AppError("Attach the certificate as a PDF, PNG or JPG.");
  }
  if (!isIsoDate(input.effective_from)) throw new AppError("Enter the date the exemption starts.");
  const to = input.effective_to || null;
  if (to && (!isIsoDate(to) || to < input.effective_from)) throw new AppError("The end date must be on or after the start date.");
  return tx(async (db) => {
    const cust = await one(`SELECT id FROM customers WHERE id=$1`, [customerId], db);
    if (!cust) throw new AppError("Customer not found", "not_found");
    let contractId: string | null = null;
    if (input.contract_id) {
      const c = await one(`SELECT id FROM rental_contracts WHERE id=$1 AND customer_id=$2`, [input.contract_id, customerId], db);
      if (!c) throw new AppError("That rental contract isn't this customer's.");
      contractId = c.id;
    }
    const row = await one(
      `INSERT INTO sales_tax_exemptions(customer_id, contract_id, reason, certificate_number, effective_from, effective_to, notes, file_name, file_mime, file_content, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, contract_id, reason, certificate_number, effective_from, effective_to`,
      [customerId, contractId, input.reason, cert, input.effective_from, to, String(input.notes ?? "").trim().slice(0, 500) || null,
       file?.filename.slice(0, 200) ?? null, file?.mime ?? null, file?.content ?? null, user.id], db);
    await audit(db, user.id, "tax_exempt_add", "customer", customerId, null, row);
    return row;
  });
}

export async function removeTaxExemption(user: SessionUser, id: string, reason: string) {
  requirePerm(user, "manage_tax_exempt");
  const r = String(reason ?? "").trim();
  if (r.length < 3) throw new AppError("Say why the exemption is being removed.");
  return tx(async (db) => {
    const x = await one(`SELECT id, customer_id, removed_at FROM sales_tax_exemptions WHERE id=$1 FOR UPDATE`, [id], db);
    if (!x || x.removed_at) throw new AppError("Exemption not found.");
    await db.query(`UPDATE sales_tax_exemptions SET removed_at=now(), removed_by=$2, removed_reason=$3 WHERE id=$1`, [id, user.id, r]);
    await audit(db, user.id, "tax_exempt_remove", "customer", x.customer_id, { exemption_id: id }, { reason: r });
  });
}

export async function taxExemptionFile(id: string) {
  return one(`SELECT file_name, file_mime, file_content FROM sales_tax_exemptions WHERE id=$1 AND file_content IS NOT NULL`, [id]);
}
