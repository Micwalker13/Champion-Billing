import { loginAction } from "../actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  return (
    <div className="login-wrap">
      <div className="card login">
        <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 2 }}>Champion <span style={{ color: "var(--accent)" }}>Billing</span></div>
        <p className="muted" style={{ marginTop: 0 }}>Rental billing &amp; monthly PO management</p>
        {err && <div className="alert alert-bad">{err}</div>}
        <form action={loginAction}>
          <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="username" required /></div>
          <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required /></div>
          <button className="btn-primary" type="submit" style={{ width: "100%" }}>Sign in</button>
        </form>
      </div>
    </div>
  );
}
