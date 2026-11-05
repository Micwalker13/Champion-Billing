import { requireUser } from "@/lib/session";
import { ROLE_LABELS } from "@/lib/permissions";
import { Flash } from "@/components/ui";
import { changePasswordAction } from "../../actions";

export default async function Account({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  return (
    <>
      <div className="topbar"><div><h1>My account</h1><div className="muted">{user.name} · {user.email} · {ROLE_LABELS[user.role]}</div></div></div>
      <Flash sp={sp} />
      <form className="card" action={changePasswordAction} style={{ maxWidth: 480 }}>
        <h2>Change password</h2><input type="hidden" name="back" value="/account" />
        <div className="field"><label>Current password</label><input type="password" name="current_password" required autoComplete="current-password" /></div>
        <div className="field"><label>New password (at least 12 characters)</label><input type="password" name="new_password" required minLength={12} autoComplete="new-password" /></div>
        <div className="field"><label>New password again</label><input type="password" name="confirm_password" required minLength={12} autoComplete="new-password" /></div>
        <button className="btn-primary" style={{ marginTop: 8 }}>Change password</button>
      </form>
    </>
  );
}
