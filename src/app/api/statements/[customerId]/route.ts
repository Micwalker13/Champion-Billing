import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { audit, pool } from "@/lib/db";
import { isIsoDate, todayCentral } from "@/lib/dates";
import { customerStatement } from "@/lib/services/reports";
import { renderStatementPdf } from "@/lib/pdf";

export async function GET(req: NextRequest, { params }: { params: Promise<{ customerId: string }> }) {
  const user = await getUser();
  if (!user || !can(user, "view")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { customerId } = await params;
  if (!/^\d+$/.test(customerId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const asOfParam = req.nextUrl.searchParams.get("asOf") ?? "";
  const asOf = isIsoDate(asOfParam) ? asOfParam : todayCentral();
  try {
    const s = await customerStatement(customerId, asOf);
    const pdf = await renderStatementPdf(s);
    await audit(pool(), user.id, "download_statement", "customer", customerId, null, { asOf, open_invoices: s.invoices.length, balance: s.totals.total });
    return new NextResponse(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="statement-${s.customer.customer_code}-${asOf}.pdf"`, "Cache-Control": "private, no-store" } });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.code === "not_found" ? 404 : 500 });
  }
}
