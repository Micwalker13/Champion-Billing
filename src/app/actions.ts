"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { getUser } from "@/lib/session";
import { SessionUser, requirePerm } from "@/lib/permissions";
import { SESSION_COOKIE, createUser, login, logout, setUserActive } from "@/lib/services/auth";
import { addContractDocument, approveProrationPolicy, changeLineStatus, createCustomer, createEquipment, createRental, updateBillingProfile, updateCustomer, updateRentalTerms } from "@/lib/services/records";
import { assignPo, removePoAssignment } from "@/lib/services/pos";
import { approveInvoice, DuplicateInvoiceError, generateInvoice, generateMonthForCustomer, issueInvoice, overrideCheck, recordPayment, refreshInvoice, rejectInvoice, reviseInvoice, submitForReview, voidInvoice } from "@/lib/services/invoices";
import { applyImportBatch, approveCleanRows, cancelImportBatch, createImportBatch, decideImportRow, editImportRow } from "@/lib/services/imports";
import { updateCompanySettings } from "@/lib/services/settings";
import { firstRunSetup } from "@/lib/services/setup";
import { ProrationPolicy } from "@/lib/billing";
import { q } from "@/lib/db";
import { applyRentalBatch, cancelRentalBatch, uploadRentalFile } from "@/lib/services/rental-import";

const str = (fd: FormData, k: string) => { const v = fd.get(k); return typeof v === "string" ? v : ""; };
const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";

function safeBack(fd: FormData, fallback: string) {
  const b = str(fd, "back");
  return b.startsWith("/") && !b.startsWith("//") ? b : fallback;
}
function withParam(url: string, k: string, v: string) {
  const [path, query = ""] = url.split("?");
  const sp = new URLSearchParams(query);
  sp.delete("msg"); sp.delete("err");
  sp.set(k, v.slice(0, 900));
  return `${path}?${sp.toString()}`;
}
function errorMessage(e: unknown): string {
  if (e instanceof ZodError) return e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  const m = (e as any)?.message ?? String(e);
  if (/duplicate key value.*customers_customer_code/.test(m)) return "That customer ID is already in use.";
  if (/duplicate key value.*equipment_unit_number/.test(m)) return "That unit number already exists.";
  if (/duplicate key value.*rental_contracts_contract_number/.test(m)) return "That rental contract number already exists.";
  if (/duplicate key value.*users_email/.test(m)) return "A user with that email already exists.";
  return m;
}

/** Run an action for the signed-in user, then redirect back with a success or error message. */
async function run(fd: FormData, fallback: string, fn: (u: SessionUser) => Promise<string | { to: string; msg: string } | void>) {
  const user = await getUser();
  if (!user) redirect("/login");
  const back = safeBack(fd, fallback);
  let target: string;
  try {
    const r = await fn(user);
    target = typeof r === "object" && r ? withParam(r.to, "msg", r.msg) : withParam(back, "msg", r || "Saved.");
  } catch (e) {
    if (e instanceof DuplicateInvoiceError) target = withParam(`/invoices/${e.existing.id}`, "err", e.message);
    else target = withParam(back, "err", errorMessage(e));
  }
  redirect(target);
}

// ───────── Auth
export async function loginAction(fd: FormData) {
  let target = "/";
  try {
    const { token, expires } = await login(str(fd, "email"), str(fd, "password"));
    (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1", path: "/", expires });
  } catch (e) {
    target = "/login?err=" + encodeURIComponent(errorMessage(e));
  }
  redirect(target);
}
export async function setupAction(fd: FormData) {
  let target = "/settings?msg=" + encodeURIComponent("Setup complete. Enter Champion's details below, then add your team under Users.");
  try {
    await firstRunSetup({ token: str(fd, "token"), name: str(fd, "name"), email: str(fd, "email"), password: str(fd, "password"), confirm: str(fd, "confirm"), createRpm: bool(fd, "create_rpm"), rpmAddress: str(fd, "rpm_address") });
    const { token, expires } = await login(str(fd, "email"), str(fd, "password"));
    (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1", path: "/", expires });
  } catch (e) {
    target = "/setup?err=" + encodeURIComponent(errorMessage(e));
  }
  redirect(target);
}
export async function logoutAction() {
  const c = await cookies();
  await logout(c.get(SESSION_COOKIE)?.value);
  c.delete(SESSION_COOKIE);
  redirect("/login");
}

// ───────── Customers & profiles
export async function createCustomerAction(fd: FormData) {
  await run(fd, "/customers", async (u) => {
    const c = await createCustomer(u, { customer_code: str(fd, "customer_code"), name: str(fd, "name"), billing_address: str(fd, "billing_address"), email: str(fd, "email"), phone: str(fd, "phone") });
    return { to: `/customers/${c.id}`, msg: `Customer ${c.name} created.` };
  });
}
export async function updateCustomerAction(fd: FormData) {
  await run(fd, "/customers", async (u) => {
    await updateCustomer(u, str(fd, "id"), { customer_code: str(fd, "customer_code"), name: str(fd, "name"), billing_address: str(fd, "billing_address"), email: str(fd, "email"), phone: str(fd, "phone") });
    return "Customer updated.";
  });
}
export async function updateProfileAction(fd: FormData) {
  await run(fd, "/customers", async (u) => {
    await updateBillingProfile(u, str(fd, "customer_id"), {
      billing_method: str(fd, "billing_method"), bill_off_rent_day: bool(fd, "bill_off_rent_day"), require_monthly_po: bool(fd, "require_monthly_po"),
      unique_po_per_unit: bool(fd, "unique_po_per_unit"), po_pattern: str(fd, "po_pattern"), po_pattern_description: str(fd, "po_pattern_description"),
      require_work_order: bool(fd, "require_work_order"), require_job_number: bool(fd, "require_job_number"), require_jobsite_address: bool(fd, "require_jobsite_address"),
      require_contract_attachment: bool(fd, "require_contract_attachment"), require_manual_approval: bool(fd, "require_manual_approval"), invoice_level_po: bool(fd, "invoice_level_po"),
      po_variance_tolerance_pct: str(fd, "po_variance_tolerance_pct"), po_variance_tolerance_amount: str(fd, "po_variance_tolerance_amount"),
      tax_rate: str(fd, "tax_rate"), tax_rate_is_placeholder: bool(fd, "tax_rate_is_placeholder"), payment_terms_days: str(fd, "payment_terms_days"), payment_terms_label: str(fd, "payment_terms_label"),
    });
    return "Billing profile saved.";
  });
}
export async function approveProrationAction(fd: FormData) {
  await run(fd, "/customers", async (u) => {
    await approveProrationPolicy(u, str(fd, "customer_id"), str(fd, "policy") as ProrationPolicy, str(fd, "note"));
    return "Proration policy recorded.";
  });
}

// ───────── Equipment & rentals
export async function createEquipmentAction(fd: FormData) {
  await run(fd, "/equipment", async (u) => {
    const e = await createEquipment(u, { unit_number: str(fd, "unit_number"), description: str(fd, "description"), serial_number: str(fd, "serial_number"), make: str(fd, "make"), model: str(fd, "model"), year: str(fd, "year") });
    return `Unit ${e.unit_number} added.`;
  });
}
export async function createRentalAction(fd: FormData) {
  await run(fd, "/rentals/new", async (u) => {
    const fees = [];
    if (str(fd, "fee_description") && str(fd, "fee_amount")) fees.push({ description: str(fd, "fee_description"), amount: str(fd, "fee_amount"), frequency: str(fd, "fee_frequency") || "per_period", taxable: bool(fd, "fee_taxable") });
    const { line, contract } = await createRental(u, {
      contract_number: str(fd, "contract_number"), customer_id: str(fd, "customer_id"), unit_number: str(fd, "unit_number"), jobsite_name: str(fd, "jobsite_name"), jobsite_address: str(fd, "jobsite_address"),
      job_number: str(fd, "job_number"), work_order_number: str(fd, "work_order_number"), start_date: str(fd, "start_date"), billing_start_date: str(fd, "billing_start_date"),
      billing_method: str(fd, "billing_method"), rate_amount: str(fd, "rate_amount"), rate_basis: str(fd, "rate_basis"), delivery_charge: str(fd, "delivery_charge") || "0",
      pickup_charge: str(fd, "pickup_charge") || "0", taxable: bool(fd, "taxable"), payment_terms_days: str(fd, "payment_terms_days"), quipli_reference: str(fd, "quipli_reference"),
      internal_notes: str(fd, "internal_notes"), fees,
    });
    const file = fd.get("agreement");
    if (file instanceof File && file.size > 0) await addContractDocument(u, contract.id, { filename: file.name, mime: file.type, content: Buffer.from(await file.arrayBuffer()) });
    return { to: `/rentals/${line.id}`, msg: `Rental ${contract.contract_number} created.` };
  });
}
export async function changeLineStatusAction(fd: FormData) {
  await run(fd, "/rentals", async (u) => { await changeLineStatus(u, str(fd, "line_id"), { status: str(fd, "status"), date: str(fd, "date") || null, note: str(fd, "note") || null }); return "Rental status updated."; });
}
export async function updateTermsAction(fd: FormData) {
  await run(fd, "/rentals", async (u) => {
    await updateRentalTerms(u, str(fd, "line_id"), { rate_amount: str(fd, "rate_amount") || undefined, job_number: str(fd, "job_number") || null, work_order_number: str(fd, "work_order_number") || null, internal_notes: str(fd, "internal_notes") || null, note: str(fd, "note") });
    return "Rental terms updated. Finalized invoices are unaffected.";
  });
}
export async function uploadDocumentAction(fd: FormData) {
  await run(fd, "/rentals", async (u) => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a file to upload.");
    await addContractDocument(u, str(fd, "contract_id"), { filename: file.name, mime: file.type, content: Buffer.from(await file.arrayBuffer()) });
    return `Uploaded ${file.name}. Recalculate any open draft invoices to attach it.`;
  });
}

// ───────── POs
export async function assignPoAction(fd: FormData) {
  await run(fd, "/rentals", async (u) => {
    const r = await assignPo(u, {
      lineId: str(fd, "line_id"), period: str(fd, "period"), poNumber: str(fd, "po_number"), estimatedTotal: str(fd, "estimated_total") || null,
      jobNumber: str(fd, "job_number") || null, workOrderNumber: str(fd, "work_order_number") || null, validFrom: str(fd, "valid_from") || null, validTo: str(fd, "valid_to") || null,
      expiresOn: str(fd, "expires_on") || null, replaceExisting: bool(fd, "replace"), reason: str(fd, "reason") || null,
    });
    return [`PO ${str(fd, "po_number").trim()} ${r.superseded ? "replaced the previous PO" : "assigned"}.`, ...r.warnings].join(" ");
  });
}
export async function removePoAction(fd: FormData) {
  await run(fd, "/rentals", async (u) => { await removePoAssignment(u, str(fd, "assignment_id"), str(fd, "reason")); return "PO assignment removed (kept in history)."; });
}

// ───────── Invoices
export async function generateInvoiceAction(fd: FormData) {
  await run(fd, "/invoices", async (u) => {
    const inv = await generateInvoice(u, str(fd, "line_id"), str(fd, "period"));
    return { to: `/invoices/${inv.id}`, msg: "Draft invoice created." };
  });
}
export async function generateMonthAction(fd: FormData) {
  await run(fd, "/rpm", async (u) => {
    const res = await generateMonthForCustomer(u, str(fd, "customer_id"), str(fd, "month"));
    const created = res.filter((r) => r.status === "created").length, exists = res.filter((r) => r.status === "exists").length;
    const errs = res.filter((r) => r.status === "error");
    return `${created} draft invoice(s) created, ${exists} already existed.${errs.length ? ` ${errs.length} could not be generated: ${errs.map((e) => `${e.unit}: ${e.message}`).join(" | ")}` : ""}`;
  });
}
export async function bulkSubmitAction(fd: FormData) {
  await run(fd, "/rpm", async (u) => {
    requirePerm(u, "submit_invoice");
    const ids = await q(`SELECT id FROM invoices WHERE customer_id=$1 AND status='draft' AND period_start >= $2::date AND period_start < ($2::date + interval '1 month')`, [str(fd, "customer_id"), str(fd, "month")]);
    let ok = 0; const errs: string[] = [];
    for (const { id } of ids) { try { await submitForReview(u, id); ok++; } catch (e: any) { errs.push(e.message); } }
    return `${ok} invoice(s) submitted for review.${errs.length ? ` ${errs.length} failed: ${errs.slice(0, 3).join(" | ")}` : ""}`;
  });
}
export async function bulkApproveAction(fd: FormData) {
  await run(fd, "/rpm", async (u) => {
    requirePerm(u, "approve_invoice");
    const ids = await q(`SELECT id FROM invoices WHERE customer_id=$1 AND status='pending_review' AND period_start >= $2::date AND period_start < ($2::date + interval '1 month')`, [str(fd, "customer_id"), str(fd, "month")]);
    let ok = 0, blocked = 0;
    for (const { id } of ids) { try { await approveInvoice(u, id); ok++; } catch { blocked++; } }
    return `${ok} invoice(s) approved and finalized.${blocked ? ` ${blocked} still need attention (open them to see which checks failed).` : ""}`;
  });
}
const invAction = (fn: (u: SessionUser, id: string, fd: FormData) => Promise<unknown>, msg: string) => async (fd: FormData) => {
  await run(fd, `/invoices/${str(fd, "id")}`, async (u) => { const r: any = await fn(u, str(fd, "id"), fd); if (r?.id && r?.revision_no) return { to: `/invoices/${r.id}`, msg }; return typeof r?.invoice_number === "string" ? `${msg} Invoice number ${r.invoice_number}.` : msg; });
};
export async function refreshInvoiceAction(fd: FormData) { await invAction((u, id) => refreshInvoice(u, id), "Invoice recalculated from current rental and PO data.")(fd); }
export async function submitInvoiceAction(fd: FormData) { await invAction((u, id) => submitForReview(u, id), "Submitted for review.")(fd); }
export async function approveInvoiceAction(fd: FormData) { await invAction((u, id, fd) => approveInvoice(u, id, { invoiceNumber: str(fd, "invoice_number") || null }), "Approved and finalized.")(fd); }
export async function rejectInvoiceAction(fd: FormData) { await invAction((u, id, fd) => rejectInvoice(u, id, str(fd, "reason")), "Invoice rejected and returned to the preparer.")(fd); }
export async function issueInvoiceAction(fd: FormData) { await invAction((u, id) => issueInvoice(u, id), "Invoice marked as issued to the customer.")(fd); }
export async function voidInvoiceAction(fd: FormData) { await invAction((u, id, fd) => voidInvoice(u, id, str(fd, "reason")), "Invoice voided. The billing period can now be re-invoiced.")(fd); }
export async function reviseInvoiceAction(fd: FormData) { await invAction((u, id, fd) => reviseInvoice(u, id, str(fd, "reason")), "Revision draft created. The original invoice is preserved.")(fd); }
export async function overrideAction(fd: FormData) { await invAction((u, id, fd) => overrideCheck(u, id, str(fd, "rule"), str(fd, "reason")), "Override recorded.")(fd); }
export async function paymentAction(fd: FormData) { await invAction((u, id, fd) => recordPayment(u, id, { amount: str(fd, "amount"), paid_on: str(fd, "paid_on"), method: str(fd, "method"), reference: str(fd, "reference") }), "Payment recorded.")(fd); }

// ───────── Imports
export async function uploadImportAction(fd: FormData) {
  await run(fd, "/imports", async (u) => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a CSV or Excel file.");
    if (file.size > 10 * 1024 * 1024) throw new Error("Import files must be under 10 MB.");
    const b = await createImportBatch(u, { customerId: str(fd, "customer_id"), billingMonth: str(fd, "month") + "-01", filename: file.name, content: Buffer.from(await file.arrayBuffer()) });
    return { to: `/imports/${b.id}`, msg: "File loaded. Review every row below. Nothing has been assigned yet." };
  });
}
export async function editRowAction(fd: FormData) {
  await run(fd, "/imports", async (u) => {
    await editImportRow(u, str(fd, "row_id"), { po_number: str(fd, "po_number"), unit_number: str(fd, "unit_number"), job_number: str(fd, "job_number"), work_order_number: str(fd, "work_order_number"), po_total: str(fd, "po_total"), note: str(fd, "note") });
    return "Row updated and re-checked.";
  });
}
export async function decideRowAction(fd: FormData) {
  await run(fd, "/imports", async (u) => { await decideImportRow(u, str(fd, "row_id"), str(fd, "decision") as any, str(fd, "note") || undefined); return "Row decision saved."; });
}
export async function approveCleanAction(fd: FormData) {
  await run(fd, "/imports", async (u) => `${await approveCleanRows(u, str(fd, "batch_id"))} row(s) with no issues approved.`);
}
export async function applyImportAction(fd: FormData) {
  await run(fd, "/imports", async (u) => {
    const r = await applyImportBatch(u, str(fd, "batch_id"));
    return `Applied ${r.length} PO assignment(s) in one transaction.`;
  });
}
export async function cancelImportAction(fd: FormData) {
  await run(fd, "/imports", async (u) => { await cancelImportBatch(u, str(fd, "batch_id")); return { to: "/imports", msg: "Import cancelled. Nothing was assigned." }; });
}

// ───────── Settings & users
export async function updateCompanyAction(fd: FormData) {
  await run(fd, "/settings", async (u) => {
    await updateCompanySettings(u, { legal_name: str(fd, "legal_name"), address_line1: str(fd, "address_line1"), address_line2: str(fd, "address_line2"), city_state_zip: str(fd, "city_state_zip"),
      phone: str(fd, "phone"), email: str(fd, "email"), remit_to: str(fd, "remit_to"), invoice_prefix: str(fd, "invoice_prefix"), next_invoice_number: str(fd, "next_invoice_number"), is_placeholder: bool(fd, "is_placeholder") });
    return "Company details saved. Only invoices finalized from now on use them; earlier invoices keep their original details.";
  });
}
export async function createUserAction(fd: FormData) {
  await run(fd, "/settings", async (u) => {
    requirePerm(u, "manage_users");
    await createUser({ email: str(fd, "email"), name: str(fd, "name"), password: str(fd, "password"), role: str(fd, "role") as any }, u);
    return "User created.";
  });
}
export async function toggleUserAction(fd: FormData) {
  await run(fd, "/settings", async (u) => { requirePerm(u, "manage_users"); await setUserActive(u, str(fd, "id"), str(fd, "active") === "true"); return "User updated."; });
}

// ───────── Rental bulk load
export async function uploadRentalFileAction(fd: FormData) {
  await run(fd, "/rentals/load", async (u) => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a CSV or Excel file.");
    const b = await uploadRentalFile(u, { customerId: str(fd, "customer_id"), filename: file.name, content: Buffer.from(await file.arrayBuffer()) });
    return { to: `/rentals/load/${b.id}`, msg: "File read. Check every row below. Nothing has been created yet." };
  });
}
export async function applyRentalBatchAction(fd: FormData) {
  await run(fd, "/rentals/load", async (u) => { const n = await applyRentalBatch(u, str(fd, "batch_id")); return { to: "/rentals", msg: `${n} rental(s) created in one transaction.` }; });
}
export async function cancelRentalBatchAction(fd: FormData) {
  await run(fd, "/rentals/load", async (u) => { await cancelRentalBatch(u, str(fd, "batch_id")); return { to: "/rentals/load", msg: "Load cancelled. Nothing was created." }; });
}
