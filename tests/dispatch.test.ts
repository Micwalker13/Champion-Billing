// Delivery/pickup tickets with signatures, quotes, and reservations.
import { beforeAll, describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { one, q } from "@/lib/db";
import { SessionUser } from "@/lib/permissions";
import { todayCentral, addDays } from "@/lib/dates";
import { createEquipment, changeLineStatus } from "@/lib/services/records";
import { acceptQuote, addQuoteLine, assignReservationUnit, availableForDates, cancelReservation, cancelTicket, completeTicket, convertReservation, createQuote,
  createReservation, declineQuote, listTickets, markQuoteSent, parseSignature, quotePdf, removeQuoteLine, scheduleTicket, ticketPdf } from "@/lib/services/dispatch";
import { RPM_SAMPLE_UNITS } from "@/lib/sample-data";
import { lineForUnit, pdfText, resetDb, userByRole } from "./helpers";

let clerk: SessionUser, viewer: SessionUser, rpmId: string;

/** A small valid PNG (a 40x10 black bar) standing in for a drawn signature. */
function signaturePng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const w = 40, h = 10;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h); // filter byte 0 + black pixels
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

beforeAll(async () => {
  const seeded = await resetDb();
  rpmId = seeded.rpmId;
  [clerk, viewer] = await Promise.all(["billing_clerk", "viewer"].map(userByRole));
});

describe("Delivery and pickup tickets", () => {
  it("schedules a delivery, then signs it at the jobsite and stores the signed PDF", async () => {
    const line = await lineForUnit(RPM_SAMPLE_UNITS[0].unit);
    await expect(scheduleTicket(viewer, line, { kind: "delivery", scheduled_date: todayCentral() })).rejects.toThrow(/permission/);
    const t = await scheduleTicket(clerk, line, { kind: "delivery", scheduled_date: todayCentral(), driver: "Sam", truck: "T-4", site_contact: "Foreman Joe 713-555-0100" });
    expect(t.ticket_number).toMatch(/^DL-\d+$/);
    await expect(scheduleTicket(clerk, line, { kind: "delivery", scheduled_date: todayCentral() })).rejects.toThrow(/already a scheduled delivery/);
    await expect(scheduleTicket(clerk, line, { kind: "pickup", scheduled_date: todayCentral() })).rejects.toThrow(/off-rent first/);
    expect(() => parseSignature("data:image/png;base64,AAAA")).toThrow(/didn't come through/);
    await expect(completeTicket(clerk, t.id, { signed_by: "Joe Foreman", signature: "" })).rejects.toThrow(/sign in the box/);
    const done = await completeTicket(clerk, t.id, { signed_by: "Joe Foreman", signature: signaturePng(), hours: "1500.0", fuel_level: "full", condition_notes: "Small dent on left door" });
    expect(done.status).toBe("completed");
    const text = pdfText((await ticketPdf(t.id)).pdf);
    expect(text).toContain("DELIVERY TICKET");
    expect(text).toContain("Signed by Joe Foreman");
    expect(text).toContain("Small dent on left door");
    expect(text).toContain(RPM_SAMPLE_UNITS[0].unit);
    // Permanent once signed.
    await expect(q(`UPDATE delivery_tickets SET signed_by='Someone else' WHERE id=$1`, [t.id])).rejects.toThrow(/cannot be changed/);
    await expect(cancelTicket(clerk, t.id, "Oops")).rejects.toThrow(/Only a scheduled/);
    const ev = await one(`SELECT kind, hours FROM equipment_events WHERE kind='delivered' ORDER BY id DESC LIMIT 1`);
    expect(ev).toEqual({ kind: "delivered", hours: "1500.0" });
    expect((await listTickets({ lineId: line })).map((x) => x.status)).toEqual(["completed"]);
  });

  it("schedules a pickup once the rental is called off", async () => {
    const line = await lineForUnit(RPM_SAMPLE_UNITS[1].unit);
    await changeLineStatus(clerk, line, { status: "off_rent", date: addDays(todayCentral(), 3) });
    const t = await scheduleTicket(clerk, line, { kind: "pickup", scheduled_date: addDays(todayCentral(), 3) });
    expect(t.ticket_number).toMatch(/^PU-\d+$/);
    await cancelTicket(clerk, t.id, "Customer extended");
    expect((await one(`SELECT status FROM delivery_tickets WHERE id=$1`, [t.id])).status).toBe("cancelled");
  });
});

describe("Quotes and reservations", () => {
  it("builds a quote, locks its prices once sent, and reserves the equipment when accepted", async () => {
    await createEquipment(clerk, { unit_number: "RES01", description: "Mini excavator", category: "Excavator" });
    await createEquipment(clerk, { unit_number: "RES02", description: "Mini excavator", category: "Excavator" });
    const qt = await createQuote(clerk, { customer_id: rpmId, valid_days: "14", jobsite: "123 Main St, Houston TX", contact: "Pat" });
    expect(qt.quote_number).toMatch(/^Q-\d+$/);
    const start = addDays(todayCentral(), 10);
    await expect(markQuoteSent(clerk, qt.id)).rejects.toThrow(/at least one line/);
    await expect(addQuoteLine(clerk, qt.id, { description: "Bad", rate_amount: "1", rate_basis: "monthly", start_date: start, unit_number: "RES01", quantity: "2" })).rejects.toThrow(/quantity 1/);
    await addQuoteLine(clerk, qt.id, { description: "Mini excavator", category: "Excavator", unit_number: "RES01", rate_amount: "2800.00", rate_basis: "monthly", start_date: start, delivery_charge: "250", pickup_charge: "250" });
    const extra = await addQuoteLine(clerk, qt.id, { description: "Light tower", category: "Lights", quantity: "2", rate_amount: "600", rate_basis: "monthly", start_date: start });
    await removeQuoteLine(clerk, qt.id, extra.id);
    await addQuoteLine(clerk, qt.id, { description: "Light tower", category: "Lights", quantity: "2", rate_amount: "650", rate_basis: "monthly", start_date: start });
    const text = pdfText((await quotePdf(qt.id)).pdf);
    expect(text).toContain("RENTAL QUOTE");
    expect(text).toContain("$2,800.00 / month");
    await expect(acceptQuote(clerk, qt.id, "")).rejects.toThrow(/Mark the quote as sent/);
    await markQuoteSent(clerk, qt.id);
    await expect(addQuoteLine(clerk, qt.id, { description: "Late add", rate_amount: "1", rate_basis: "daily", start_date: start })).rejects.toThrow(/already sent/);
    await expect(q(`UPDATE quote_lines SET rate_amount=1 WHERE quote_id=$1`, [qt.id])).rejects.toThrow(/already sent/);
    const res = await acceptQuote(clerk, qt.id, "Accepted by Pat by phone");
    expect(res).toHaveLength(3); // 1 excavator + 2 light towers
    expect(res.filter((r) => r.equipment_id)).toHaveLength(1);
    await expect(declineQuote(clerk, qt.id, "")).rejects.toThrow(/already decided/);

    // The reserved unit isn't free for those dates, and can't be double-booked.
    expect((await availableForDates(start, null)).map((u) => u.unit_number)).not.toContain("RES01");
    await expect(createReservation(clerk, { customer_id: rpmId, unit_number: "RES01", description: "Clash", start_date: addDays(start, 5) })).rejects.toThrow(/already reserved/);
    const tower = res.find((r) => !r.equipment_id)!;
    await expect(assignReservationUnit(clerk, tower.id, "RES01")).rejects.toThrow(/already reserved/);
    await assignReservationUnit(clerk, tower.id, "RES02");
    await cancelReservation(clerk, res[2].id, "Only needs one tower");

    // The excavator goes out: the reservation becomes a rental at the quoted rate.
    const exc = res.find((r) => r.equipment_id)!;
    await expect(convertReservation(clerk, exc.id, { contract_number: "" })).rejects.toThrow();
    const { lineId } = await convertReservation(clerk, exc.id, { contract_number: "CE-RES-1" });
    const line = await one(`SELECT l.rate_amount, l.rate_basis, l.delivery_charge, l.on_rent_date, j.address FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id LEFT JOIN jobsites j ON j.id=c.jobsite_id WHERE l.id=$1`, [lineId]);
    expect(line).toMatchObject({ rate_amount: "2800.00", rate_basis: "monthly", delivery_charge: "250.00", on_rent_date: start, address: "123 Main St, Houston TX" });
    expect((await one(`SELECT status FROM reservations WHERE id=$1`, [exc.id])).status).toBe("converted");
  });
});
