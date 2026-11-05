import { portalSignInAction } from "../actions";

export const dynamic = "force-dynamic";

// The emailed link opens this page; the link is only used up when the person presses the button.
// That way email security scanners that open links in advance can't spend it.
export default async function PortalAuth({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <div className="login-wrap">
      <div className="card login">
        <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 2 }}>Champion <span style={{ color: "var(--accent)" }}>Equipment</span></div>
        <p className="muted" style={{ marginTop: 0 }}>Customer portal</p>
        {token
          ? <form action={portalSignInAction}><input type="hidden" name="token" value={token} /><button className="btn-primary" type="submit" style={{ width: "100%" }}>Sign in</button></form>
          : <div className="alert alert-bad">This sign-in link is incomplete. <a href="/portal/login">Get a new link</a>.</div>}
      </div>
    </div>
  );
}
