// Customer portal: emailed one-time sign-in, customer-only views, and requests an employee handles.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { assignPo } from "@/lib/services/pos";
import { approveInvoice, generateInvoice, issueInvoice, overrideCheck, submitForReview, validateInvoice } from "@/lib/services/invoices";
import { createCustomer } from "@/lib/services/records";
import { setTestSender } from "@/lib/services/email";
import {
  acceptPortalCoi, closePortalRequest, consumePortalLink, invitePortalUser, listPortalRequests, openPortalRequestCount, portalInvoicePdf,
  portalLogout, portalOverview, portalUserForToken, requestPortalLink, setPortalUserActive, submitPortalRequest,
} from "@/lib/services/portal";
import { RPM_SAMPLE_UNITS } from "@/lib/sample-data";
import { lineForUnit, resetDb, userByRole } from "./helpers";

let admin: SessionUser, manager: SessionUser, clerk: SessionUser, rpmId: string, otherId: string;
let issuedId: string, draftId: string;
const sent: any[] = [];
const ORIGIN = "https://billing.example.com";
const tokenFrom = (m: any) => /token=([A-Za-z0-9_-]+)/.exec(m.text)![1];
const pdf = { filename: "coi.pdf", mime: "application/pdf", content: Buffer.from("%PDF-1.4 test certificate") };

async function signIn(email: string) {
  await q(`DELETE FROM portal_login_tokens`); // stay under the hourly link limit
  const n = sent.length;
  await requestPortalLink(email, ORIGIN);
  expect(sent.length).toBe(n + 1);
  const s = await consumePortalLink(tokenFrom(sent[n]));
  return (await portalUserForToken(s!.token))!;
}

beforeAll(async () => {
  const seeded = await resetDb();
  rpmId = seeded.rpmId;
  [admin, manager, clerk] = await Promise.all(["admin", "billing_manager", "billing_clerk"].map(userByRole));
  otherId = (await createCustomer(admin, { customer_code: "OTHER", name: "Other Builders", billing_address: "1 Main St" })).id;
  const u = RPM_SAMPLE_UNITS[0];
  const line = await lineForUnit(u.unit);
  await assignPo(clerk, { lineId: line, period: "2026-11-01", poNumber: u.po, estimatedTotal: u.poTotal, jobNumber: u.job, workOrderNumber: u.wo });
  const inv = await generateInvoice(clerk, line, "2026-11-01");
  await submitForReview(clerk, inv.id);
  for (const c of (await validateInvoice(inv.id)).filter((c) => (c.status === "fail" || c.status === "warn") && c.overridable && !c.override)) await overrideCheck(manager, inv.id, c.rule, "Test: accepted");
  await approveInvoice(manager, inv.id);
  await issueInvoice(manager, inv.id);
  issuedId = inv.id;
  draftId = (await generateInvoice(clerk, await lineForUnit(RPM_SAMPLE_UNITS[1].unit), "2026-11-01")).id;
  setTestSender(async (m) => { sent.push(m); return { messageId: `<test-${sent.length}@local>` }; });
});
afterAll(() => setTestSender(null));

describe("Giving access and signing in", () => {
  it("only an administrator or billing manager can invite, and the invite emails a one-time link", async () => {
    await expect(invitePortalUser(clerk, rpmId, { email: "pm@rpm.example", name: "Pat Manager" }, ORIGIN)).rejects.toThrow(/permission/);
    await expect(invitePortalUser(manager, rpmId, { email: "a@x.com, b@x.com", name: "Two People" }, ORIGIN)).rejects.toThrow(/one email/);
    const pu = await invitePortalUser(manager, rpmId, { email: "PM@RPM.example", name: "Pat Manager" }, ORIGIN);
    expect(pu.email).toBe("pm@rpm.example");
    const m = sent.at(-1);
    expect(m.to).toContain("pm@rpm.example");
    expect(m.text).toContain(`${ORIGIN}/portal/auth?token=`);
    // Only a hash of the link is stored.
    const t = tokenFrom(m);
    expect((await q(`SELECT 1 FROM portal_login_tokens WHERE token_hash=$1`, [t])).length).toBe(0);
    // The link works once.
    const s = await consumePortalLink(t);
    expect(s).not.toBeNull();
    expect((await portalUserForToken(s!.token))!.customer_id).toBe(String(rpmId));
    expect(await consumePortalLink(t)).toBeNull();
    // One address can't belong to two customers.
    await expect(invitePortalUser(manager, otherId, { email: "pm@rpm.example", name: "Pat Again" }, ORIGIN)).rejects.toThrow(/different customer/);
  });

  it("asking for a link reveals nothing about unknown addresses, and is rate limited", async () => {
    const n = sent.length;
    await expect(requestPortalLink("nobody@nowhere.example", ORIGIN)).resolves.toBeUndefined();
    await expect(requestPortalLink("not an email", ORIGIN)).resolves.toBeUndefined();
    expect(sent.length).toBe(n);
    for (let i = 0; i < 8; i++) await requestPortalLink("pm@rpm.example", ORIGIN);
    const perHour = await one(`SELECT count(*)::int AS n FROM portal_login_tokens t JOIN portal_users p ON p.id=t.portal_user_id WHERE p.email='pm@rpm.example' AND t.created_at > now() - interval '1 hour'`);
    expect(perHour.n).toBe(5);
  });

  it("an expired link doesn't work", async () => {
    await q(`DELETE FROM portal_login_tokens`);
    const n = sent.length;
    await requestPortalLink("pm@rpm.example", ORIGIN);
    const t = tokenFrom(sent[n]);
    await q(`UPDATE portal_login_tokens SET expires_at = now() - interval '1 minute'`);
    expect(await consumePortalLink(t)).toBeNull();
  });

  it("turning access off signs the person out and kills unused links; sign out ends the session", async () => {
    await q(`DELETE FROM portal_login_tokens`);
    const n = sent.length;
    await requestPortalLink("pm@rpm.example", ORIGIN);
    const s = (await consumePortalLink(tokenFrom(sent[n])))!;
    await requestPortalLink("pm@rpm.example", ORIGIN);
    const unused = tokenFrom(sent[n + 1]);
    const pu = (await portalUserForToken(s.token))!;
    await expect(setPortalUserActive(clerk, pu.id, false)).rejects.toThrow(/permission/);
    await setPortalUserActive(admin, pu.id, false);
    expect(await portalUserForToken(s.token)).toBeNull();
    expect(await consumePortalLink(unused)).toBeNull();
    await requestPortalLink("pm@rpm.example", ORIGIN);
    expect(sent.length).toBe(n + 2); // no link for a disabled person
    await setPortalUserActive(admin, pu.id, true);
    const again = await signIn("pm@rpm.example");
    const tok = (await q(`SELECT token_hash FROM portal_sessions WHERE portal_user_id=$1`, [again.id])).length;
    expect(tok).toBe(1);
  });
});

describe("What a customer sees", () => {
  it("sees only its own finished invoices and rentals, and can't open another customer's PDF", async () => {
    await q(`DELETE FROM portal_login_tokens`);
    const rpm = await signIn("pm@rpm.example");
    const o = await portalOverview(rpm);
    expect(o.invoices.map((i: any) => i.id)).toContain(issuedId);
    expect(o.invoices.map((i: any) => i.id)).not.toContain(draftId);
    expect(o.rentals.length).toBeGreaterThan(0);
    expect(Number(o.openBalance)).toBeGreaterThan(0);
    const r = await portalInvoicePdf(rpm, issuedId);
    expect(Buffer.from(r.pdf).subarray(0, 4).toString()).toBe("%PDF");
    await expect(portalInvoicePdf(rpm, draftId)).rejects.toThrow(/Not found/);

    await invitePortalUser(admin, otherId, { email: "boss@other.example", name: "Other Boss" }, ORIGIN);
    const other = await signIn("boss@other.example");
    const oo = await portalOverview(other);
    expect(oo.invoices).toHaveLength(0);
    expect(oo.rentals).toHaveLength(0);
    await expect(portalInvoicePdf(other, issuedId)).rejects.toThrow(/Not found/);
    await expect(portalInvoicePdf(other, "1 OR 1=1")).rejects.toThrow(/Not found/);
  });
});

describe("Requests", () => {
  it("checks each request, and only the customer's own machines can be picked", async () => {
    const rpm = await signIn("pm@rpm.example");
    const other = await signIn("boss@other.example");
    const line = await lineForUnit(RPM_SAMPLE_UNITS[0].unit);
    await expect(submitPortalRequest(rpm, { kind: "pickup", contract_line_id: line })).rejects.toThrow(/date/);
    await expect(submitPortalRequest(other, { kind: "pickup", contract_line_id: line, requested_date: "2026-11-20" })).rejects.toThrow(/Pick the machine/);
    await expect(submitPortalRequest(rpm, { kind: "question", message: "  " })).rejects.toThrow(/question/);
    await expect(submitPortalRequest(rpm, { kind: "coi" })).rejects.toThrow(/Attach/);
    await expect(submitPortalRequest(rpm, { kind: "coi", file: { filename: "x.html", mime: "text/html", content: Buffer.from("<script>") } })).rejects.toThrow(/PDF/);
    await expect(submitPortalRequest(rpm, { kind: "refund" })).rejects.toThrow();

    const before = await one(`SELECT status, off_rent_date FROM rental_contract_lines WHERE id=$1`, [line]);
    const req = await submitPortalRequest(rpm, { kind: "pickup", contract_line_id: line, requested_date: "2026-11-20", message: "Gate code 1234" });
    // Nothing on the rental changes by itself.
    expect(await one(`SELECT status, off_rent_date FROM rental_contract_lines WHERE id=$1`, [line])).toEqual(before);
    expect(await openPortalRequestCount()).toBe(1);
    await expect(closePortalRequest(admin, req.id, { status: "declined", response: "" })).rejects.toThrow(/why/);
    await closePortalRequest(clerk, req.id, { status: "done", response: "Pickup set for Nov 20." });
    await expect(closePortalRequest(clerk, req.id, { status: "done", response: "again" })).rejects.toThrow(/open/);
    const mine = (await portalOverview(rpm)).requests;
    expect(mine[0]).toMatchObject({ status: "done", response: "Pickup set for Nov 20." });
    expect((await portalOverview(other)).requests).toHaveLength(0);
  });

  it("a certificate from the portal counts only after an employee files it", async () => {
    const rpm = await signIn("pm@rpm.example");
    const req = await submitPortalRequest(rpm, { kind: "coi", file: pdf, coi_insurer: "Acme Mutual", coi_effective_on: "2026-01-01", coi_expires_on: "2027-01-01" });
    expect((await q(`SELECT 1 FROM customer_insurance_certificates WHERE customer_id=$1 AND removed_at IS NULL`, [rpmId])).length).toBe(0);
    const open = (await listPortalRequests({ status: "open" })).find((r: any) => r.id === req.id);
    expect(open.file_name).toBe("coi.pdf");
    const coi = await acceptPortalCoi(clerk, req.id, { insurer: "Acme Mutual", effective_on: "2026-01-01", expires_on: "2027-01-01" });
    expect(coi.insurer).toBe("Acme Mutual");
    const filed = await one(`SELECT content FROM customer_insurance_certificates WHERE id=$1`, [coi.id]);
    expect(Buffer.from(filed.content).toString()).toBe(pdf.content.toString());
    expect((await one(`SELECT status FROM portal_requests WHERE id=$1`, [req.id])).status).toBe("done");
    await expect(acceptPortalCoi(clerk, req.id, { insurer: "Acme Mutual", effective_on: "2026-01-01", expires_on: "2027-01-01" })).rejects.toThrow(/open/);
  });

  it("sign out ends the session", async () => {
    await q(`DELETE FROM portal_login_tokens`);
    const n = sent.length;
    await requestPortalLink("pm@rpm.example", ORIGIN);
    const s = (await consumePortalLink(tokenFrom(sent[n])))!;
    await portalLogout(s.token);
    expect(await portalUserForToken(s.token)).toBeNull();
  });
});
