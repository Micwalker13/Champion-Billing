import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { one } from "@/lib/db";
import { BILLING_METHOD_LABELS, PRORATION_LABELS } from "@/lib/billing";
import { Flash } from "@/components/ui";
import { rdwChoiceAction, uploadCoiAction, removeCoiAction, usageSettingsAction, approveProrationAction, setInvoiceEmailsAction, updateCustomerAction, updateProfileAction } from "../../../actions";
import { emailEnabled } from "@/lib/services/email";
import { listCois } from "@/lib/services/insurance";
import { fmtDate, todayCentral } from "@/lib/dates";

export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const c = await one(`SELECT * FROM customers WHERE id=$1`, [id]);
  if (!c) notFound();
  const p = await one(`SELECT p.*, u.name AS approver FROM customer_billing_profiles p LEFT JOIN users u ON u.id=p.proration_approved_by WHERE customer_id=$1`, [id]);
  const back = `/customers/${id}`;
  const cois = await listCois(id);
  const today = todayCentral();
  const current = cois.find((x: any) => !x.removed_at && x.effective_on <= today && x.expires_on >= today);
  const editor = can(user, "edit_records");
  const admin = can(user, "configure_billing");
  const Chk = ({ name, label }: { name: string; label: string }) => <label className="check"><input type="checkbox" name={name} defaultChecked={p[name]} disabled={!admin} /> {label}</label>;
  return (
    <>
      <div className="topbar"><div><div className="muted small"><a href="/customers">Customers</a></div><h1>{c.name}</h1><div className="muted">{c.customer_code}</div></div>
        <a className="btn" href={`/rpm?customer=${id}`}>Billing board</a></div>
      <Flash sp={sp} />
      <div className="grid g2">
        <form className="card" action={updateCustomerAction}>
          <h2>Customer details</h2><input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={back} />
          <div className="field"><label>Customer ID</label><input name="customer_code" defaultValue={c.customer_code} required /></div>
          <div className="field"><label>Name</label><input name="name" defaultValue={c.name} required /></div>
          <div className="field"><label>Billing address</label><textarea name="billing_address" rows={3} defaultValue={c.billing_address} required /></div>
          <div className="field"><label>AP email</label><input name="email" defaultValue={c.email ?? ""} /></div>
          <div className="field"><label>Phone</label><input name="phone" defaultValue={c.phone ?? ""} /></div>
          {can(user, "edit_records") && <button>Save</button>}
          <p className="small muted">Changing these never alters finalized invoices; each keeps its own snapshot.</p>
        </form>
        <div className="card">
          <h2>Partial-period proration</h2>
          <p><span className={`badge ${p.proration_policy === "unapproved" ? "b-warn" : "b-ok"}`}>{PRORATION_LABELS[p.proration_policy as keyof typeof PRORATION_LABELS]}</span></p>
          {p.proration_policy !== "unapproved" && <p className="small muted">Approved by {p.approver} on {new Date(p.proration_approved_at).toLocaleDateString("en-US", { timeZone: "America/Chicago" })}: “{p.proration_approval_note}”</p>}
          <p className="small muted">Champion must explicitly approve how partial periods (mid-month deliveries, call-offs, returns) are charged. Until then, partial periods cannot be invoiced.</p>
          {admin && <form action={approveProrationAction}><input type="hidden" name="customer_id" value={id} /><input type="hidden" name="back" value={back} />
            <div className="field"><label>Policy</label><select name="policy" defaultValue={p.proration_policy}>{Object.entries(PRORATION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="field"><label>Business approval record</label><input name="note" placeholder="Who approved, when, and how (e.g. matches Quipli setting X)" /></div>
            <button>Record policy</button></form>}
        </div>
      </div>
      <form className="card" action={setInvoiceEmailsAction}>
        <h2>Where invoices are emailed</h2><input type="hidden" name="customer_id" value={id} /><input type="hidden" name="back" value={back} />
        <p className="small muted">Each approved invoice goes out as its own email with the PO, unit and period in the subject line. Separate several addresses with commas.{!emailEnabled() && " Email isn't switched on yet, so nothing will be sent until it is."}</p>
        <div className="row"><div className="field" style={{ flexBasis: 420 }}><label>Invoice email address(es)</label><input name="invoice_emails" defaultValue={p.invoice_emails ?? c.email ?? ""} placeholder="ap@customer.com" disabled={!can(user, "edit_records")} /></div>
          {can(user, "edit_records") && <button>Save</button>}</div>
      </form>
      <div className="card">
        <h2>Damage waiver or insurance certificate</h2>
        <p className="small muted">Every rental is billed the damage waiver{p.damage_waiver_pct ? ` (${Number(p.damage_waiver_pct) * 100}% of rental)` : ""} unless the customer insures the equipment themselves. If they do, keep their certificate of insurance (COI) on file here. The waiver is skipped only for billing periods the certificate fully covers. With no certificate, or an expired one, the waiver is billed and the invoice check says why.</p>
        {!p.damage_waiver_pct && <p><span className="badge b-warn">The damage waiver percent isn't set below, so it isn't billed to anyone yet.</span></p>}
        <form action={rdwChoiceAction} className="row" style={{ alignItems: "flex-end" }}>
          <input type="hidden" name="customer_id" value={id} /><input type="hidden" name="back" value={back} />
          <label className="check" style={{ whiteSpace: "nowrap" }}><input type="radio" name="rdw_choice" value="rdw" defaultChecked={p.rdw_choice !== "coi"} disabled={!admin} /> Bill damage waiver</label>
          <label className="check" style={{ whiteSpace: "nowrap" }}><input type="radio" name="rdw_choice" value="coi" defaultChecked={p.rdw_choice === "coi"} disabled={!admin} /> Customer has own insurance (COI on file)</label>
          {admin && <button>Save</button>}
        </form>
        {p.rdw_choice === "coi" && (current
          ? <p><span className="badge b-ok">Certificate on file through {fmtDate(current.expires_on)}</span></p>
          : <p><span className="badge b-warn">No current certificate on file, so the damage waiver is being billed.</span></p>)}
        {cois.length > 0 && <table className="small"><thead><tr><th>Insurer</th><th>Policy</th><th>Valid</th><th>File</th><th></th></tr></thead><tbody>
          {cois.map((x: any) => <tr key={x.id} className={x.removed_at ? "muted" : ""}>
            <td>{x.insurer}</td><td>{x.policy_number ?? ""}</td>
            <td>{fmtDate(x.effective_on)} to {fmtDate(x.expires_on)}{!x.removed_at && x.expires_on < today && <> <span className="badge b-warn">Expired</span></>}</td>
            <td><a href={`/api/insurance/${x.id}`} target="_blank">{x.filename}</a><div className="muted">Uploaded by {x.uploaded_by_name ?? "unknown"}</div></td>
            <td>{x.removed_at ? <>Removed by {x.removed_by_name}: {x.removed_reason}</> : editor &&
              <details><summary>Remove</summary><form action={removeCoiAction}><input type="hidden" name="coi_id" value={x.id} /><input type="hidden" name="back" value={back} />
                <input name="reason" placeholder="Why (e.g. uploaded by mistake)" required /> <button>Remove</button></form></details>}</td>
          </tr>)}</tbody></table>}
        {editor && <details style={{ marginTop: 8 }}><summary>Upload a certificate</summary>
          <form action={uploadCoiAction}><input type="hidden" name="customer_id" value={id} /><input type="hidden" name="back" value={back} />
            <div className="row">
              <div className="field"><label>Insurance company</label><input name="insurer" required /></div>
              <div className="field"><label>Policy number</label><input name="policy_number" /></div>
              <div className="field"><label>Valid from</label><input type="date" name="effective_on" required /></div>
              <div className="field"><label>Expires</label><input type="date" name="expires_on" required /></div>
            </div>
            <div className="field"><label>Certificate (PDF, PNG or JPG)</label><input type="file" name="certificate" accept="application/pdf,image/png,image/jpeg" required /></div>
            <button>Upload certificate</button>
          </form></details>}
      </div>
      <form className="card" action={usageSettingsAction}>
        <h2>Extra hours and add-on charges</h2><input type="hidden" name="customer_id" value={id} /><input type="hidden" name="back" value={back} />
        <p className="small muted">The rental rate covers a set number of machine hours. With extra hours on, each invoice asks for the start and end hour meter readings, and every hour over the included hours is billed at the rate ÷ included hours × the multiplier (for example $3,250 ÷ 160 × 1.5 = $30.47 an hour). Add-ons left blank are not charged. Changes apply to invoices generated or recalculated afterwards; approved invoices never change.</p>
        <label className="check"><input type="checkbox" name="overtime_enabled" defaultChecked={p.overtime_enabled} disabled={!admin} /> Bill extra hours from the hour meter</label>
        <div className="row">
          <div className="field"><label>Hours a day</label><input name="hours_per_day" defaultValue={Number(p.hours_per_day).toString()} inputMode="decimal" disabled={!admin} style={{ width: 90 }} /></div>
          <div className="field"><label>Hours a week</label><input name="hours_per_week" defaultValue={Number(p.hours_per_week).toString()} inputMode="decimal" disabled={!admin} style={{ width: 90 }} /></div>
          <div className="field"><label>Hours a month</label><input name="hours_per_month" defaultValue={Number(p.hours_per_month).toString()} inputMode="decimal" disabled={!admin} style={{ width: 90 }} /></div>
          <div className="field"><label>Extra-hour multiplier</label><input name="overtime_multiplier" defaultValue={Number(p.overtime_multiplier).toString()} inputMode="decimal" disabled={!admin} style={{ width: 90 }} /></div>
        </div>
        <div className="row">
          <div className="field"><label>Damage waiver (% of rental)</label><input name="damage_waiver_pct" defaultValue={p.damage_waiver_pct ? (Number(p.damage_waiver_pct) * 100).toString() : ""} placeholder="Off" inputMode="decimal" disabled={!admin} style={{ width: 110 }} /></div>
          <div className="field"><label>Environmental fee (% of rental)</label><input name="environmental_pct" defaultValue={p.environmental_pct ? (Number(p.environmental_pct) * 100).toString() : ""} placeholder="Off" inputMode="decimal" disabled={!admin} style={{ width: 110 }} /></div>
          <div className="field"><label>Fuel price per gallon</label><input name="fuel_price_per_gallon" defaultValue={p.fuel_price_per_gallon ? Number(p.fuel_price_per_gallon).toString() : ""} placeholder="Off" inputMode="decimal" disabled={!admin} style={{ width: 110 }} /></div>
        </div>
        {admin ? <button>Save</button> : <p className="small muted">Only an administrator can change these.</p>}
      </form>
      <form className="card" action={updateProfileAction}>
        <h2>Billing rules</h2><input type="hidden" name="customer_id" value={id} /><input type="hidden" name="back" value={back} />
        <div className="grid g3">
          <div>
            <div className="field"><label>Billing method</label><select name="billing_method" defaultValue={p.billing_method} disabled={!admin}>{Object.entries(BILLING_METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <Chk name="bill_off_rent_day" label="Off-rent date is a billable day" />
            <Chk name="require_manual_approval" label="Manual approval before issuing" />
          </div>
          <div>
            <Chk name="require_monthly_po" label="New PO required every billing period" />
            <Chk name="unique_po_per_unit" label="Unique PO per machine" />
            <Chk name="invoice_level_po" label="Invoice-level PO tracking" />
            <div className="field"><label>PO format (regular expression)</label><input name="po_pattern" defaultValue={p.po_pattern ?? ""} className="mono" disabled={!admin} /></div>
            <div className="field"><label>PO format description</label><input name="po_pattern_description" defaultValue={p.po_pattern_description ?? ""} disabled={!admin} /></div>
          </div>
          <div>
            <Chk name="require_work_order" label="Work order required" />
            <Chk name="require_job_number" label="Job number required" />
            <Chk name="require_jobsite_address" label="Jobsite address required" />
            <Chk name="require_contract_attachment" label="Attach original rental agreement" />
          </div>
        </div>
        <div className="grid g4">
          <div className="field"><label>PO variance tolerance (%)</label><input name="po_variance_tolerance_pct" defaultValue={p.po_variance_tolerance_pct} disabled={!admin} /></div>
          <div className="field"><label>PO variance tolerance ($)</label><input name="po_variance_tolerance_amount" defaultValue={p.po_variance_tolerance_amount} disabled={!admin} /></div>
          <div className="field"><label>Sales tax rate (decimal)</label><input name="tax_rate" defaultValue={p.tax_rate} disabled={!admin} /><label className="check" style={{ marginTop: 4 }}><input type="checkbox" name="tax_rate_is_placeholder" defaultChecked={p.tax_rate_is_placeholder} disabled={!admin} /> Placeholder (not confirmed)</label></div>
          <div className="field"><label>Payment terms</label><div className="row"><input name="payment_terms_days" defaultValue={p.payment_terms_days} style={{ width: 70 }} disabled={!admin} /><input name="payment_terms_label" defaultValue={p.payment_terms_label} style={{ flex: 1 }} disabled={!admin} /></div></div>
        </div>
        <p className="small muted">The variance is within tolerance when it is no more than the larger of the % and $ values. A variance beyond tolerance needs a documented approval before the invoice can be released.</p>
        {admin ? <button className="btn-primary">Save billing rules</button> : <p className="muted small">Only administrators can change billing rules.</p>}
      </form>
    </>
  );
}
