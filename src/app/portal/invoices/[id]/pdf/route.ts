import { NextRequest, NextResponse } from "next/server";
import { getPortalUser } from "@/lib/portal-session";
import { portalInvoicePdf } from "@/lib/services/portal";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const pu = await getPortalUser();
  if (!pu) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  try {
    const r = await portalInvoicePdf(pu, id);
    return new NextResponse(new Uint8Array(r.pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${r.filename}"`, "Cache-Control": "private, no-store" } });
  } catch (e: any) {
    if (e?.code !== "not_found") console.error("portal pdf", e);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
