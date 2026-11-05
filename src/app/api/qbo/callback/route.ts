import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { exchangeCode } from "@/lib/qbo/client";
import { saveQboConnection } from "@/lib/services/quickbooks";
import { QBO_STATE_COOKIE, qboRedirectUri } from "@/lib/qbo/web";

const back = (req: NextRequest, k: "msg" | "err", v: string) => {
  const res = NextResponse.redirect(new URL(`/quickbooks?${k}=${encodeURIComponent(v)}`, req.url));
  res.cookies.delete({ name: QBO_STATE_COOKIE, path: "/api/qbo" });
  return res;
};

/** Intuit sends the administrator back here after they approve (or cancel) the connection. */
export async function GET(req: NextRequest) {
  const user = await getUser();
  if (!user || !can(user, "manage_quickbooks")) return NextResponse.redirect(new URL("/login", req.url));
  const p = req.nextUrl.searchParams;
  const expected = req.cookies.get(QBO_STATE_COOKIE)?.value ?? "";
  const got = p.get("state") ?? "";
  if (!expected || expected.length !== got.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(got)))
    return back(req, "err", "The QuickBooks sign-in expired or didn't match. Try Connect again.");
  if (p.get("error")) return back(req, "err", p.get("error") === "access_denied" ? "QuickBooks connection was cancelled." : `QuickBooks said: ${p.get("error")}`);
  const code = p.get("code"), realmId = p.get("realmId");
  if (!code || !realmId) return back(req, "err", "QuickBooks didn't send back a company. Try Connect again.");
  try {
    const tokens = await exchangeCode(code, qboRedirectUri(req));
    const name = await saveQboConnection(user, realmId, tokens);
    return back(req, "msg", `Connected to ${name ?? "QuickBooks"}. Next: match customers and items below, then pick a start date and turn sync on.`);
  } catch (e: any) {
    return back(req, "err", e?.message ?? "Couldn't connect QuickBooks.");
  }
}
