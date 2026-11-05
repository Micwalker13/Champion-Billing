// Damage waiver vs. the customer's own certificate of insurance (COI).
import { beforeAll, describe, expect, it } from "vitest";
import { q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { assignPo } from "@/lib/services/pos";
import { generateInvoice, refreshInvoice, validateInvoice } from "@/lib/services/invoices";
import { updateUsageSettings } from "@/lib/services/usage";
import { coiAlerts, coiCovering, rdwDecision, removeCoi, setRdwChoice, uploadCoi } from "@/lib/services/insurance";
import { RPM_SAMPLE_UNITS } from "@/lib/sample-data";
import { lineForUnit, resetDb, userByRole } from "./helpers";

let admin: SessionUser, manager: SessionUser, clerk: SessionUser, rpmId: string;
const pdf = { filename: "coi.pdf", mime: "application/pdf", content: Buffer.from("%PDF-1.4 test certificate") };
const settings = { overtime_enabled: false, hours_per_day: "8", hours_per_week: "40", hours_per_month: "160", overtime_multiplier: "1.5", damage_waiver_pct: "14", environmental_pct: "4", fuel_price_per_gallon: "9" };
const kinds = async (id: string) => (await q(`SELECT kind, amount FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no`, [id]));

async function draftFor(i: number) {
  const u = RPM_SAMPLE_UNITS[i];
  const line = await lineForUnit(u.unit);
  await assignPo(clerk, { lineId: line, period: "2026-11-01", poNumber: u.po, estimatedTotal: u.poTotal, jobNumber: u.job, workOrderNumber: u.wo });
  return generateInvoice(clerk, line, "2026-11-01");
}

beforeAll(async () => {
  const seeded = await resetDb();
  rpmId = seeded.rpmId;
  [admin, manager, clerk] = await Promise.all(["admin", "billing_manager", "billing_clerk"].map(userByRole));
  await updateUsageSettings(admin, rpmId, settings);
});

describe("Which certificate covers a period", () => {
  const c = (id: string, from: string, to: string) => ({ id, insurer: "X", policy_number: null, effective_on: from, expires_on: to, filename: "f" });
  it("needs the whole period covered", () => {
    expect(coiCovering([c("1", "2026-01-01", "2026-12-31")], "2026-11-01", "2026-11-30")?.id).toBe("1");
    expect(coiCovering([c("1", "2026-01-01", "2026-11-15")], "2026-11-01", "2026-11-30")).toBeNull();
    expect(coiCovering([c("1", "2026-11-10", "2027-11-10")], "2026-11-01", "2026-11-30")).toBeNull();
  });
  it("bills the waiver unless the customer chose COI and a certificate covers the period", () => {
    const base = { pct: "0.1400", lineWaived: false, start: "2026-11-01", end: "2026-11-30" };
    expect(rdwDecision({ ...base, pct: null, choice: "rdw", cois: [] }).status).toBe("off");
    expect(rdwDecision({ ...base, choice: "rdw", cois: [c("1", "2026-01-01", "2027-01-01")] })).toEqual({ status: "billed", reason: "rdw" });
    expect(rdwDecision({ ...base, choice: "coi", cois: [] })).toMatchObject({ status: "billed", reason: "no_coi" });
    expect(rdwDecision({ ...base, choice: "coi", cois: [c("1", "2026-01-01", "2026-11-20")] })).toMatchObject({ status: "billed", reason: "coi_gap" });
    expect(rdwDecision({ ...base, choice: "coi", cois: [c("1", "2026-01-01", "2027-01-01")] }).status).toBe("waived_coi");
    expect(rdwDecision({ ...base, lineWaived: true, choice: "rdw", cois: [] }).status).toBe("waived_line");
  });
});

describe("Damage waiver on invoices", () => {
  it("bills 14% RDW and 4% environmental by default", async () => {
    const inv = await draftFor(0);
    const lines = await kinds(inv.id);
    const rental = Number(lines.find((l) => l.kind === "rental")!.amount);
    expect(Number(lines.find((l) => l.kind === "damage_waiver")!.amount)).toBeCloseTo(Math.round(rental * 14) / 100, 2);
    expect(Number(lines.find((l) => l.kind === "environmental")!.amount)).toBeCloseTo(Math.round(rental * 4) / 100, 2);
  });

  it("set to COI with nothing on file still bills RDW and says why", async () => {
    await expect(setRdwChoice(manager, rpmId, "coi")).rejects.toThrow(/permission/);
    await setRdwChoice(admin, rpmId, "coi");
    const inv = await draftFor(1);
    expect((await kinds(inv.id)).some((l) => l.kind === "damage_waiver")).toBe(true);
    const chk = (await validateInvoice(inv.id)).find((c) => c.rule === "damage_waiver")!;
    expect(chk.status).toBe("info");
    expect(chk.message).toMatch(/no certificate is on file/);
  });

  it("a certificate that expires mid-month doesn't remove RDW; a full one does", async () => {
    const inv = await draftFor(2);
    await expect(uploadCoi(clerk, rpmId, { insurer: "Acme", effective_on: "2026-12-01", expires_on: "2026-11-01", file: pdf })).rejects.toThrow(/before the start/);
    await expect(uploadCoi(clerk, rpmId, { insurer: "Acme", effective_on: "2026-01-01", expires_on: "2026-12-31", file: { ...pdf, mime: "text/plain" } })).rejects.toThrow(/PDF, PNG or JPG/);
    await uploadCoi(clerk, rpmId, { insurer: "Acme Mutual", policy_number: "P-1", effective_on: "2026-01-01", expires_on: "2026-11-20", file: pdf });
    await refreshInvoice(clerk, inv.id);
    expect((await kinds(inv.id)).some((l) => l.kind === "damage_waiver")).toBe(true);
    expect((await validateInvoice(inv.id)).find((c) => c.rule === "damage_waiver")!.message).toMatch(/doesn't cover this whole period/);

    const full = await uploadCoi(clerk, rpmId, { insurer: "Acme Mutual", policy_number: "P-2", effective_on: "2026-11-01", expires_on: "2027-11-01", file: pdf });
    await refreshInvoice(clerk, inv.id);
    const lines = await kinds(inv.id);
    expect(lines.some((l) => l.kind === "damage_waiver")).toBe(false);
    expect(lines.some((l) => l.kind === "environmental")).toBe(true);
    expect((await validateInvoice(inv.id)).find((c) => c.rule === "damage_waiver")!.message).toMatch(/Acme Mutual certificate \(policy P-2\) covers this period/);
    expect(await coiAlerts(30)).toEqual([]);

    // Removing it brings the waiver back; the record itself can't be edited or deleted.
    await expect(removeCoi(clerk, full.id, "")).rejects.toThrow(/why/);
    await removeCoi(clerk, full.id, "Uploaded the wrong year");
    await refreshInvoice(clerk, inv.id);
    expect((await kinds(inv.id)).some((l) => l.kind === "damage_waiver")).toBe(true);
    await expect(q(`UPDATE customer_insurance_certificates SET expires_on='2030-01-01' WHERE id=$1`, [full.id])).rejects.toThrow(/read-only/);
    await expect(q(`DELETE FROM customer_insurance_certificates WHERE id=$1`, [full.id])).rejects.toThrow(/cannot be deleted/);
    expect((await coiAlerts(30)).map((a: any) => a.id)).toEqual([rpmId]);
  });

  it("switching back to RDW bills it even with a certificate on file", async () => {
    await uploadCoi(clerk, rpmId, { insurer: "Acme Mutual", effective_on: "2026-11-01", expires_on: "2027-11-01", file: pdf });
    await setRdwChoice(admin, rpmId, "rdw");
    const inv = await draftFor(3);
    expect((await kinds(inv.id)).some((l) => l.kind === "damage_waiver")).toBe(true);
    expect((await validateInvoice(inv.id)).find((c) => c.rule === "damage_waiver")).toBeUndefined();
  });
});
