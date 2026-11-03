import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, userForToken } from "./services/auth";
import { Permission, SessionUser, can } from "./permissions";

export async function getUser(): Promise<SessionUser | null> {
  const c = await cookies();
  return userForToken(c.get(SESSION_COOKIE)?.value);
}

export async function requireUser(perm: Permission = "view"): Promise<SessionUser> {
  const u = await getUser();
  if (!u) redirect("/login");
  if (!can(u, perm)) redirect("/?err=" + encodeURIComponent("You do not have access to that page."));
  return u;
}
