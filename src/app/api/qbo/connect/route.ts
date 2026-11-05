import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { authorizeUrl, qboAppConfig } from "@/lib/qbo/client";
import { QBO_STATE_COOKIE, qboRedirectUri } from "@/lib/qbo/web";


/** Sends an administrator to Intuit to approve the connection. */
export async function GET(req: NextRequest) {
  const user = await getUser();
  if (!user || !can(user, "manage_quickbooks")) return NextResponse.redirect(new URL("/?err=" + encodeURIComponent("Only an administrator can connect QuickBooks."), req.url));
  if (!qboAppConfig().configured) return NextResponse.redirect(new URL("/quickbooks?err=" + encodeURIComponent("QuickBooks app keys aren't set on the server yet."), req.url));
  const state = randomBytes(24).toString("base64url");
  const res = NextResponse.redirect(authorizeUrl(qboRedirectUri(req), state));
  res.cookies.set(QBO_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1", path: "/api/qbo", maxAge: 600 });
  return res;
}
