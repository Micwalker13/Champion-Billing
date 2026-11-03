import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { importDetail } from "@/lib/services/imports";
import { fmtUSD } from "@/lib/money";
import { monthLabel } from "@/lib/dates";
import { Flash, Kpi } from "@/components/ui";
import { applyImportAction, approveCleanAction, cancelImportAction, decideRowAction, editRowAction } from "../../../actions";

export default async function ImportReview({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const d = await importDetail(id);
  if (!d) notFound();
  const { batch, rows } = d;
  const s = batch.summary ?? {};
  const open = batch.status === "review";
  const back = `/imports/${id}`;
  const editable = open && can(user, "import_po");
  const B = ({ children }: { children: React.ReactNode }) => <><input type="hidden" name="batch_id" value={id} /><input type="hidden" name="back" value={back} />{children}</>;
  return (
    <>
      <div className="topbar">
        <div><div className="muted small"><a href="/imports">PO imports</a> / #{id}</div>
          <h1>Review import #{id}: {batch.customer_name}, {monthLabel(batch.billing_month)}</h1>
          <div className="muted">{batch.filename} · uploaded by {batch.uploaded_by_name} · <span className="mono small">sha256 {batch.file_sha256.slice(0, 12)}…</span></div></div>
        <span className={`badge ${batch.status === "applied" ? "b-ok" : batch.status === "review" ? "b-info" : ""}`} style={{ fontSize: 14 }}>{batch.status === "review" ? "Awaiting review" : batch.status}</span>
      </div>
      <Flash sp={sp} />
      <div className="kpis">
        <Kpi label="Rows in file" value={s.rows} />
        <Kpi label="Matched to active rentals" value={`${s.matched} / ${s.rows}`} tone={s.matched === s.rows ? "ok" : "warn"} />
        <Kpi label="Rows with errors" value={s.with_errors} tone={s.with_errors ? "bad" : "ok"} />
        <Kpi label="Rows with warnings" value={s.with_warnings} tone={s.with_warnings ? "warn" : "ok"} />
        <Kpi label="Approved / skipped / pending" value={`${s.approved} / ${s.skipped} / ${s.pending}`} />
        <Kpi label="Active rentals missing from file" value={s.missing_from_file?.length ?? 0} tone={s.missing_from_file?.length ? "bad" : "ok"} />
      </div>
      {s.missing_from_file?.length > 0 && <div className="alert alert-warn"><strong>Active rentals not in this file:</strong> {s.missing_from_file.map((m: any) => `${m.unit_number} (${m.contract_number})`).join(", ")}. These machines will show as missing a PO for {monthLabel(batch.billing_month)}.</div>}
      {open && <div className="card actions">
        {editable && <form action={approveCleanAction} className="inline"><B><button>Approve all rows with no issues</button></B></form>}
        {can(user, "apply_import") && <form action={applyImportAction} className="inline"><B><button className="btn-primary" disabled={s.pending > 0 || s.approved === 0}>Apply {s.approved} approved PO assignment(s)</button></B></form>}
        {editable && <form action={cancelImportAction} className="inline"><B><button className="btn-danger">Cancel import</button></B></form>}
        <span className="small muted">{s.pending > 0 ? `${s.pending} row(s) still need a decision before applying.` : "All rows decided."} Applying runs in a single transaction: all approved rows are assigned, or none are.</span>
      </div>}
      <div className="table-wrap"><table>
        <thead><tr><th>Row</th><th>Unit</th><th>PO</th><th>Job</th><th>WO</th><th className="num">PO total</th><th className="num">Expected</th><th>Matched rental</th><th>Issues</th><th>Decision</th></tr></thead>
        <tbody>{rows.map((r: any) => {
          const errs = r.issues.filter((i: any) => i.severity === "error");
          return (
            <tr key={r.id} style={{ background: r.decision === "skipped" ? "#f6f6f6" : errs.length ? "#fff7f7" : undefined }}>
              <td>{r.row_number}{r.edited && <div><span className="badge b-info">edited</span></div>}</td>
              <td className="mono">{r.unit_number ?? "—"}</td><td className="mono" style={{ fontWeight: 700 }}>{r.po_number ?? "—"}</td><td>{r.job_number ?? "—"}</td><td>{r.work_order_number ?? "—"}</td>
              <td className="num">{fmtUSD(r.po_total)}</td><td className="num">{fmtUSD(r.expected_total)}</td>
              <td className="small">{r.matched_line_id ? <a href={`/rentals/${r.matched_line_id}`}>{r.contract_number}</a> : <span className="badge b-bad">No match</span>}{r.equipment_description && <div className="muted">{r.equipment_description}</div>}</td>
              <td style={{ minWidth: 260 }}>
                {r.issues.length ? r.issues.map((i: any, k: number) => <div key={k} className={`issue ${i.severity}`}>{i.severity === "error" ? "✗" : i.severity === "warning" ? "!" : "i"} {i.message}</div>) : <span className="issue info" style={{ color: "var(--ok)" }}>✓ No issues</span>}
                {editable && <details><summary className="small">Correct this row</summary>
                  <form action={editRowAction} style={{ marginTop: 6 }}><input type="hidden" name="row_id" value={r.id} /><input type="hidden" name="back" value={back} />
                    <div className="row">
                      <div className="field"><label>Unit</label><input name="unit_number" defaultValue={r.unit_number ?? ""} /></div>
                      <div className="field"><label>PO</label><input name="po_number" defaultValue={r.po_number ?? ""} /></div>
                      <div className="field"><label>Job</label><input name="job_number" defaultValue={r.job_number ?? ""} /></div>
                      <div className="field"><label>WO</label><input name="work_order_number" defaultValue={r.work_order_number ?? ""} /></div>
                      <div className="field"><label>PO total</label><input name="po_total" defaultValue={r.po_total ?? ""} /></div>
                    </div>
                    <div className="row" style={{ marginTop: 6 }}><div className="field"><input name="note" placeholder="Why (e.g. confirmed with RPM by phone)" required /></div><button className="btn-sm">Save &amp; re-check</button></div>
                  </form></details>}
              </td>
              <td className="nowrap">
                <span className={`badge ${r.decision === "approved" ? "b-ok" : r.decision === "skipped" ? "" : "b-info"}`}>{r.decision}</span>
                {r.decided_by_name && <div className="small muted">{r.decided_by_name}</div>}
                {r.decision_note && <div className="small muted">“{r.decision_note}”</div>}
                {editable && <div className="actions" style={{ marginTop: 4 }}>
                  {r.decision !== "approved" && errs.length === 0 && <form action={decideRowAction} className="inline"><input type="hidden" name="row_id" value={r.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="decision" value="approved" />
                    {r.issues.some((i: any) => i.severity === "warning") && <input name="note" placeholder="Reason for accepting warning" required style={{ width: 170, marginBottom: 4 }} />}
                    <button className="btn-sm">Approve</button></form>}
                  {r.decision !== "skipped" && <form action={decideRowAction} className="inline"><input type="hidden" name="row_id" value={r.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="decision" value="skipped" /><button className="btn-sm">Skip</button></form>}
                  {r.decision !== "pending" && <form action={decideRowAction} className="inline"><input type="hidden" name="row_id" value={r.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="decision" value="pending" /><button className="btn-sm">Undo</button></form>}
                </div>}
              </td>
            </tr>);
        })}</tbody>
      </table></div>
    </>
  );
}
