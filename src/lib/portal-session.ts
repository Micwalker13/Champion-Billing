import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { PORTAL_COOKIE, PortalUser, portalUserForToken } from "./services/portal";

export async function getPortalUser(): Promise<PortalUser | null> {
  const c = await cookies();
  return portalUserForToken(c.get(PORTAL_COOKIE)?.value);
}

export async function requirePortalUser(): Promise<PortalUser> {
  const u = await getPortalUser();
  if (!u) redirect("/portal/login");
  return u;
}

/**
 * The web address put in emailed sign-in links. APP_URL (for example https://billing.championequipmentco.com)
 * wins when it is set, so a forged Host header can never point a link somewhere else.
 */
export async function siteOrigin(): Promise<string> {
  const fixed = process.env.APP_URL?.trim();
  if (fixed) return fixed.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}
