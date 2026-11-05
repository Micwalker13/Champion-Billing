// Credit limits and credit holds stop NEW rentals only, with an audited manager override.
import { beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { assignPo } from "@/lib/services/pos";
import { approveInvoice, generateInvoice, issueInvoice, overrideCheck, submitForReview, validateInvoice } from "@/lib/services/invoices";
import { createEquipment, createRental } from "@/lib/services/records";
import { creditStatus, setCreditTerms } from "@/lib/services/credit";
import { addDays, todayCentral } from "@/lib/dates";
import { RPM_SAMPLE_UNITS } from "@/lib/sample-data";
import { lineForUnit, resetDb, userByRole } from "./helpers";

let admin: SessionUser, manager: SessionUser, clerk: SessionUser, rpmId: string, owed: string;
const rental = (unit: string, start: string) => ({ contract_number: `CR-${unit}`, customer_id: rpmId, unit_number: unit, start_date: start, rate_amount: "1000.00", rate_basis: "monthly" });

beforeAll(async () => {
  rpmId = (await resetDb()).rpmId;
  [admin, manager, clerk] = await Promise.all(["admin", "billing_manager", "billing_clerk"].map(userByRole));
  const u = RPM_SAMPLE_UNITS[0];
  const line = await lineForUnit(u.unit);
  await assignPo(clerk, { lineId: line, period: "2026-11-01", poNumber: u.po, estimatedTotal: u.poTotal, jobNumber: u.job, workOrderNumber: u.wo });
  const inv = await generateInvoice(clerk, line, "2026-11-01");
  await submitForReview(clerk, inv.id);
  for (const c of (await validateInvoice(inv.id)).filter((c) => (c.status === "fail" || c.status === "warn") && c.overridable && !c.override)) await overrideCheck(manager, inv.id, c.rule, "Test: accepted");
  await approveInvoice(manager, inv.id);
  await issueInvoice(manager, inv.id);
  owed = (await one(`SELECT total FROM invoices WHERE id=$1`, [inv.id])).total;
  for (const n of ["CR01", "CR02", "CR03", "CR04"]) await createEquipment(admin, { unit_number: n, description: "Credit test unit" });
});

describe("Credit limits", () => {
  it("does nothing until a limit or hold is set", async () => {
    const s = await creditStatus(rpmId);
    expect(s).toMatchObject({ limit: null, hold: false, owed, blocked: null, available: null });
    await createRental(clerk, rental("CR01", addDays(todayCentral(), 1)));
  });

  it("only a manager or admin sets terms, and a hold needs a reason", async () => {
    await expect(setCreditTerms(clerk, rpmId, { credit_limit: "100", credit_hold: false, credit_note: "" })).rejects.toThrow(/permission/);
    await expect(setCreditTerms(manager, rpmId, { credit_limit: "abc", credit_hold: false, credit_note: "" })).rejects.toThrow(/dollar/);
    await expect(setCreditTerms(manager, rpmId, { credit_limit: "", credit_hold: true, credit_note: "" })).rejects.toThrow(/why/);
    await setCreditTerms(manager, rpmId, { credit_limit: "$1,000", credit_hold: false, credit_note: "" });
    const s = await creditStatus(rpmId);
    expect(s.limit).toBe("1000.00");
    expect(Number(s.available)).toBeCloseTo(1000 - Number(owed), 2);
    expect(s.blocked).toMatch(/over its \$1,000\.00 credit limit/);
  });

  it("over the limit, a new rental is stopped unless a manager overrides with a reason", async () => {
    const start = todayCentral();
    await expect(createRental(clerk, rental("CR02", start))).rejects.toThrow(/credit limit/);
    await expect(createRental(clerk, rental("CR02", start), { creditOverrideReason: "Paying Friday" })).rejects.toThrow(/Only a billing manager/);
    await expect(createRental(manager, rental("CR02", start), { creditOverrideReason: "ok" })).rejects.toThrow(/short reason/);
    expect(await one(`SELECT 1 FROM rental_contracts WHERE contract_number='CR-CR02'`)).toBeFalsy();
    await createRental(manager, rental("CR02", start), { creditOverrideReason: "Customer paying Friday, approved by Michael" });
    const a = await one(`SELECT after FROM audit_log WHERE action='credit_override' ORDER BY id DESC LIMIT 1`);
    expect(a.after.reason).toMatch(/paying Friday/);
  });

  it("a rental that already started (entered from Quipli) is never stopped", async () => {
    await createRental(clerk, rental("CR03", addDays(todayCentral(), -10)));
  });

  it("a credit hold stops new rentals even under the limit; lifting it clears the block", async () => {
    await setCreditTerms(admin, rpmId, { credit_limit: "", credit_hold: true, credit_note: "Bounced check" });
    await expect(createRental(clerk, rental("CR04", todayCentral()))).rejects.toThrow(/credit hold \(Bounced check\)/);
    await setCreditTerms(admin, rpmId, { credit_limit: "", credit_hold: false, credit_note: "" });
    await createRental(clerk, rental("CR04", todayCentral()));
    // Existing rentals and invoices were never touched.
    expect((await q(`SELECT 1 FROM audit_log WHERE action='credit_terms'`)).length).toBe(3);
  });
});
