"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { PORTAL_COOKIE, consumePortalLink, portalLogout, requestPortalLink, submitPortalRequest } from "@/lib/services/portal";
import { getPortalUser, siteOrigin } from "@/lib/portal-session";
import { AppError } from "@/lib/db";

const str = (fd: FormData, k: string) => { const v = fd.get(k); return typeof v === "string" ? v : ""; };
const secure = () => process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1";

export async function portalRequestLinkAction(fd: FormData) {
  const email = str(fd, "email"), origin = await siteOrigin();
  // Sent after the response, and the same answer either way, so neither the wording nor the timing
  // tells anyone whether an address has access.
  after(async () => { try { await requestPortalLink(email, origin); } catch (e) { console.error("portal link", e); } });
  redirect("/portal/login?sent=1");
}

export async function portalSignInAction(fd: FormData) {
  const r = await consumePortalLink(str(fd, "token"));
  if (!r) redirect("/portal/login?err=" + encodeURIComponent("That sign-in link has expired or was already used. Enter your email to get a new one."));
  (await cookies()).set(PORTAL_COOKIE, r.token, { httpOnly: true, sameSite: "lax", secure: secure(), path: "/portal", expires: r.expires });
  redirect("/portal");
}

export async function portalSignOutAction() {
  const c = await cookies();
  await portalLogout(c.get(PORTAL_COOKIE)?.value);
  c.delete({ name: PORTAL_COOKIE, path: "/portal" });
  redirect("/portal/login");
}

export async function portalSubmitRequestAction(fd: FormData) {
  const pu = await getPortalUser();
  if (!pu) redirect("/portal/login");
  let target = "/portal?msg=" + encodeURIComponent("Request sent. Our team will follow up, and you'll see the answer under Your requests.");
  try {
    const f = fd.get("file");
    const file = f instanceof File && f.size > 0 ? { filename: f.name, mime: f.type, content: Buffer.from(await f.arrayBuffer()) } : null;
    await submitPortalRequest(pu, {
      kind: str(fd, "kind"), contract_line_id: str(fd, "contract_line_id") || null, requested_date: str(fd, "requested_date") || null, message: str(fd, "message"),
      file, coi_insurer: str(fd, "coi_insurer"), coi_policy: str(fd, "coi_policy"), coi_effective_on: str(fd, "coi_effective_on") || null, coi_expires_on: str(fd, "coi_expires_on") || null,
    });
  } catch (e) {
    // Only our own plain-language messages reach the customer, never internal error text.
    if (!(e instanceof AppError)) console.error("portal request", e);
    target = "/portal?err=" + encodeURIComponent(e instanceof AppError ? e.message : "Something went wrong. Please try again or call us.");
  }
  redirect(target + "#requests");
}
