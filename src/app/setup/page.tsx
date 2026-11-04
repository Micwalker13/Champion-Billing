import { notFound } from "next/navigation";
import { needsSetup } from "@/lib/services/setup";
import { setupAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  if (!(await needsSetup())) notFound();
  const { err } = await searchParams;
  return (
    <div className="login-wrap">
      <div className="card login" style={{ maxWidth: 460 }}>
        <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 2 }}>Champion <span style={{ color: "var(--accent)" }}>Billing</span>: first-time setup</div>
        <p className="muted" style={{ marginTop: 0 }}>Create the first administrator. This page disappears once a user exists.</p>
        {err && <div className="alert alert-bad">{err}</div>}
        <form action={setupAction}>
          <div className="field"><label htmlFor="token">Setup code</label><input id="token" name="token" type="password" autoComplete="off" required /><div className="small muted">The SETUP_TOKEN value you entered in Vercel.</div></div>
          <div className="field"><label htmlFor="name">Your name</label><input id="name" name="name" autoComplete="name" required /></div>
          <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="username" required /></div>
          <div className="field"><label htmlFor="password">Password (12+ characters)</label><input id="password" name="password" type="password" minLength={12} autoComplete="new-password" required /></div>
          <div className="field"><label htmlFor="confirm">Repeat password</label><input id="confirm" name="confirm" type="password" minLength={12} autoComplete="new-password" required /></div>
          <div className="field"><label><input type="checkbox" name="create_rpm" defaultChecked /> Also set up RPM xConstruction with its billing rules</label></div>
          <div className="field"><label htmlFor="rpm_address">RPM billing address (optional, can be added later)</label><textarea id="rpm_address" name="rpm_address" rows={2} /></div>
          <button className="btn-primary" type="submit" style={{ width: "100%" }}>Create administrator</button>
        </form>
      </div>
    </div>
  );
}
