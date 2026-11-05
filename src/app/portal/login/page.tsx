import { redirect } from "next/navigation";
import { getPortalUser } from "@/lib/portal-session";
import { portalRequestLinkAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function PortalLogin({ searchParams }: { searchParams: Promise<{ sent?: string; err?: string }> }) {
  const sp = await searchParams;
  if (await getPortalUser()) redirect("/portal");
  return (
    <div className="login-wrap">
      <div className="card login">
        <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 2 }}>Champion <span style={{ color: "var(--accent)" }}>Equipment</span></div>
        <p className="muted" style={{ marginTop: 0 }}>Customer portal</p>
        {sp.err && <div className="alert alert-bad" role="alert">{sp.err}</div>}
        {sp.sent
          ? <div className="alert alert-ok" role="status">If that address has portal access, a sign-in link is on its way. It works once and expires in 30 minutes.</div>
          : <p className="small muted">Enter your work email and we&apos;ll email you a link to sign in. No password needed.</p>}
        <form action={portalRequestLinkAction}>
          <div className="field"><label htmlFor="email">Work email</label><input id="email" name="email" type="email" autoComplete="email" required /></div>
          <button className="btn-primary" type="submit" style={{ width: "100%" }}>Email me a sign-in link</button>
        </form>
        <p className="small muted" style={{ marginBottom: 0 }}>No access yet? Ask your Champion Equipment contact to add you.</p>
      </div>
    </div>
  );
}
