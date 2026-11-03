import { beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { applyRentalBatch, parseDate, rentalBatch, uploadRentalFile } from "@/lib/services/rental-import";
import { generateInvoice } from "@/lib/services/invoices";
import { resetDb, userByRole } from "./helpers";

let clerk: SessionUser, viewer: SessionUser, rpmId: string;
beforeAll(async () => {
  rpmId = (await resetDb()).rpmId;
  clerk = await userByRole("billing_clerk");
  viewer = await userByRole("viewer");
});

const csv = (rows: string[]) => Buffer.from(["Contract,Unit,Description,Serial,Start Date,Billed Through,Rate,Job,Work Order,Jobsite,Jobsite Address,Quipli Reference", ...rows].join("\n"));

describe("Bulk load of existing rentals", () => {
  it("parses common date formats", () => {
    expect(parseDate("8/14/2026")).toBe("2026-08-14");
    expect(parseDate("2026-08-14")).toBe("2026-08-14");
    expect(parseDate("08/14/26")).toBe("2026-08-14");
    expect(() => parseDate("13/45/2026")).toThrow();
  });

  it("previews without creating anything and flags bad rows", async () => {
    const b = await uploadRentalFile(clerk, { customerId: rpmId, filename: "bad.csv", content: csv([
      "CE-50001,NEW000001,Test excavator,SN1,9/1/2026,10/31/2026,1500.00,5276,190001,Site A,1 A St,Q-1",
      "CE-50002,MUR002101,Dup unit,SN2,9/1/2026,10/31/2026,1500.00,5276,190002,Site A,1 A St,Q-2",   // already on rent
      "CE-50003,NEW000003,,SN3,9/1/2026,,abc,5276,190003,Site A,1 A St,Q-3",                          // no description, bad rate
    ]) });
    const rows = (await rentalBatch(b.id)).rows;
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].values.billing_start_date).toBe("2026-11-01"); // day after "billed through"
    expect(rows[1].errors.join()).toMatch(/already on open rental CE-10025/);
    expect(rows[2].errors.join()).toMatch(/Rate/);
    expect(rows[2].errors.join()).toMatch(/description/);
    expect((await q(`SELECT 1 FROM rental_contracts WHERE contract_number LIKE 'CE-5000%'`)).length).toBe(0);
    await expect(applyRentalBatch(clerk, b.id)).rejects.toThrow(/errors/);
  });

  it("creates every rental and new unit in one transaction; they bill from the right date", async () => {
    await expect(uploadRentalFile(viewer, { customerId: rpmId, filename: "x.csv", content: csv(["CE-1,X1,d,s,9/1/2026,,1,1,1,a,b,c"]) })).rejects.toThrow(/permission/);
    const b = await uploadRentalFile(clerk, { customerId: rpmId, filename: "good.csv", content: csv([
      "CE-60001,NEW100001,Test excavator,SN1,9/1/2026,10/31/2026,1500.00,5276,190001,Site A,\"1 A St, Houston TX\",Q-1",
      "CE-60002,NEW100002,Test loader,SN2,10/15/2026,10/31/2026,2500.00,5430,190002,Site B,2 B St,Q-2",
    ]) });
    expect(await applyRentalBatch(clerk, b.id)).toBe(2);
    const l = await one(`SELECT l.id, l.billing_start_date, rc.quipli_reference, j.address FROM rental_contract_lines l JOIN rental_contracts rc ON rc.id=l.contract_id JOIN jobsites j ON j.id=rc.jobsite_id WHERE rc.contract_number='CE-60001'`);
    expect(l).toMatchObject({ billing_start_date: "2026-11-01", quipli_reference: "Q-1", address: "1 A St, Houston TX" });
    const inv = await generateInvoice(clerk, l.id, "2026-11-01");
    expect([inv.period_start, inv.period_end, inv.subtotal]).toEqual(["2026-11-01", "2026-11-30", "1500.00"]);
    await expect(uploadRentalFile(clerk, { customerId: rpmId, filename: "again.csv", content: csv([
      "CE-60001,NEW100001,Test excavator,SN1,9/1/2026,10/31/2026,1500.00,5276,190001,Site A,\"1 A St, Houston TX\",Q-1",
      "CE-60002,NEW100002,Test loader,SN2,10/15/2026,10/31/2026,2500.00,5430,190002,Site B,2 B St,Q-2",
    ]) })).rejects.toThrow(/already loaded/);
  });

  it("rolls back everything if any row fails while creating", async () => {
    const b = await uploadRentalFile(clerk, { customerId: rpmId, filename: "race.csv", content: csv([
      "CE-70001,NEW200001,Unit A,SN1,9/1/2026,10/31/2026,1500.00,5276,1,a,b,c",
      "CE-70002,NEW200002,Unit B,SN2,9/1/2026,10/31/2026,1500.00,5276,2,a,b,c",
    ]) });
    // Someone creates CE-70002 by hand between preview and apply.
    await q(`INSERT INTO rental_contracts(contract_number,customer_id,start_date) VALUES ('CE-70002',$1,'2026-09-01')`, [rpmId]);
    await expect(applyRentalBatch(clerk, b.id)).rejects.toThrow(/Row 3/);
    expect(await one(`SELECT 1 AS x FROM rental_contracts WHERE contract_number='CE-70001'`)).toBeNull();
    expect(await one(`SELECT 1 AS x FROM equipment WHERE unit_number='NEW200001'`)).toBeNull();
  });
});
