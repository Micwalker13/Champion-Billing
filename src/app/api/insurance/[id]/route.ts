import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { one } from "@/lib/db";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const d = await one(`SELECT filename, mime_type, content FROM customer_insurance_certificates WHERE id=$1`, [id]);
  if (!d) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(d.content), { headers: { "Content-Type": d.mime_type, "Content-Disposition": `inline; filename="${d.filename.replace(/["\r\n]/g, "")}"`, "Cache-Control": "private, no-store" } });
}
