import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { audit, one, pool } from "@/lib/db";
import { monthPacket } from "@/lib/services/reports";

// All of a customer's approved invoices for one month, combined into one PDF for sending.
export async function GET(req: NextRequest) {
  const user = await getUser();
  if (!user || !can(user, "view")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const customer = req.nextUrl.searchParams.get("customer") ?? "";
  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!/^\d+$/.test(customer) || !/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: "customer and month (YYYY-MM) are required" }, { status: 400 });
  try {
    const c = await one(`SELECT customer_code FROM customers WHERE id=$1`, [customer]);
    if (!c) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const r = await monthPacket(customer, `${month}-01`);
    await audit(pool(), user.id, "download_packet", "customer", customer, null, { month, invoices: r.invoiceNumbers });
    return new NextResponse(new Uint8Array(r.pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${c.customer_code}-invoices-${month}.pdf"`, "Cache-Control": "private, no-store" } });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.code === "not_found" ? 404 : 500 });
  }
}
