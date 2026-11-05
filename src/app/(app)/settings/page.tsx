import { requireUser } from "@/lib/session";
import { ROLE_LABELS } from "@/lib/permissions";
import { companySettings } from "@/lib/services/invoices";
import { listUsers } from "@/lib/services/auth";
import { Flash } from "@/components/ui";
import { createUserAction, resetPasswordAction, toggleUserAction, updateCompanyAction } from "../../actions";

export default async function Settings({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const me = await requireUser("configure_billing");
  const sp = await searchParams;
  const s = await companySettings();
  const users = await listUsers();
  return (
    <>
      <div className="topbar"><h1>Settings</h1></div>
      <Flash sp={sp} />
      {s.is_placeholder && <div className="alert alert-warn">Company details are placeholders. Invoices show a warning and need an authorized override until these are confirmed.</div>}
      <form className="card" action={updateCompanyAction}>
        <h2>Invoice header &amp; numbering</h2><input type="hidden" name="back" value="/settings" />
        <div className="grid g3">
          <div className="field"><label>Legal name</label><input name="legal_name" defaultValue={s.legal_name} required /></div>
          <div className="field"><label>Address line 1</label><input name="address_line1" defaultValue={s.address_line1} required /></div>
          <div className="field"><label>Address line 2</label><input name="address_line2" defaultValue={s.address_line2 ?? ""} /></div>
          <div className="field"><label>City, state ZIP</label><input name="city_state_zip" defaultValue={s.city_state_zip} required /></div>
          <div className="field"><label>Phone</label><input name="phone" defaultValue={s.phone ?? ""} /></div>
          <div className="field"><label>Billing email</label><input name="email" defaultValue={s.email ?? ""} /></div>
          <div className="field"><label>Remit to</label><input name="remit_to" defaultValue={s.remit_to ?? ""} /></div>
          <div className="field"><label>Invoice number prefix</label><input name="invoice_prefix" defaultValue={s.invoice_prefix} required /></div>
          <div className="field"><label>Next invoice number</label><input name="next_invoice_number" defaultValue={s.next_invoice_number} inputMode="numeric" required /></div>
        </div>
        <label className="check"><input type="checkbox" name="is_placeholder" defaultChecked={s.is_placeholder} /> These details are still placeholders</label>
        <button className="btn-primary">Save</button>
        <p className="small muted">Approvers can also type a specific invoice number when approving (for example, a number generated elsewhere). Numbers are always unique.</p>
      </form>
      <div className="card">
        <h2>Users</h2>
        <div className="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
          {users.map((u: any) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{ROLE_LABELS[u.role as keyof typeof ROLE_LABELS]}</td><td>{u.active ? <span className="badge b-ok">Active</span> : <span className="badge">Disabled</span>}</td>
            <td>{String(u.id) !== String(me.id) && <form action={toggleUserAction} className="inline"><input type="hidden" name="id" value={u.id} /><input type="hidden" name="active" value={String(!u.active)} /><input type="hidden" name="back" value="/settings" /><button className="btn-sm">{u.active ? "Disable" : "Enable"}</button></form>}
              <details><summary className="small">Reset password</summary>
                <form action={resetPasswordAction} className="row"><input type="hidden" name="id" value={u.id} /><input type="hidden" name="back" value="/settings" />
                  <div className="field"><input name="temporary_password" required minLength={12} autoComplete="off" placeholder="Temporary password (12+)" /></div><button className="btn-sm">Set</button></form></details></td></tr>)}
        </tbody></table></div>
        <form action={createUserAction} className="row" style={{ marginTop: 12 }}><input type="hidden" name="back" value="/settings" />
          <div className="field"><label>Name</label><input name="name" required /></div>
          <div className="field"><label>Email</label><input name="email" type="email" required /></div>
          <div className="field"><label>Temporary password (12+ chars)</label><input name="password" type="password" minLength={12} required autoComplete="new-password" /></div>
          <div className="field"><label>Role</label><select name="role">{Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <button>Add user</button>
        </form>
      </div>
    </>
  );
}
