import { requirePortalUser } from "@/lib/portal-session";
import { REQUEST_LABELS, REQUEST_STATUS_LABELS, portalOverview } from "@/lib/services/portal";
import { RATE_BASIS_LABELS } from "@/lib/billing";
import { fmtDate, todayCentral } from "@/lib/dates";
import { dec, fmtUSD } from "@/lib/money";
import { Flash } from "@/components/ui";
import { portalSignOutAction, portalSubmitRequestAction } from "./actions";

export const dynamic = "force-dynamic";

function invoiceState(i: any) {
  if (i.status === "voided" || i.status === "corrected") return <span className="badge">Void</span>;
  if (dec(i.balance).lte(0)) return <span className="badge b-ok">Paid</span>;
  if (i.due_date && i.due_date < todayCentral()) return <span className="badge b-bad">Past due</span>;
  return <span className="badge b-accent">Open</span>;
}
const REQ_CLASS: Record<string, string> = { open: "b-info", done: "b-ok", declined: "b-bad" };

export default async function PortalHome({ searchParams }: { searchParams: Promise<{ msg?: string; err?: string }> }) {
  const pu = await requirePortalUser();
  const sp = await searchParams;
  const o = await portalOverview(pu);
  const today = todayCentral();
  const active = o.rentals.filter((r: any) => r.status === "active");
  const LinePick = () => (
    <div className="field"><label>Machine</label>
      <select name="contract_line_id" required defaultValue="">
        <option value="" disabled>Pick a machine</option>
        {o.rentals.map((r: any) => <option key={r.id} value={r.id}>{r.unit_number} {r.description} (contract {r.contract_number})</option>)}
      </select></div>
  );
  return (
    <main className="main" style={{ maxWidth: 1000, margin: "0 auto" }}>
      <div className="topbar">
        <div><div className="muted small">Champion Equipment customer portal</div><h1>{pu.customer_name}</h1><div className="muted small">Signed in as {pu.name} ({pu.email})</div></div>
        <form action={portalSignOutAction}><button className="btn-sm" type="submit">Sign out</button></form>
      </div>
      <Flash sp={sp} />

      <div className="grid g3">
        <div className="card"><div className="muted small">Machines on rent</div><div style={{ fontSize: 24, fontWeight: 700 }}>{active.length}</div></div>
        <div className="card"><div className="muted small">Open balance</div><div style={{ fontSize: 24, fontWeight: 700 }}>{fmtUSD(o.openBalance)}</div></div>
        <div className="card"><div className="muted small">Insurance certificate</div><div style={{ fontWeight: 600, marginTop: 6 }}>
          {(() => { const c = o.cois.find((x: any) => x.effective_on <= today && x.expires_on >= today);
            return c ? <>Good through {fmtDate(c.expires_on)}</> : <span style={{ color: "var(--bad)" }}>None current on file</span>; })()}
        </div></div>
      </div>

      <section className="card">
        <h2>Your rentals</h2>
        {o.rentals.length === 0 ? <p className="muted">No machines on rent right now.</p> :
          <div className="table-wrap"><table><thead><tr><th>Unit</th><th>Machine</th><th>Contract</th><th>Jobsite</th><th>On rent</th><th>Rate</th><th>Status</th></tr></thead><tbody>
            {o.rentals.map((r: any) => <tr key={r.id}>
              <td className="mono">{r.unit_number}</td><td>{r.description}</td><td className="mono">{r.contract_number}</td><td>{r.jobsite ?? ""}</td>
              <td>{fmtDate(r.on_rent_date)}</td><td>{fmtUSD(r.rate_amount)} {RATE_BASIS_LABELS[r.rate_basis as keyof typeof RATE_BASIS_LABELS]?.toLowerCase() ?? r.rate_basis}</td>
              <td>{r.status === "active" ? <span className="badge b-ok">On rent</span> : <span className="badge b-warn">Called off{r.off_rent_date ? ` ${fmtDate(r.off_rent_date)}` : ""}</span>}</td>
            </tr>)}
          </tbody></table></div>}
      </section>

      <section className="card">
        <h2>Invoices</h2>
        {o.invoices.length === 0 ? <p className="muted">No invoices yet.</p> :
          <div className="table-wrap"><table><thead><tr><th>Invoice</th><th>Date</th><th>PO</th><th>Unit</th><th>Period</th><th className="num">Total</th><th className="num">Balance</th><th>Status</th><th></th></tr></thead><tbody>
            {o.invoices.map((i: any) => <tr key={i.id}>
              <td className="mono">{i.invoice_number}</td><td>{fmtDate(i.invoice_date)}</td><td className="mono">{i.po_number ?? ""}</td><td className="mono">{i.unit_number ?? ""}</td>
              <td>{i.period_start ? `${fmtDate(i.period_start)} to ${fmtDate(i.period_end)}` : ""}</td>
              <td className="num">{fmtUSD(i.total)}</td><td className="num">{fmtUSD(i.balance)}</td><td>{invoiceState(i)}</td>
              <td><a href={`/portal/invoices/${i.id}/pdf`} target="_blank" rel="noopener">PDF</a></td>
            </tr>)}
          </tbody></table></div>}
        <p className="small muted" style={{ marginBottom: 0 }}>Questions about an invoice? Send us a question below.</p>
      </section>

      <section className="card" id="requests">
        <h2>Send a request</h2>
        <p className="small muted">Our team reviews every request and confirms with you. Nothing changes on your rental until they do.</p>
        <div className="grid g2">
          <details className="card" style={{ marginBottom: 0 }}><summary><strong>{REQUEST_LABELS.pickup}</strong></summary>
            {o.rentals.length === 0 ? <p className="muted small">No machines on rent.</p> :
              <form action={portalSubmitRequestAction}><input type="hidden" name="kind" value="pickup" />
                <LinePick />
                <div className="field"><label>Ready for pickup on</label><input type="date" name="requested_date" min={today} defaultValue={today} required /></div>
                <div className="field"><label>Notes (where it is, gate code, contact)</label><textarea name="message" rows={2} maxLength={2000} /></div>
                <button className="btn-primary" type="submit">Send pickup request</button></form>}
          </details>
          <details className="card" style={{ marginBottom: 0 }}><summary><strong>{REQUEST_LABELS.extension}</strong></summary>
            {o.rentals.length === 0 ? <p className="muted small">No machines on rent.</p> :
              <form action={portalSubmitRequestAction}><input type="hidden" name="kind" value="extension" />
                <LinePick />
                <div className="field"><label>Keep it until</label><input type="date" name="requested_date" min={today} required /></div>
                <div className="field"><label>Notes</label><textarea name="message" rows={2} maxLength={2000} /></div>
                <button className="btn-primary" type="submit">Send extension request</button></form>}
          </details>
          <details className="card" style={{ marginBottom: 0 }}><summary><strong>{REQUEST_LABELS.coi}</strong></summary>
            <form action={portalSubmitRequestAction} encType="multipart/form-data"><input type="hidden" name="kind" value="coi" />
              <p className="small muted">If you insure our equipment under your own policy, send your certificate here. Our team checks it before it counts.</p>
              <div className="field"><label>Certificate (PDF, PNG or JPG)</label><input type="file" name="file" accept="application/pdf,image/png,image/jpeg" required /></div>
              <div className="grid g2">
                <div className="field"><label>Insurance company</label><input name="coi_insurer" maxLength={200} /></div>
                <div className="field"><label>Policy number</label><input name="coi_policy" maxLength={100} /></div>
                <div className="field"><label>Effective</label><input type="date" name="coi_effective_on" /></div>
                <div className="field"><label>Expires</label><input type="date" name="coi_expires_on" /></div>
              </div>
              <button className="btn-primary" type="submit">Send certificate</button></form>
          </details>
          <details className="card" style={{ marginBottom: 0 }}><summary><strong>{REQUEST_LABELS.question}</strong></summary>
            <form action={portalSubmitRequestAction}><input type="hidden" name="kind" value="question" />
              <div className="field"><label>Your question</label><textarea name="message" rows={3} maxLength={2000} required /></div>
              <button className="btn-primary" type="submit">Send question</button></form>
          </details>
        </div>
      </section>

      <section className="card">
        <h2>Your requests</h2>
        {o.requests.length === 0 ? <p className="muted">No requests yet.</p> :
          <div className="table-wrap"><table><thead><tr><th>Sent</th><th>Request</th><th>Unit</th><th>Date</th><th>Status</th><th>Our answer</th></tr></thead><tbody>
            {o.requests.map((r: any) => <tr key={r.id}>
              <td>{fmtDate(String(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at).slice(0, 10))}</td><td>{REQUEST_LABELS[r.kind]}</td>
              <td className="mono">{r.unit_number ?? ""}</td><td>{r.requested_date ? fmtDate(r.requested_date) : ""}</td>
              <td><span className={`badge ${REQ_CLASS[r.status] ?? ""}`}>{REQUEST_STATUS_LABELS[r.status]}</span></td><td>{r.response ?? ""}</td>
            </tr>)}
          </tbody></table></div>}
      </section>
    </main>
  );
}
