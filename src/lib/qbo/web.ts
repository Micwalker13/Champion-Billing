import type { NextRequest } from "next/server";

export const QBO_STATE_COOKIE = "qbo_oauth_state";
/** Must match a Redirect URI saved in the Intuit developer app. */
export function qboRedirectUri(req: NextRequest) {
  return process.env.QBO_REDIRECT_URI || `${req.nextUrl.origin}/api/qbo/callback`;
}
