// QuickBooks Online sync, against a fake QuickBooks (no network).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { assignPo } from "@/lib/services/pos";
import { approveInvoice, generateInvoice, issueInvoice, overrideCheck, recordPayment, submitForReview, validateInvoice, voidInvoice } from "@/lib/services/invoices";
import { issueCredit } from "@/lib/services/credits";
import { ITEM_KEYS, processQboQueue, retryQboJob, runQboSyncNow, setQboMapping, updateQboSettings } from "@/lib/services/quickbooks";
import { decryptToken, encryptToken, setQboFetch, tokenColumns } from "@/lib/qbo/client";
import { todayCentral } from "@/lib/dates";
import { RPM_SAMPLE_UNITS } from "@/lib/sample-data";
import { lineForUnit, resetDb, userByRole } from "./helpers";

let admin: SessionUser, manager: SessionUser, clerk: SessionUser, rpmName: string;

// ───────── Fake QuickBooks
const fake = {
  invoices: [] as any[], creditMemos: [] as any[], payments: [] as any[], customers: [] as any[],
  items: [{ Id: "1", Name: "Equipment rental", Type: "Service" }, { Id: "2", Name: "Fees", Type: "Service" }, { Id: "3", Name: "Sales tax", Type: "Service" }],
  requestIds: new Set<string>(), refreshes: 0, calls: 0, nextId: 100,
};
const total = (lines: any[]) => lines.reduce((s, l) => s + Math.round(Number(l.Amount) * 100), 0) / 100;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function fakeFetch(input: any, init?: any): Promise<Response> {
  const url = new URL(String(input));
  fake.calls++;
  if (url.pathname.endsWith("/tokens/bearer")) {
    fake.refreshes++;
    return json({ access_token: `access-${fake.refreshes}`, refresh_token: `refresh-${fake.refreshes}`, expires_in: 3600, x_refresh_token_expires_in: 8640000 });
  }
  const auth = (init?.headers as any)?.Authorization;
  if (!auth?.startsWith("Bearer access-")) return json({ Fault: { Error: [{ Message: "AuthenticationFailed" }] } }, 401);
  const path = url.pathname.split("/v3/company/123/")[1];
  if (path === "query") {
    const sql = url.searchParams.get("query")!;
    const m = sql.match(/from (\w+)(?: where (\w+) = '((?:[^'\\]|\\.)*)')?/i)!;
    const [, entity, field, raw] = m;
    const val = raw?.replace(/\\(.)/g, "$1");
    const pick: Record<string, any[]> = { Invoice: fake.invoices, CreditMemo: fake.creditMemos, Customer: fake.customers, Item: fake.items, Account: [] };
    const rows = (pick[entity] ?? []).filter((r) => !field || String(r[field]) === val);
    return json({ QueryResponse: rows.length ? { [entity]: rows } : {} });
  }
  if (path?.startsWith("companyinfo/")) return json({ CompanyInfo: { CompanyName: "Champion Equipment (test)" } });
  if (path?.startsWith("invoice/") && init?.method === "GET") return json({ Invoice: fake.invoices.find((i) => i.Id === path.split("/")[1]) });
  const rid = url.searchParams.get("requestid");
  const body = init?.body ? JSON.parse(init.body) : null;
  if (path === "invoice" && url.searchParams.get("operation") === "void") {
    const inv = fake.invoices.find((i) => i.Id === body.Id)!;
    inv.TotalAmt = 0; inv.PrivateNote = "Voided"; inv.SyncToken = String(Number(inv.SyncToken) + 1);
    return json({ Invoice: inv });
  }
  const store: Record<string, [any[], string]> = { invoice: [fake.invoices, "Invoice"], creditmemo: [fake.creditMemos, "CreditMemo"], payment: [fake.payments, "Payment"] };
  if (store[path]) {
    const [list, name] = store[path];
    if (rid && fake.requestIds.has(rid)) return json({ [name]: list.find((x) => x._rid === rid) });
    if (rid) fake.requestIds.add(rid);
    const obj = { ...body, Id: String(fake.nextId++), SyncToken: "0", TotalAmt: body.TotalAmt ?? total(body.Line), _rid: rid };
    list.push(obj);
    return json({ [name]: obj });
  }
  return json({ Fault: { Error: [{ Message: `Unknown ${path}` }] } }, 400);
}

async function approveFor(i: number) {
  const u = RPM_SAMPLE_UNITS[i];
  const line = await lineForUnit(u.unit);
  await assignPo(clerk, { lineId: line, period: "2026-11-01", poNumber: u.po, estimatedTotal: u.poTotal, jobNumber: u.job, workOrderNumber: u.wo });
  const inv = await generateInvoice(clerk, line, "2026-11-01");
  await submitForReview(clerk, inv.id);
  for (const c of (await validateInvoice(inv.id)).filter((c) => (c.status === "fail" || c.status === "warn") && c.overridable && !c.override)) await overrideCheck(manager, inv.id, c.rule, "Test: accepted");
  await approveInvoice(manager, inv.id);
  return one(`SELECT * FROM invoices WHERE id=$1`, [inv.id]);
}
const job = (entity: string, id: string) => one(`SELECT * FROM qbo_sync_jobs WHERE entity=$1 AND entity_id=$2`, [entity, id]);

async function connect(expiresInSeconds = 3600) {
  const cols = tokenColumns({ access_token: "access-0", refresh_token: "refresh-0", expires_in: expiresInSeconds });
  await q(`INSERT INTO qbo_connection(id, realm_id, environment, access_token_enc, refresh_token_enc, access_expires_at, connected_by)
           VALUES (1,'123','sandbox',$1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET access_token_enc=EXCLUDED.access_token_enc, refresh_token_enc=EXCLUDED.refresh_token_enc, access_expires_at=EXCLUDED.access_expires_at`,
    [cols.access_token_enc, cols.refresh_token_enc, cols.access_expires_at, admin.id]);
}

beforeAll(async () => {
  process.env.QBO_CLIENT_ID = "test-client";
  process.env.QBO_CLIENT_SECRET = "test-secret-for-encryption";
  const seeded = await resetDb();
  [admin, manager, clerk] = await Promise.all(["admin", "billing_manager", "billing_clerk"].map(userByRole));
  rpmName = (await one(`SELECT name FROM customers WHERE id=$1`, [seeded.rpmId])).name;
  fake.customers.push({ Id: "55", DisplayName: rpmName });
  setQboFetch(fakeFetch as any);
});
afterAll(() => setQboFetch(null));

describe("Tokens", () => {
  it("are stored encrypted and read back", () => {
    const enc = encryptToken("secret-refresh-token");
    expect(enc).not.toContain("secret-refresh-token");
    expect(decryptToken(enc)).toBe("secret-refresh-token");
  });
});

describe("QuickBooks sync", () => {
  let inv1: any;

  it("queues an invoice when it's approved, but sends nothing while sync is off", async () => {
    inv1 = await approveFor(0);
    expect((await job("invoice", inv1.id)).status).toBe("pending");
    expect((await processQboQueue()).ran).toBe(false);
    await expect(updateQboSettings(admin, { enabled: true, sync_from: "2026-01-01" })).rejects.toThrow(/Connect QuickBooks/);
    await expect(updateQboSettings(manager, { enabled: false, sync_from: "" })).rejects.toThrow(/permission/);
    await connect();
    await expect(updateQboSettings(admin, { enabled: true, sync_from: "" })).rejects.toThrow(/start date/);
    await updateQboSettings(admin, { enabled: true, sync_from: "2026-01-01" });
  });

  it("asks for item matches instead of guessing, then sends the invoice once with the same total", async () => {
    let r = await processQboQueue();
    expect(r.needs_attention).toBe(1);
    expect((await job("invoice", inv1.id)).last_error).toMatch(/Pick a QuickBooks item for: Rental/);
    expect(fake.invoices).toHaveLength(0);

    for (const k of ITEM_KEYS) await setQboMapping(admin, { kind: "item", local_key: k.key, qbo_id: k.key === "rental" ? "1" : k.key === "sales_tax" ? "3" : "2", qbo_name: "x" });
    r = await processQboQueue();
    expect(r.synced).toBe(1);
    const j = await job("invoice", inv1.id);
    expect(j.status).toBe("synced");
    expect(fake.invoices).toHaveLength(1);
    const sent = fake.invoices[0];
    expect(sent.DocNumber).toBe(inv1.invoice_number);
    expect(sent.CustomerRef.value).toBe("55"); // matched by identical name
    expect(Number(sent.TotalAmt).toFixed(2)).toBe(inv1.total);
    expect(sent.CustomerMemo.value).toContain(`PO ${inv1.po_number}`);
    expect(await one(`SELECT qbo_id FROM qbo_mappings WHERE kind='customer'`)).toMatchObject({ qbo_id: "55" });

    // Running again never sends it twice, and a synced record can't be changed or deleted.
    await processQboQueue();
    expect(fake.invoices).toHaveLength(1);
    await expect(q(`UPDATE qbo_sync_jobs SET status='pending' WHERE id=$1`, [j.id])).rejects.toThrow(/read-only/);
    await expect(q(`DELETE FROM qbo_sync_jobs WHERE id=$1`, [j.id])).rejects.toThrow(/cannot be deleted/);
    await expect(retryQboJob(admin, j.id)).rejects.toThrow(/Only items/);
    // The invoice itself is untouched by syncing.
    expect((await one(`SELECT total, status FROM invoices WHERE id=$1`, [inv1.id]))).toMatchObject({ total: inv1.total, status: "approved" });
  });

  it("sends payments and credit memos, applied to their invoice", async () => {
    await issueInvoice(manager, inv1.id);
    await recordPayment(clerk, inv1.id, { amount: "100.00", paid_on: todayCentral(), reference: "CHK 1001" });
    const credit = await issueCredit(manager, inv1.id, { amount: "50.00", reason: "Machine down two days" });
    const r = await processQboQueue();
    expect(r.synced).toBe(2);
    const pay = fake.payments.find((p) => p.TotalAmt === 100)!;
    expect(pay.Line[0].LinkedTxn[0]).toEqual({ TxnId: fake.invoices[0].Id, TxnType: "Invoice" });
    expect(pay.PaymentRefNum).toBe("CHK 1001");
    const cm = fake.creditMemos[0];
    expect(cm.DocNumber).toBe(credit.credit_number);
    expect(Number(cm.TotalAmt).toFixed(2)).toBe(credit.total);
    const apply = fake.payments.find((p) => p.TotalAmt === 0)!;
    expect(apply.Line.map((l: any) => l.LinkedTxn[0].TxnType)).toEqual(["Invoice", "CreditMemo"]);
    expect((await job("credit_memo", credit.id)).qbo_link_id).toBe(apply.Id);
  });

  it("links an invoice already typed into QuickBooks instead of duplicating it, and flags a total that differs", async () => {
    const a = await approveFor(1);
    const b = await approveFor(2);
    fake.invoices.push({ Id: "900", DocNumber: a.invoice_number, TotalAmt: Number(a.total), SyncToken: "0" });
    fake.invoices.push({ Id: "901", DocNumber: b.invoice_number, TotalAmt: Number(b.total) + 1, SyncToken: "0" });
    const before = fake.invoices.length;
    await processQboQueue();
    expect(fake.invoices.length).toBe(before);
    expect(await job("invoice", a.id)).toMatchObject({ status: "synced", qbo_id: "900" });
    expect((await job("invoice", b.id)).status).toBe("needs_attention");
    expect((await job("invoice", b.id)).last_error).toMatch(/already has invoice/);
  });

  it("voids a sent invoice in QuickBooks when it's voided here", async () => {
    const inv = await approveFor(3);
    await processQboQueue();
    const qboId = (await job("invoice", inv.id)).qbo_id;
    await voidInvoice(manager, inv.id, "Wrong PO on this one");
    await processQboQueue();
    expect(await job("invoice_void", inv.id)).toMatchObject({ status: "synced" });
    expect(fake.invoices.find((i) => i.Id === qboId)!.PrivateNote).toBe("Voided");
  });

  it("never sends anything dated before the start date, and refreshes an expired sign-in", async () => {
    await updateQboSettings(admin, { enabled: true, sync_from: "2099-01-01" });
    const inv = await approveFor(4);
    await processQboQueue();
    expect(await job("invoice", inv.id)).toMatchObject({ status: "skipped" });
    await updateQboSettings(admin, { enabled: true, sync_from: "2026-01-01" });

    await connect(-10); // access token already expired
    const refreshes = fake.refreshes;
    await retryQboJob(manager, (await job("invoice", inv.id)).id);
    await expect(retryQboJob(clerk, (await job("invoice", inv.id)).id)).rejects.toThrow(/permission/);
    await runQboSyncNow(manager);
    expect(fake.refreshes).toBe(refreshes + 1);
    expect(await job("invoice", inv.id)).toMatchObject({ status: "synced" });
    const conn = await one(`SELECT refresh_token_enc FROM qbo_connection`);
    expect(decryptToken(conn.refresh_token_enc)).toBe(`refresh-${fake.refreshes}`);
    await expect(runQboSyncNow(clerk)).rejects.toThrow(/permission/);
  });
});
