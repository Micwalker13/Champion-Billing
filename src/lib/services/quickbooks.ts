/**
 * QuickBooks Online sync: sends finalized invoices, credit memos, payments and voids to QuickBooks.
 *
 * Rules:
 *  - One direction only. Nothing from QuickBooks changes a Champion invoice.
 *  - Each item is sent once. Every create carries a request id, and invoices and credit memos are
 *    looked up by number first, so a retry or an invoice already typed in by hand is linked, not duplicated.
 *  - Nothing is sent until an administrator connects QuickBooks, maps customers and items, picks a
 *    start date and turns sync on. Anything dated before the start date is skipped.
 *  - QuickBooks must end up with the same total as Champion. If it doesn't, the item is flagged.
 */
import { z } from "zod";
import { AppError, Db, audit, one, pool, q } from "../db";
import { SessionUser, requirePerm } from "../permissions";
import { dec, money } from "../money";
import { QboClient, QboError, qboAppConfig, qstr, revokeToken, decryptToken, tokenColumns } from "../qbo/client";

export const ITEM_KEYS: { key: string; label: string }[] = [
  { key: "rental", label: "Rental" },
  { key: "overtime", label: "Extra hours (overtime)" },
  { key: "damage_waiver", label: "Damage waiver (RDW)" },
  { key: "environmental", label: "Environmental fee" },
  { key: "fuel", label: "Fuel" },
  { key: "delivery", label: "Delivery" },
  { key: "pickup", label: "Pickup" },
  { key: "fee", label: "Other contract fees" },
  { key: "adjustment", label: "Adjustments" },
  { key: "sales_tax", label: "Sales tax" },
  { key: "credit_memo", label: "Credits (credit memos)" },
];
export const ENTITY_LABELS: Record<string, string> = { invoice: "Invoice", invoice_void: "Void", credit_memo: "Credit memo", payment: "Payment" };
export const JOB_STATUS_LABELS: Record<string, string> = { pending: "Waiting", synced: "In QuickBooks", needs_attention: "Needs attention", skipped: "Not sent" };

const lineItemKey = (l: { kind: string; fee_type_id?: string | null }) => (l.kind === "equipment_fee" && l.fee_type_id ? `fee:${l.fee_type_id}` : l.kind);

// ───────────────────────── Settings & connection ─────────────────────────
export async function qboOverview(db: Db = pool()) {
  const cfg = qboAppConfig();
  const [conn, settings, counts, mappings, feeTypes] = await Promise.all([
    one(`SELECT realm_id, company_name, environment, connected_at, access_expires_at, refresh_expires_at, u.name AS connected_by_name
         FROM qbo_connection c LEFT JOIN users u ON u.id=c.connected_by WHERE c.id=1`, [], db),
    one(`SELECT * FROM qbo_settings WHERE id=1`, [], db),
    q(`SELECT status, count(*)::int AS n FROM qbo_sync_jobs GROUP BY status`, [], db),
    q(`SELECT kind, local_key, qbo_id, qbo_name FROM qbo_mappings ORDER BY kind, local_key`, [], db),
    q(`SELECT id, name FROM fee_types ORDER BY name`, [], db),
  ]);
  const itemKeys = [...ITEM_KEYS.slice(0, -2), ...feeTypes.map((f: any) => ({ key: `fee:${f.id}`, label: `Fee: ${f.name}` })), ...ITEM_KEYS.slice(-2)];
  return { configured: cfg.configured, environment: cfg.environment, conn, settings, counts: Object.fromEntries(counts.map((c: any) => [c.status, c.n])), mappings, itemKeys };
}

export async function saveQboConnection(user: SessionUser, realmId: string, tokens: Parameters<typeof tokenColumns>[0]) {
  requirePerm(user, "manage_quickbooks");
  if (!/^\d{1,30}$/.test(realmId)) throw new AppError("QuickBooks sent back an unexpected company id.");
  const cols = tokenColumns(tokens);
  const existing = await one(`SELECT realm_id FROM qbo_connection WHERE id=1`);
  if (existing && existing.realm_id !== realmId) {
    const synced = await one(`SELECT count(*)::int AS n FROM qbo_sync_jobs WHERE status='synced'`);
    if (synced.n > 0) throw new AppError("A different QuickBooks company is already connected and has synced records. Disconnect it first.");
  }
  await q(
    `INSERT INTO qbo_connection(id, realm_id, environment, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, connected_by)
     VALUES (1,$1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET realm_id=EXCLUDED.realm_id, environment=EXCLUDED.environment, access_token_enc=EXCLUDED.access_token_enc,
       refresh_token_enc=EXCLUDED.refresh_token_enc, access_expires_at=EXCLUDED.access_expires_at, refresh_expires_at=EXCLUDED.refresh_expires_at,
       connected_by=EXCLUDED.connected_by, connected_at=now(), updated_at=now()`,
    [realmId, qboAppConfig().environment, cols.access_token_enc, cols.refresh_token_enc, cols.access_expires_at, cols.refresh_expires_at, user.id]);
  const client = await QboClient.load();
  const name = await client!.companyName().catch(() => null);
  if (name) await q(`UPDATE qbo_connection SET company_name=$1 WHERE id=1`, [name]);
  await audit(pool(), user.id, "qbo_connect", "qbo_connection", "1", null, { realm_id: realmId, company_name: name });
  return name;
}

export async function disconnectQbo(user: SessionUser) {
  requirePerm(user, "manage_quickbooks");
  const conn = await one(`SELECT * FROM qbo_connection WHERE id=1`);
  if (!conn) return;
  try { await revokeToken(decryptToken(conn.refresh_token_enc)); } catch { /* the tokens are deleted below either way */ }
  await q(`DELETE FROM qbo_connection WHERE id=1`);
  await q(`UPDATE qbo_settings SET enabled=false, updated_by=$1, updated_at=now() WHERE id=1`, [user.id]);
  await audit(pool(), user.id, "qbo_disconnect", "qbo_connection", "1", { realm_id: conn.realm_id }, null);
}

const settingsSchema = z.object({
  enabled: z.boolean(),
  sync_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the first date to send to QuickBooks.").or(z.literal("")),
});
export async function updateQboSettings(user: SessionUser, input: unknown) {
  requirePerm(user, "manage_quickbooks");
  const s = settingsSchema.parse(input);
  if (s.enabled && !s.sync_from) throw new AppError("Pick a start date before turning sync on. Anything dated earlier won't be sent.");
  if (s.enabled && !(await one(`SELECT 1 FROM qbo_connection WHERE id=1`))) throw new AppError("Connect QuickBooks before turning sync on.");
  const before = await one(`SELECT enabled, sync_from FROM qbo_settings WHERE id=1`);
  await q(`UPDATE qbo_settings SET enabled=$1, sync_from=$2, updated_by=$3, updated_at=now() WHERE id=1`, [s.enabled, s.sync_from || null, user.id]);
  await audit(pool(), user.id, "qbo_settings", "qbo_settings", "1", before, s);
}

const mappingSchema = z.object({
  kind: z.enum(["customer", "item", "deposit_account"]),
  local_key: z.string().min(1).max(60),
  qbo_id: z.string().max(40),
  qbo_name: z.string().max(200),
});
/** Save (or, with an empty qbo_id, remove) one mapping. */
export async function setQboMapping(user: SessionUser, input: unknown) {
  requirePerm(user, "manage_quickbooks");
  const m = mappingSchema.parse(input);
  const before = await one(`SELECT qbo_id, qbo_name FROM qbo_mappings WHERE kind=$1 AND local_key=$2`, [m.kind, m.local_key]);
  if (!m.qbo_id) {
    await q(`DELETE FROM qbo_mappings WHERE kind=$1 AND local_key=$2`, [m.kind, m.local_key]);
  } else {
    await q(`INSERT INTO qbo_mappings(kind, local_key, qbo_id, qbo_name, mapped_by) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (kind, local_key) DO UPDATE SET qbo_id=EXCLUDED.qbo_id, qbo_name=EXCLUDED.qbo_name, mapped_by=EXCLUDED.mapped_by, mapped_at=now()`,
      [m.kind, m.local_key, m.qbo_id, m.qbo_name || m.qbo_id, user.id]);
  }
  await audit(pool(), user.id, "qbo_mapping", "qbo_mapping", `${m.kind}:${m.local_key}`, before, m.qbo_id ? { qbo_id: m.qbo_id, qbo_name: m.qbo_name } : null);
}

/** Live lists from QuickBooks for the mapping dropdowns. */
export async function qboLists() {
  const c = await QboClient.load();
  if (!c) return null;
  const [items, customers, accounts] = await Promise.all([
    c.query(`select Id, Name, Type from Item where Active = true maxresults 1000`),
    c.query(`select Id, DisplayName from Customer where Active = true maxresults 1000`),
    c.query(`select Id, Name, AccountType from Account where Active = true maxresults 1000`),
  ]);
  return {
    items: (items.Item ?? []).map((i: any) => ({ id: String(i.Id), name: String(i.Name), type: i.Type })),
    customers: (customers.Customer ?? []).map((x: any) => ({ id: String(x.Id), name: String(x.DisplayName) })),
    depositAccounts: (accounts.Account ?? []).filter((a: any) => ["Bank", "Other Current Asset"].includes(a.AccountType)).map((a: any) => ({ id: String(a.Id), name: String(a.Name) })),
  };
}

export async function recentQboJobs(limit = 50, db: Db = pool()) {
  return q(`SELECT j.*, coalesce(i.invoice_number, ci.invoice_number, pi.invoice_number) AS invoice_number, cm.credit_number, p.amount AS payment_amount
            FROM qbo_sync_jobs j
            LEFT JOIN invoices i ON j.entity IN ('invoice','invoice_void') AND i.id=j.entity_id
            LEFT JOIN credit_memos cm ON j.entity='credit_memo' AND cm.id=j.entity_id
            LEFT JOIN invoices ci ON ci.id=cm.invoice_id
            LEFT JOIN payments p ON j.entity='payment' AND p.id=j.entity_id
            LEFT JOIN invoices pi ON pi.id=p.invoice_id
            ORDER BY (j.status IN ('needs_attention','pending')) DESC, j.id DESC LIMIT $1`, [limit], db);
}

export async function retryQboJob(user: SessionUser, id: string) {
  requirePerm(user, "run_quickbooks_sync");
  const j = await one(`UPDATE qbo_sync_jobs SET status='pending', locked_until=NULL WHERE id=$1 AND status IN ('needs_attention','skipped') RETURNING id`, [id]);
  if (!j) throw new AppError("Only items that need attention or weren't sent can be retried.");
  await audit(pool(), user.id, "qbo_retry", "qbo_sync_job", id, null, null);
}

// ───────────────────────── The queue ─────────────────────────
type Outcome = { status: "synced"; qbo_id: string; note?: string; link_id?: string } | { status: "needs_attention" | "skipped" | "pending"; message: string; qbo_id?: string; link_id?: string };

class Attention extends Error {}
class Wait extends Error {}

async function mapped(kind: string, key: string): Promise<string | null> {
  const m = await one(`SELECT qbo_id FROM qbo_mappings WHERE kind=$1 AND local_key=$2`, [kind, key]);
  return m?.qbo_id ?? null;
}

/** The QuickBooks customer for a Champion customer. Matches an identical name once, otherwise asks for a mapping. */
async function customerRef(c: QboClient, customerId: string): Promise<string> {
  const id = await mapped("customer", String(customerId));
  if (id) return id;
  const cust = await one(`SELECT name FROM customers WHERE id=$1`, [customerId]);
  const found = (await c.query(`select Id, DisplayName from Customer where DisplayName = ${qstr(cust.name)}`)).Customer ?? [];
  if (found.length === 1) {
    await q(`INSERT INTO qbo_mappings(kind, local_key, qbo_id, qbo_name) VALUES ('customer',$1,$2,$3) ON CONFLICT DO NOTHING`, [String(customerId), String(found[0].Id), found[0].DisplayName]);
    return String(found[0].Id);
  }
  throw new Attention(`Customer "${cust.name}" isn't matched to a QuickBooks customer. Match it on the QuickBooks page, then retry.`);
}

async function itemRefs(keys: string[]): Promise<Record<string, string>> {
  const rows = await q(`SELECT local_key, qbo_id FROM qbo_mappings WHERE kind='item' AND local_key = ANY($1)`, [keys]);
  const out = Object.fromEntries(rows.map((r: any) => [r.local_key, r.qbo_id]));
  const missing = keys.filter((k) => !out[k]);
  if (missing.length) {
    const fees = await q(`SELECT id, name FROM fee_types WHERE ('fee:' || id) = ANY($1)`, [missing]);
    const label = (k: string) => ITEM_KEYS.find((x) => x.key === k)?.label ?? `Fee: ${fees.find((f: any) => `fee:${f.id}` === k)?.name ?? k}`;
    throw new Attention(`Pick a QuickBooks item for: ${missing.map(label).join(", ")}. Then retry.`);
  }
  return out;
}

const line = (amount: string, description: string, itemId: string) => ({
  DetailType: "SalesItemLineDetail", Amount: Number(amount), Description: description.slice(0, 4000),
  // Quantity 1 at the line amount keeps QuickBooks' total identical to Champion's to the cent;
  // the quantity and rate detail stay in the description. Champion already worked out the tax.
  SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: Number(amount), TaxCodeRef: { value: "NON" } },
});

function sameMoney(a: unknown, b: unknown) { return dec(String(a ?? 0)).toFixed(2) === dec(String(b ?? 0)).toFixed(2); }

async function findInvoice(c: QboClient, number: string) {
  return ((await c.query(`select Id, TotalAmt, SyncToken from Invoice where DocNumber = ${qstr(number)}`)).Invoice ?? [])[0] ?? null;
}

/** QuickBooks id of the invoice a credit or payment belongs to. Waits while that invoice is still queued. */
async function qboInvoiceFor(c: QboClient, invoiceId: string): Promise<string> {
  const job = await one(`SELECT status, qbo_id FROM qbo_sync_jobs WHERE entity='invoice' AND entity_id=$1`, [invoiceId]);
  if (job?.qbo_id) return job.qbo_id;
  const inv = await one(`SELECT invoice_number FROM invoices WHERE id=$1`, [invoiceId]);
  const found = await findInvoice(c, inv.invoice_number);
  if (found) return String(found.Id);
  if (job && job.status !== "skipped") throw new Wait(`Waiting for invoice ${inv.invoice_number} to reach QuickBooks first.`);
  throw new Attention(`Invoice ${inv.invoice_number} isn't in QuickBooks, so this can't be applied to it. Add the invoice in QuickBooks (same number), then retry.`);
}

async function syncInvoice(c: QboClient, id: string, from: string): Promise<Outcome> {
  const inv = await one(`SELECT * FROM invoices WHERE id=$1`, [id]);
  if (!inv?.finalized_at) return { status: "skipped", message: "Invoice was never finalized." };
  if (inv.invoice_date < from) return { status: "skipped", message: `Dated before the QuickBooks start date (${from}).` };
  const voided = await one(`SELECT 1 FROM qbo_sync_jobs WHERE entity='invoice_void' AND entity_id=$1`, [id]);
  if (voided) return { status: "skipped", message: "Voided or corrected before it was sent, so it was not sent." };

  const existing = await findInvoice(c, inv.invoice_number);
  if (existing) {
    if (sameMoney(existing.TotalAmt, inv.total)) return { status: "synced", qbo_id: String(existing.Id), note: "Already in QuickBooks with the same total; linked." };
    throw new Attention(`QuickBooks already has invoice ${inv.invoice_number} with a total of ${money(existing.TotalAmt)}, not ${money(inv.total)}. Fix it in QuickBooks, then retry.`);
  }
  const lines = await q(`SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no`, [id]);
  const keys = [...new Set(lines.map(lineItemKey)), ...(dec(inv.tax_amount).gt(0) ? ["sales_tax"] : [])];
  const items = await itemRefs(keys);
  const customer = await customerRef(c, inv.customer_id);
  const unit = inv.snapshot?.equipment?.unit_number ? `Unit ${inv.snapshot.equipment.unit_number}, ` : "";
  const qboLines = lines.map((l: any) => line(l.amount, `${l.description} (${unit}${inv.period_start} to ${inv.period_end})`, items[lineItemKey(l)]));
  if (dec(inv.tax_amount).gt(0)) qboLines.push(line(inv.tax_amount, `Sales tax ${dec(inv.tax_rate).mul(100).toDecimalPlaces(3)}%`, items.sales_tax));
  const created = await c.create("Invoice", {
    DocNumber: inv.invoice_number, TxnDate: inv.invoice_date, DueDate: inv.due_date, CustomerRef: { value: customer },
    Line: qboLines,
    CustomerMemo: { value: `PO ${inv.po_number ?? "(none)"}. Billing period ${inv.period_start} to ${inv.period_end}.`.slice(0, 1000) },
    PrivateNote: `Champion Billing invoice ${inv.invoice_number}`,
  }, `champion-invoice-${id}`);
  if (!sameMoney(created.TotalAmt, inv.total))
    return { status: "needs_attention", qbo_id: String(created.Id), message: `QuickBooks shows a total of ${money(created.TotalAmt)} but Champion's is ${money(inv.total)}. Check the invoice in QuickBooks.` };
  return { status: "synced", qbo_id: String(created.Id) };
}

async function syncVoid(c: QboClient, id: string): Promise<Outcome> {
  const job = await one(`SELECT status, qbo_id FROM qbo_sync_jobs WHERE entity='invoice' AND entity_id=$1`, [id]);
  if (!job || job.status === "skipped") return { status: "skipped", message: "The invoice was never sent to QuickBooks, so there is nothing to void." };
  if (!job.qbo_id) {
    if (job.status === "pending") {
      await q(`UPDATE qbo_sync_jobs SET status='skipped', last_error='Voided or corrected before it was sent, so it was not sent.' WHERE entity='invoice' AND entity_id=$1 AND status='pending'`, [id]);
      return { status: "skipped", message: "The invoice was never sent to QuickBooks, so there is nothing to void." };
    }
    throw new Attention("The invoice needs attention in QuickBooks sync. Sort that out first, then retry.");
  }
  const inv = await c.read("Invoice", job.qbo_id);
  if (dec(String(inv.TotalAmt)).isZero() && /void/i.test(String(inv.PrivateNote ?? ""))) return { status: "synced", qbo_id: job.qbo_id, note: "Already void in QuickBooks." };
  await c.voidInvoice(job.qbo_id, String(inv.SyncToken), `champion-void-${id}`);
  return { status: "synced", qbo_id: job.qbo_id };
}

async function syncCredit(c: QboClient, id: string, from: string, prior: { qbo_id?: string | null }): Promise<Outcome> {
  const cm = await one(`SELECT * FROM credit_memos WHERE id=$1`, [id]);
  if (cm.credit_date < from) return { status: "skipped", message: `Dated before the QuickBooks start date (${from}).` };
  const invQbo = await qboInvoiceFor(c, cm.invoice_id);
  let qboId = prior.qbo_id ?? null;
  if (!qboId) {
    const found = ((await c.query(`select Id, TotalAmt from CreditMemo where DocNumber = ${qstr(cm.credit_number)}`)).CreditMemo ?? [])[0];
    if (found && !sameMoney(found.TotalAmt, cm.total)) throw new Attention(`QuickBooks already has credit ${cm.credit_number} with a different total. Fix it in QuickBooks, then retry.`);
    if (found) qboId = String(found.Id);
  }
  if (!qboId) {
    const keys = ["credit_memo", ...(dec(cm.tax_amount).gt(0) ? ["sales_tax"] : [])];
    const items = await itemRefs(keys);
    const customer = await customerRef(c, cm.customer_id);
    const lines = [line(cm.subtotal, `Credit against invoice ${cm.snapshot?.invoice?.number ?? ""}: ${cm.reason}`, items.credit_memo)];
    if (dec(cm.tax_amount).gt(0)) lines.push(line(cm.tax_amount, "Sales tax credited", items.sales_tax));
    const created = await c.create("CreditMemo", { DocNumber: cm.credit_number, TxnDate: cm.credit_date, CustomerRef: { value: customer }, Line: lines, PrivateNote: `Champion Billing credit ${cm.credit_number}` }, `champion-credit-${id}`);
    qboId = String(created.Id);
    if (!sameMoney(created.TotalAmt, cm.total))
      return { status: "needs_attention", qbo_id: qboId, message: `QuickBooks shows a credit of ${money(created.TotalAmt)} but Champion's is ${money(cm.total)}. Check it in QuickBooks.` };
    // Remember the credit memo now, so a failure applying it never creates a second one.
    await q(`UPDATE qbo_sync_jobs SET qbo_id=$2 WHERE entity='credit_memo' AND entity_id=$1`, [id, qboId]);
  }
  // Apply the credit to its invoice with a $0 payment (QuickBooks' documented way to link the two).
  const customer = await customerRef(c, cm.customer_id);
  const link = await c.create("Payment", {
    CustomerRef: { value: customer }, TotalAmt: 0, TxnDate: cm.credit_date,
    Line: [
      { Amount: Number(cm.total), LinkedTxn: [{ TxnId: invQbo, TxnType: "Invoice" }] },
      { Amount: Number(cm.total), LinkedTxn: [{ TxnId: qboId, TxnType: "CreditMemo" }] },
    ],
    PrivateNote: `Applies credit ${cm.credit_number}`,
  }, `champion-credit-apply-${id}`);
  return { status: "synced", qbo_id: qboId, link_id: String(link.Id) };
}

async function syncPayment(c: QboClient, id: string, from: string): Promise<Outcome> {
  const p = await one(`SELECT p.*, i.customer_id, i.invoice_number FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.id=$1`, [id]);
  if (p.paid_on < from) return { status: "skipped", message: `Dated before the QuickBooks start date (${from}).` };
  const invQbo = await qboInvoiceFor(c, p.invoice_id);
  const customer = await customerRef(c, p.customer_id);
  const deposit = await mapped("deposit_account", "default");
  const created = await c.create("Payment", {
    CustomerRef: { value: customer }, TotalAmt: Number(p.amount), TxnDate: p.paid_on,
    ...(p.reference ? { PaymentRefNum: String(p.reference).slice(0, 21) } : {}),
    ...(deposit ? { DepositToAccountRef: { value: deposit } } : {}),
    Line: [{ Amount: Number(p.amount), LinkedTxn: [{ TxnId: invQbo, TxnType: "Invoice" }] }],
    PrivateNote: `Champion Billing payment on invoice ${p.invoice_number}${p.method ? ` (${p.method})` : ""}`,
  }, `champion-payment-${id}`);
  return { status: "synced", qbo_id: String(created.Id) };
}

async function claimNext(after: number): Promise<any | null> {
  return one(`UPDATE qbo_sync_jobs SET locked_until=now() + interval '2 minutes', attempts=attempts+1, last_attempt_at=now()
              WHERE id = (SELECT id FROM qbo_sync_jobs WHERE status IN ('pending','needs_attention')
                            AND (locked_until IS NULL OR locked_until < now()) AND id > $1
                          ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
              RETURNING *`, [after]);
}

/**
 * Send queued items to QuickBooks, oldest first. Safe to run at any time and from several places
 * at once. Returns what happened. Does nothing while sync is off or QuickBooks isn't connected.
 */
export async function processQboQueue(opts: { limit?: number } = {}) {
  const result = { synced: 0, needs_attention: 0, skipped: 0, waiting: 0, ran: false };
  const s = await one(`SELECT enabled, sync_from::text AS sync_from FROM qbo_settings WHERE id=1`);
  if (!s?.enabled || !s.sync_from) return result;
  const c = await QboClient.load();
  if (!c) return result;
  result.ran = true;
  const limit = opts.limit ?? 100;
  let after = 0; // each item is tried at most once per run
  for (let n = 0; n < limit; n++) {
    const job = await claimNext(after);
    if (!job) break;
    after = Number(job.id);
    let out: Outcome;
    try {
      if (job.entity === "invoice") out = await syncInvoice(c, job.entity_id, s.sync_from);
      else if (job.entity === "invoice_void") out = await syncVoid(c, job.entity_id);
      else if (job.entity === "credit_memo") out = await syncCredit(c, job.entity_id, s.sync_from, job);
      else out = await syncPayment(c, job.entity_id, s.sync_from);
    } catch (e: any) {
      if (e instanceof Wait) out = { status: "pending", message: e.message };
      else if (e instanceof Attention) out = { status: "needs_attention", message: e.message };
      else if (e instanceof QboError) out = { status: "needs_attention", message: `QuickBooks said: ${e.message}` };
      else out = { status: "needs_attention", message: `Couldn't reach QuickBooks: ${e?.message ?? e}` };
    }
    const qboId = out.qbo_id ?? job.qbo_id ?? null;
    const msg = out.status === "synced" ? out.note ?? null : out.message;
    await q(`UPDATE qbo_sync_jobs SET status=$2, qbo_id=$3, qbo_link_id=coalesce($4, qbo_link_id), last_error=$5, locked_until=NULL,
                    synced_at=CASE WHEN $2='synced' THEN now() ELSE synced_at END WHERE id=$1`,
      [job.id, out.status, qboId, out.link_id ?? null, msg]);
    if (out.status === "pending") result.waiting++; else result[out.status]++;
  }
  return result;
}

/** Run a short sync right after an invoice, credit or payment is recorded. Never throws. */
export async function kickQboSync() {
  try { await processQboQueue({ limit: 10 }); } catch (e) { console.error("QuickBooks sync", e); }
}

export async function runQboSyncNow(user: SessionUser) {
  requirePerm(user, "run_quickbooks_sync");
  const s = await one(`SELECT enabled FROM qbo_settings WHERE id=1`);
  if (!s.enabled) throw new AppError("QuickBooks sync is off. Turn it on first.");
  return processQboQueue();
}
