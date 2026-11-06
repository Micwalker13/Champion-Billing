import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { taxExemptionFile } from "@/lib/services/tax-exempt";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user || !can(user, "view")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const f = await taxExemptionFile(id);
  if (!f) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(f.file_content), { headers: {
    "Content-Type": f.file_mime, "Content-Disposition": `inline; filename="${String(f.file_name ?? "certificate").replace(/["\r\n]/g, "")}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
}
