import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { REQUEST_LABELS, REQUEST_STATUS_LABELS, listPortalRequests } from "@/lib/services/portal";
import { fmtDate } from "@/lib/dates";
import { Empty, Flash } from "@/components/ui";
import { acceptPortalCoiAction, closePortalRequestAction } from "../../actions";

export const dynamic = "force-dynamic";
const REQ_CLASS: Record<string, string> = { open: "b-info", done: "b-ok", declined: "b-bad" };
const when = (t: any) => (t instanceof Date ? t.toISOString() : String(t)).slice(0, 10);

export default async function PortalRequestsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const status = ["open", "done", "declined"].includes(sp.status) ? sp.status : sp.status === "all" ? null : "open";
  const rows = await listPortalRequests({ status });
  const editor = can(user, "edit_records");
  const back = `/portal-requests${sp.status ? `?status=${encodeURIComponent(sp.status)}` : ""}`;
  return (
    <>
      <div className="topbar"><div><h1>Customer requests</h1>
        <div className="muted small">Sent by customers from the customer portal. Nothing changes on its own: make the change on the rental (call-off, new end date), then mark the request done with a note the customer will see.</div></div>
        <div className="row">{[["open", "Open"], ["done", "Done"], ["declined", "Declined"], ["all", "All"]].map(([k, l]) =>
          <a key={k} className={`btn btn-sm${(status ?? "all") === k ? " btn-primary" : ""}`} href={`/portal-requests?status=${k}`}>{l}</a>)}</div>
      </div>
      <Flash sp={sp} />
      {rows.length === 0 ? <Empty>No {status ?? ""} requests.</Empty> : rows.map((r: any) => (
        <section className="card" key={r.id}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <div><strong>{REQUEST_LABELS[r.kind]}</strong> from <a href={`/customers/${r.customer_id}`}>{r.customer_name}</a>
              <span className="muted small"> · {r.portal_user_name} ({r.portal_user_email}) · sent {fmtDate(when(r.created_at))}</span></div>
            <span className={`badge ${REQ_CLASS[r.status] ?? ""}`}>{REQUEST_STATUS_LABELS[r.status]}</span>
          </div>
          <div className="small" style={{ marginTop: 6 }}>
            {r.unit_number && <div>Machine: <a href={`/rentals/${r.contract_line_id}`} className="mono">{r.unit_number}</a> on contract <span className="mono">{r.contract_number}</span></div>}
            {r.requested_date && <div>{r.kind === "pickup" ? "Ready for pickup on" : "Wants to keep it until"} <strong>{fmtDate(r.requested_date)}</strong></div>}
            {r.message && <div style={{ whiteSpace: "pre-wrap" }}>&ldquo;{r.message}&rdquo;</div>}
            {r.file_name && <div>Attached: <a href={`/api/portal-requests/${r.id}/file`} target="_blank" rel="noopener">{r.file_name}</a></div>}
            {r.status !== "open" && <div className="muted">{REQUEST_STATUS_LABELS[r.status]} by {r.handled_by_name ?? "staff"} on {fmtDate(when(r.handled_at))}{r.response ? `: ${r.response}` : ""}</div>}
          </div>
          {r.status === "open" && editor && <div className="grid g2" style={{ marginTop: 10 }}>
            {r.kind === "coi" && <form action={acceptPortalCoiAction} className="card" style={{ marginBottom: 0 }}>
              <strong>File this certificate</strong>
              <p className="small muted">Check the details against the attached certificate. Once filed, it counts for the damage waiver like any certificate you add on the customer.</p>
              <input type="hidden" name="request_id" value={r.id} /><input type="hidden" name="back" value={back} />
              <div className="grid g2">
                <div className="field"><label>Insurance company</label><input name="insurer" defaultValue={r.coi_insurer ?? ""} required /></div>
                <div className="field"><label>Policy number</label><input name="policy_number" defaultValue={r.coi_policy ?? ""} /></div>
                <div className="field"><label>Effective</label><input type="date" name="effective_on" defaultValue={r.coi_effective_on ?? ""} required /></div>
                <div className="field"><label>Expires</label><input type="date" name="expires_on" defaultValue={r.coi_expires_on ?? ""} required /></div>
              </div>
              <button className="btn-primary" type="submit">File certificate and close</button>
            </form>}
            <form action={closePortalRequestAction} className="card" style={{ marginBottom: 0 }}>
              <strong>Answer the customer</strong>
              <input type="hidden" name="request_id" value={r.id} /><input type="hidden" name="back" value={back} />
              <div className="field"><label>Note the customer sees</label><textarea name="response" rows={2} maxLength={2000} placeholder={r.kind === "pickup" ? "Pickup scheduled for ..." : ""} /></div>
              <div className="row">
                <button className="btn-primary" type="submit" name="status" value="done">Mark done</button>
                <button type="submit" name="status" value="declined">Decline</button>
              </div>
            </form>
          </div>}
        </section>
      ))}
    </>
  );
}
