import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { processQboQueue } from "@/lib/services/quickbooks";

/** Daily safety net for the QuickBooks queue (items are also sent right after they're recorded). Vercel Cron calls this with CRON_SECRET. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET ?? "";
  const got = req.headers.get("authorization") ?? "";
  const want = `Bearer ${secret}`;
  if (!secret || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return NextResponse.json({ error: "Not allowed" }, { status: 401 });
  const result = await processQboQueue();
  return NextResponse.json(result);
}
