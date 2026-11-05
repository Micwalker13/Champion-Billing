import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { creditPdf } from "@/lib/services/credits";
import { audit, pool } from "@/lib/db";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user || !can(user, "view")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const r = await creditPdf(id);
    await audit(pool(), user.id, "download_pdf", "credit_memo", id, null, { sha256: r.sha256 });
    return new NextResponse(new Uint8Array(r.pdf), { headers: {
      "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${r.filename}"`, "Cache-Control": "private, no-store", "X-Content-SHA256": r.sha256,
    } });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.code === "not_found" ? 404 : 500 });
  }
}
