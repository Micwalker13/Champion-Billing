"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { ZodError } from "zod";
import { getUser } from "@/lib/session";
import { SessionUser, requirePerm } from "@/lib/permissions";
import { SESSION_COOKIE, changePassword, createUser, login, logout, resetUserPassword, setUserActive } from "@/lib/services/auth";
import { addContractDocument, approveProrationPolicy, changeLineStatus, createCustomer, createEquipment, createRental, updateBillingProfile, updateCustomer, updateRentalTerms } from "@/lib/services/records";
import { assignPo, removePoAssignment } from "@/lib/services/pos";
import { approveInvoice, DuplicateInvoiceError, generateInvoice, generateMonthForCustomer, issueInvoice, overrideCheck, recordPayment, refreshInvoice, rejectInvoice, reviseInvoice, submitForReview, voidInvoice } from "@/lib/services/invoices";
import { applyImportBatch, approveCleanRows, cancelImportBatch, createImportBatch, decideImportRow, editImportRow } from "@/lib/services/imports";
import { updateCompanySettings } from "@/lib/services/settings";
import { firstRunSetup } from "@/lib/services/setup";
import { ProrationPolicy } from "@/lib/billing";
import { q } from "@/lib/db";
import { applyRentalBatch, cancelRentalBatch, uploadRentalFile } from "@/lib/services/rental-import";
import { createYard, exchangeUnit, updateUnit } from "@/lib/services/inventory";
import { createSale, finalizeSale, recordSalePayment, voidSale } from "@/lib/services/sales";
import { issueCredit } from "@/lib/services/credits";
import { emailCredit, emailInvoice, emailMonth, setInvoiceEmails } from "@/lib/services/email";
import { saveUsage, setDamageWaiverWaived, updateUsageSettings } from "@/lib/services/usage";
import { removeCoi, setRdwChoice, uploadCoi } from "@/lib/services/insurance";
import { addExemption, addFeeAssignment, addFeeRate, createFeeType, endFeeRate, removeExemption, removeFeeAssignment, removeFeeOverride, setEquipmentClass, setFeeOverride, setFeeTypeActive, setUnitFee, updateFeeType } from "@/lib/services/fees";
import { refreshSaleFees } from "@/lib/services/sales";
import { tx } from "@/lib/db";
import { acceptQuote, addQuoteLine, assignReservationUnit, cancelReservation, cancelTicket, completeTicket, convertReservation, createQuote, createReservation, declineQuote, markQuoteSent, removeQuoteLine, scheduleTicket } from "@/lib/services/dispatch";
import { addWorkOrderLine, cancelWorkOrder, completeWorkOrder, createServiceInterval, createWorkOrder, linkWorkOrderRental, removeWorkOrderLine, setIntervalActive, updateWorkOrder } from "@/lib/services/shop";
import { fmtDate } from "@/lib/dates";
import { disconnectQbo, kickQboSync, retryQboJob, runQboSyncNow, setQboMapping, updateQboSettings } from "@/lib/services/quickbooks";

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
  if (/duplicate key value.*yards_name/.test(m)) return "A yard with that name already exists.";
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
    const e = await createEquipment(u, { unit_number: str(fd, "unit_number"), description: str(fd, "description"), serial_number: str(fd, "serial_number"), make: str(fd, "make"), model: str(fd, "model"), year: str(fd, "year"), category: str(fd, "category"), yard_id: str(fd, "yard_id"), hour_meter: str(fd, "hour_meter") });
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
    after(kickQboSync);
    return `${ok} invoice(s) approved and finalized.${blocked ? ` ${blocked} still need attention (open them to see which checks failed).` : ""}`;
  });
}
const invAction = (fn: (u: SessionUser, id: string, fd: FormData) => Promise<unknown>, msg: string) => async (fd: FormData) => {
  after(kickQboSync); // send anything this queued for QuickBooks once the page has responded
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

// ───────── Inventory, exchanges and sales
export async function createYardAction(fd: FormData) {
  await run(fd, "/equipment", async (u) => { const y = await createYard(u, { name: str(fd, "name"), address: str(fd, "address") }); return `Yard ${y.name} added.`; });
}
export async function updateUnitAction(fd: FormData) {
  await run(fd, "/equipment", async (u) => {
    const keys = ["description", "category", "serial_number", "make", "model", "year", "yard_id", "status", "hour_meter", "asking_price", "notes", "note"];
    const e = await updateUnit(u, str(fd, "equipment_id"), Object.fromEntries(keys.map((k) => [k, str(fd, k)])));
    return `Unit ${e.unit_number} saved.`;
  });
}
export async function exchangeUnitAction(fd: FormData) {
  await run(fd, "/rentals", async (u) => {
    const keys = ["in_unit", "exchange_date", "reason", "out_status", "out_yard_id", "out_hours", "in_hours", "freight_amount"];
    const r = await exchangeUnit(u, str(fd, "line_id"), Object.fromEntries(keys.map((k) => [k, str(fd, k)])));
    const after = r.finalizedAfter.length ? ` ${r.finalizedAfter.join(", ")} already went out showing unit ${r.out.unit_number}; ${r.finalizedAfter.length > 1 ? "they stay" : "it stays"} as sent, and the amount is the same.` : "";
    return `Exchanged: unit ${r.in.unit_number} is on this rental from ${fmtDate(r.exchange.exchange_date)}, and unit ${r.out.unit_number} went back as ${r.out.status === "in_shop" ? "in the shop" : "available"}. Billing, rate and PO carry on unchanged.${after}`;
  });
}
export async function createSaleAction(fd: FormData) {
  await run(fd, "/sales", async (u) => {
    const s = await createSale(u, {
      customer_id: str(fd, "customer_id"), unit_number: str(fd, "unit_number"), price: str(fd, "price"), freight: str(fd, "freight"), taxable: bool(fd, "taxable"),
      tax_percent: str(fd, "tax_percent"), terms_days: str(fd, "terms_days"), hours_at_sale: str(fd, "hours_at_sale"), notes: str(fd, "notes"),
    });
    return { to: `/sales/${s.id}`, msg: "Draft sale created. Check it, then finalize to number it and mark the unit sold." };
  });
}
export async function finalizeSaleAction(fd: FormData) {
  await run(fd, "/sales", async (u) => { const r = await finalizeSale(u, str(fd, "sale_id")); return `Finalized as invoice ${r.sale_number}. The unit is now marked sold.`; });
}
export async function voidSaleAction(fd: FormData) {
  await run(fd, "/sales", async (u) => { await voidSale(u, str(fd, "sale_id"), str(fd, "reason")); return "Sale voided. If it was finalized, the unit is available again."; });
}
export async function salePaymentAction(fd: FormData) {
  await run(fd, "/sales", async (u) => { await recordSalePayment(u, str(fd, "sale_id"), { amount: str(fd, "amount"), paid_on: str(fd, "paid_on"), method: str(fd, "method"), reference: str(fd, "reference") }); return "Payment recorded."; });
}

// ───────── Credit memos
export async function creditAction(fd: FormData) {
  await invAction(async (u, id, fd) => {
    const c = await issueCredit(u, id, { amount: str(fd, "amount"), creditTax: bool(fd, "credit_tax"), reason: str(fd, "reason") });
    return c;
  }, "Credit memo issued. Its PDF is in the history below.")(fd);
}

// ───────── Email
export async function emailInvoiceAction(fd: FormData) {
  await invAction(async (u, id) => { const r = await emailInvoice(u, id); return { ok: r }; }, "Emailed to the customer.")(fd);
}
export async function emailCreditAction(fd: FormData) {
  await run(fd, `/invoices/${str(fd, "id")}`, async (u) => { const r = await emailCredit(u, str(fd, "credit_id")); return `Credit memo emailed to ${r.to.join(", ")}.`; });
}
export async function emailMonthAction(fd: FormData) {
  await run(fd, "/rpm", async (u) => {
    const r = await emailMonth(u, str(fd, "customer_id"), str(fd, "month"));
    const failed = r.filter((x) => !x.ok);
    if (!r.length) return "Every approved invoice for this month was already emailed.";
    return `Emailed ${r.length - failed.length} of ${r.length} invoices.${failed.length ? ` Not sent: ${failed.map((f) => `${f.invoice} (${f.error})`).join("; ")}` : ""}`;
  });
}
export async function setInvoiceEmailsAction(fd: FormData) {
  await run(fd, "/customers", async (u) => { const a = await setInvoiceEmails(u, str(fd, "customer_id"), str(fd, "invoice_emails")); return a.length ? `Invoices will be emailed to ${a.join(", ")}.` : "Invoice email cleared."; });
}

// ───────── Hour meter, fuel and add-on charges
export async function saveUsageAction(fd: FormData) {
  await invAction((u, id, fd) => saveUsage(u, id, fd.getAll("eid").map((e) => String(e)).map((e) => ({
    equipment_id: e, start_hours: str(fd, `start_${e}`), end_hours: str(fd, `end_${e}`), fuel_gallons: str(fd, `fuel_${e}`),
  }))), "Readings saved and the invoice recalculated.")(fd);
}
export async function usageSettingsAction(fd: FormData) {
  await run(fd, "/customers", async (u) => {
    await updateUsageSettings(u, str(fd, "customer_id"), {
      overtime_enabled: bool(fd, "overtime_enabled"), hours_per_day: str(fd, "hours_per_day"), hours_per_week: str(fd, "hours_per_week"),
      hours_per_month: str(fd, "hours_per_month"), overtime_multiplier: str(fd, "overtime_multiplier"), damage_waiver_pct: str(fd, "damage_waiver_pct"),
      environmental_pct: str(fd, "environmental_pct"), fuel_price_per_gallon: str(fd, "fuel_price_per_gallon"),
    });
    return "Extra-hours and add-on settings saved. They apply to invoices generated or recalculated from now on.";
  });
}
export async function damageWaiverAction(fd: FormData) {
  await run(fd, "/rentals", async (u) => {
    const waived = str(fd, "waived") === "true";
    await setDamageWaiverWaived(u, str(fd, "line_id"), waived, str(fd, "reason"));
    return waived ? "Damage waiver waived on this rental." : "Damage waiver applies to this rental again.";
  });
}

// ───────── Passwords
export async function changePasswordAction(fd: FormData) {
  await run(fd, "/account", async (u) => {
    if (str(fd, "new_password") !== str(fd, "confirm_password")) throw new Error("The new passwords don't match.");
    const c = await cookies();
    await changePassword(u, str(fd, "current_password"), str(fd, "new_password"), c.get(SESSION_COOKIE)?.value);
    return "Password changed. Any other devices you were signed in on have been signed out.";
  });
}
export async function resetPasswordAction(fd: FormData) {
  await run(fd, "/settings", async (u) => { await resetUserPassword(u, str(fd, "id"), str(fd, "temporary_password")); return "Temporary password set. Give it to them privately and ask them to change it under My account."; });
}

// ───────── Shop
const woBack = (fd: FormData) => `/shop/${str(fd, "wo_id")}`;
export async function createWorkOrderAction(fd: FormData) {
  await run(fd, "/shop", async (u) => {
    const wo = await createWorkOrder(u, { unit_number: str(fd, "unit_number"), kind: str(fd, "kind") || "repair", complaint: str(fd, "complaint"), opened_on: str(fd, "opened_on") || undefined,
      hours_in: str(fd, "hours_in"), assigned_to: str(fd, "assigned_to"), contract_line_id: str(fd, "contract_line_id"), service_interval_id: str(fd, "service_interval_id"), put_in_shop: bool(fd, "put_in_shop") });
    return { to: `/shop/${wo.id}`, msg: `Work order ${wo.wo_number} opened.` };
  });
}
export async function updateWorkOrderAction(fd: FormData) {
  await run(fd, woBack(fd), async (u) => { await updateWorkOrder(u, str(fd, "wo_id"), { status: str(fd, "status"), cause: str(fd, "cause"), correction: str(fd, "correction"), assigned_to: str(fd, "assigned_to") }); return "Work order saved."; });
}
export async function addWorkOrderLineAction(fd: FormData) {
  await run(fd, woBack(fd), async (u) => { await addWorkOrderLine(u, str(fd, "wo_id"), { kind: str(fd, "kind"), description: str(fd, "description"), part_number: str(fd, "part_number"), quantity: str(fd, "quantity"), unit_cost: str(fd, "unit_cost") }); return "Line added."; });
}
export async function removeWorkOrderLineAction(fd: FormData) {
  await run(fd, woBack(fd), async (u) => { await removeWorkOrderLine(u, str(fd, "wo_id"), str(fd, "line_id")); return "Line removed."; });
}
export async function linkWorkOrderRentalAction(fd: FormData) {
  await run(fd, woBack(fd), async (u) => { await linkWorkOrderRental(u, str(fd, "wo_id"), str(fd, "contract_line_id") || null); return "Rental link saved."; });
}
export async function completeWorkOrderAction(fd: FormData) {
  await run(fd, woBack(fd), async (u) => {
    const r = await completeWorkOrder(u, str(fd, "wo_id"), { completed_on: str(fd, "completed_on"), correction: str(fd, "correction"), hours_out: str(fd, "hours_out"), return_to: str(fd, "return_to") || "available", bill_customer: bool(fd, "bill_customer") });
    return r.billed_fee_id ? "Work order completed. The repair is billed to the rental as a one-time charge on its next invoice." : "Work order completed.";
  });
}
export async function cancelWorkOrderAction(fd: FormData) {
  await run(fd, woBack(fd), async (u) => { await cancelWorkOrder(u, str(fd, "wo_id"), str(fd, "reason")); return "Work order cancelled."; });
}
export async function createIntervalAction(fd: FormData) {
  await run(fd, "/shop", async (u) => {
    await createServiceInterval(u, str(fd, "equipment_id"), { name: str(fd, "name"), every_hours: str(fd, "every_hours"), every_days: str(fd, "every_days"), last_done_hours: str(fd, "last_done_hours"), last_done_on: str(fd, "last_done_on") });
    return "Service schedule added.";
  });
}
export async function intervalActiveAction(fd: FormData) {
  await run(fd, "/shop", async (u) => { const on = str(fd, "active") === "true"; await setIntervalActive(u, str(fd, "interval_id"), on); return on ? "Service schedule turned back on." : "Service schedule turned off."; });
}

// ───────── Delivery / pickup tickets
export async function scheduleTicketAction(fd: FormData) {
  await run(fd, "/dispatch", async (u) => {
    const t = await scheduleTicket(u, str(fd, "line_id"), { kind: str(fd, "kind"), scheduled_date: str(fd, "scheduled_date"), time_window: str(fd, "time_window"), driver: str(fd, "driver"), truck: str(fd, "truck"), site_contact: str(fd, "site_contact"), instructions: str(fd, "instructions") });
    return `${t.kind === "delivery" ? "Delivery" : "Pickup"} ${t.ticket_number} scheduled.`;
  });
}
export async function completeTicketAction(fd: FormData) {
  await run(fd, "/dispatch", async (u) => {
    const t = await completeTicket(u, str(fd, "ticket_id"), { signed_by: str(fd, "signed_by"), signature: str(fd, "signature"), hours: str(fd, "hours"), fuel_level: str(fd, "fuel_level"), condition_notes: str(fd, "condition_notes") });
    return `${t.ticket_number} signed. The signed PDF is saved.`;
  });
}
export async function cancelTicketAction(fd: FormData) {
  await run(fd, "/dispatch", async (u) => { await cancelTicket(u, str(fd, "ticket_id"), str(fd, "reason")); return "Ticket cancelled."; });
}

// ───────── Quotes and reservations
export async function createQuoteAction(fd: FormData) {
  await run(fd, "/quotes", async (u) => {
    const qt = await createQuote(u, { customer_id: str(fd, "customer_id"), valid_days: str(fd, "valid_days"), jobsite: str(fd, "jobsite"), contact: str(fd, "contact"), notes: str(fd, "notes") });
    return { to: `/quotes/${qt.id}`, msg: `Quote ${qt.quote_number} started. Add the equipment below.` };
  });
}
const qBack = (fd: FormData) => `/quotes/${str(fd, "quote_id")}`;
export async function addQuoteLineAction(fd: FormData) {
  await run(fd, qBack(fd), async (u) => {
    await addQuoteLine(u, str(fd, "quote_id"), { description: str(fd, "description"), category: str(fd, "category"), unit_number: str(fd, "unit_number"), quantity: str(fd, "quantity") || "1",
      rate_amount: str(fd, "rate_amount"), rate_basis: str(fd, "rate_basis"), start_date: str(fd, "start_date"), end_date: str(fd, "end_date"), delivery_charge: str(fd, "delivery_charge"), pickup_charge: str(fd, "pickup_charge") });
    return "Line added.";
  });
}
export async function removeQuoteLineAction(fd: FormData) {
  await run(fd, qBack(fd), async (u) => { await removeQuoteLine(u, str(fd, "quote_id"), str(fd, "line_id")); return "Line removed."; });
}
export async function sendQuoteAction(fd: FormData) {
  await run(fd, qBack(fd), async (u) => { await markQuoteSent(u, str(fd, "quote_id")); return "Quote marked as sent. Its prices are now locked."; });
}
export async function acceptQuoteAction(fd: FormData) {
  await run(fd, qBack(fd), async (u) => { const r = await acceptQuote(u, str(fd, "quote_id"), str(fd, "note")); return `Quote accepted. ${r.length} reservation${r.length === 1 ? "" : "s"} created.`; });
}
export async function declineQuoteAction(fd: FormData) {
  await run(fd, qBack(fd), async (u) => { await declineQuote(u, str(fd, "quote_id"), str(fd, "note")); return "Quote marked declined."; });
}
export async function createReservationAction(fd: FormData) {
  await run(fd, "/reservations", async (u) => {
    await createReservation(u, { customer_id: str(fd, "customer_id"), unit_number: str(fd, "unit_number"), category: str(fd, "category"), description: str(fd, "description"),
      start_date: str(fd, "start_date"), end_date: str(fd, "end_date"), rate_amount: str(fd, "rate_amount"), rate_basis: str(fd, "rate_basis"), notes: str(fd, "notes") });
    return "Reserved.";
  });
}
export async function assignReservationAction(fd: FormData) {
  await run(fd, "/reservations", async (u) => { await assignReservationUnit(u, str(fd, "reservation_id"), str(fd, "unit_number")); return "Unit assigned to the reservation."; });
}
export async function cancelReservationAction(fd: FormData) {
  await run(fd, "/reservations", async (u) => { await cancelReservation(u, str(fd, "reservation_id"), str(fd, "reason")); return "Reservation cancelled."; });
}
export async function convertReservationAction(fd: FormData) {
  await run(fd, "/reservations", async (u) => {
    const { lineId } = await convertReservation(u, str(fd, "reservation_id"), { contract_number: str(fd, "contract_number"), start_date: str(fd, "start_date") || undefined });
    return { to: `/rentals/${lineId}`, msg: "Rental created from the reservation. Schedule the delivery below." };
  });
}

// ───────── Damage waiver and certificates of insurance
export async function rdwChoiceAction(fd: FormData) {
  await run(fd, "/customers", async (u) => {
    const choice = str(fd, "rdw_choice");
    await setRdwChoice(u, str(fd, "customer_id"), choice);
    return choice === "coi" ? "Set to use the customer's own insurance. The damage waiver is skipped only while a certificate on file covers the billing period." : "Set to bill the damage waiver.";
  });
}
export async function uploadCoiAction(fd: FormData) {
  await run(fd, "/customers", async (u) => {
    const file = fd.get("certificate");
    if (!(file instanceof File) || file.size === 0) throw new Error("Attach the certificate (PDF, PNG or JPG).");
    const c = await uploadCoi(u, str(fd, "customer_id"), { insurer: str(fd, "insurer"), policy_number: str(fd, "policy_number"), effective_on: str(fd, "effective_on"), expires_on: str(fd, "expires_on"),
      file: { filename: file.name, mime: file.type, content: Buffer.from(await file.arrayBuffer()) } });
    return `Certificate saved, valid through ${fmtDate(c.expires_on)}. Draft invoices pick it up when they are recalculated.`;
  });
}
export async function removeCoiAction(fd: FormData) {
  await run(fd, "/customers", async (u) => { await removeCoi(u, str(fd, "coi_id"), str(fd, "reason")); return "Certificate removed. The damage waiver bills again for periods it no longer covers."; });
}

// ───────── Fees and taxes
const feeFields = (fd: FormData) => ({ code: str(fd, "code"), name: str(fd, "name"), description: str(fd, "description"), category: str(fd, "category"), calc_type: str(fd, "calc_type"),
  frequency: str(fd, "frequency"), applies_rentals: bool(fd, "applies_rentals"), applies_sales: bool(fd, "applies_sales"), taxable: bool(fd, "taxable"), allow_override: bool(fd, "allow_override"), gl_account: str(fd, "gl_account") });
export async function createFeeTypeAction(fd: FormData) {
  await run(fd, "/fees", async (u) => {
    const rate = str(fd, "rate") ? { effective_from: str(fd, "effective_from"), value: str(fd, "rate"), note: str(fd, "rate_note") } : undefined;
    const f = await createFeeType(u, feeFields(fd), rate);
    return { to: `/fees#fee-${f.id}`, msg: `${f.name} created. Assign it to equipment classes, categories or single units so it applies.` };
  });
}
export async function updateFeeTypeAction(fd: FormData) {
  await run(fd, "/fees", async (u) => { await updateFeeType(u, str(fd, "fee_id"), feeFields(fd)); return "Fee saved."; });
}
export async function feeActiveAction(fd: FormData) {
  await run(fd, "/fees", async (u) => { const on = str(fd, "active") === "true"; await setFeeTypeActive(u, str(fd, "fee_id"), on); return on ? "Fee turned on." : "Fee turned off. It no longer applies to new invoice calculations, quotes or sales."; });
}
export async function addFeeRateAction(fd: FormData) {
  await run(fd, "/fees", async (u) => { await addFeeRate(u, str(fd, "fee_id"), { effective_from: str(fd, "effective_from"), value: str(fd, "rate"), note: str(fd, "rate_note") }); return "New rate saved. The previous rate ends the day before."; });
}
export async function endFeeRateAction(fd: FormData) {
  await run(fd, "/fees", async (u) => { await endFeeRate(u, str(fd, "fee_id"), str(fd, "last_day")); return "Rate end date saved."; });
}
export async function addFeeAssignmentAction(fd: FormData) {
  await run(fd, "/fees", async (u) => { await addFeeAssignment(u, str(fd, "fee_id"), { scope: str(fd, "scope"), value: str(fd, "value") }); return "Assignment added."; });
}
export async function removeFeeAssignmentAction(fd: FormData) {
  await run(fd, "/fees", async (u) => { await removeFeeAssignment(u, str(fd, "assignment_id")); return "Assignment removed."; });
}
export async function unitFeeAction(fd: FormData) {
  await run(fd, "/equipment", async (u) => {
    const v = str(fd, "enabled");
    await setUnitFee(u, str(fd, "equipment_id"), str(fd, "fee_id"), v === "reset" ? null : v === "true", str(fd, "reason"));
    return v === "reset" ? "Unit switch cleared; its class and category decide." : v === "true" ? "Fee switched on for this unit." : "Fee switched off for this unit.";
  });
}
export async function equipmentClassAction(fd: FormData) {
  await run(fd, "/equipment", async (u) => { await setEquipmentClass(u, str(fd, "equipment_id"), str(fd, "equipment_class")); return "Equipment class saved."; });
}
export async function addExemptionAction(fd: FormData) {
  await run(fd, "/customers", async (u) => {
    await addExemption(u, str(fd, "customer_id"), { fee_type_id: str(fd, "fee_type_id"), reason: str(fd, "reason"), certificate_ref: str(fd, "certificate_ref"), effective_from: str(fd, "effective_from"), effective_to: str(fd, "effective_to") });
    return "Exemption saved. Draft invoices pick it up when recalculated.";
  });
}
export async function removeExemptionAction(fd: FormData) {
  await run(fd, "/customers", async (u) => { await removeExemption(u, str(fd, "exemption_id"), str(fd, "reason")); return "Exemption removed."; });
}
export async function feeOverrideAction(fd: FormData) {
  await run(fd, "/rentals", async (u) => {
    const lineId = str(fd, "line_id") || undefined, saleId = str(fd, "sale_id") || undefined;
    await setFeeOverride(u, { lineId, saleId }, { fee_type_id: str(fd, "fee_type_id"), mode: str(fd, "mode"), value: str(fd, "value"), reason: str(fd, "reason") });
    if (saleId) await tx((db) => refreshSaleFees(db, saleId));
    return "Fee override saved. Draft invoices pick it up when recalculated.";
  });
}
export async function removeFeeOverrideAction(fd: FormData) {
  await run(fd, "/rentals", async (u) => {
    const r = await removeFeeOverride(u, str(fd, "override_id"));
    if (r.sale_id) await tx((db) => refreshSaleFees(db, r.sale_id!));
    return "Override removed; the standard rate applies again.";
  });
}
export async function refreshSaleFeesAction(fd: FormData) {
  await run(fd, "/sales", async (u) => {
    requirePerm(u, "edit_records");
    const id = str(fd, "sale_id");
    const sale = await tx((db) => refreshSaleFees(db, id));
    if (sale?.finalized_at) throw new Error("This sale is finalized; its fees can't change.");
    return "Fees and totals updated from the current fee setup.";
  });
}

// ───────── QuickBooks
export async function qboSettingsAction(fd: FormData) {
  await run(fd, "/quickbooks", async (u) => { await updateQboSettings(u, { enabled: bool(fd, "enabled"), sync_from: str(fd, "sync_from") }); return bool(fd, "enabled") ? "QuickBooks sync is on." : "QuickBooks sync settings saved. Sync is off."; });
}
export async function qboMappingAction(fd: FormData) {
  await run(fd, "/quickbooks", async (u) => {
    const [qbo_id, ...name] = str(fd, "qbo").split("|");
    await setQboMapping(u, { kind: str(fd, "kind"), local_key: str(fd, "local_key"), qbo_id: qbo_id ?? "", qbo_name: name.join("|") });
    return qbo_id ? "Match saved." : "Match removed.";
  });
}
export async function qboDisconnectAction(fd: FormData) {
  await run(fd, "/quickbooks", async (u) => { await disconnectQbo(u); return "QuickBooks disconnected and sync turned off. Nothing already in QuickBooks was changed."; });
}
export async function qboSyncNowAction(fd: FormData) {
  await run(fd, "/quickbooks", async (u) => {
    const r = await runQboSyncNow(u);
    return `Sync finished: ${r.synced} sent, ${r.needs_attention} need attention, ${r.skipped} not sent, ${r.waiting} waiting.`;
  });
}
export async function qboRetryAction(fd: FormData) {
  await run(fd, "/quickbooks", async (u) => { await retryQboJob(u, str(fd, "job_id")); after(kickQboSync); return "Queued to try again."; });
}
