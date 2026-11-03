import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { rentalBatch, RentalRow } from "@/lib/services/rental-import";
import { fmtUSD } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { Flash, Kpi } from "@/components/ui";
import { applyRentalBatchAction, cancelRentalBatchAction } from "../../../../actions";

export default async function RentalLoadPreview({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  await requireUser("edit_records");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const b = await rentalBatch(id);
  if (!b) notFound();
  const rows = b.rows as RentalRow[];
  const bad = rows.filter((r) => r.errors.length).length;
  const back = `/rentals/load/${id}`;
  return (
    <>
      <div className="topbar"><div><div className="muted small"><a href="/rentals/load">Bulk load</a> / #{id}</div><h1>Preview: {b.filename}</h1><div className="muted">{b.customer_name}</div></div>
        <span className={`badge ${b.status === "applied" ? "b-ok" : "b-info"}`} style={{ fontSize: 14 }}>{b.status}</span></div>
      <Flash sp={sp} />
      <div className="kpis">
        <Kpi label="Rows" value={rows.length} />
        <Kpi label="Ready" value={rows.length - bad} tone="ok" />
        <Kpi label="With errors" value={bad} tone={bad ? "bad" : "ok"} />
        <Kpi label="New equipment records" value={rows.filter((r) => r.creates_equipment).length} />
      </div>
      {b.status === "review" && <div className="card actions">
        <form action={applyRentalBatchAction} className="inline"><input type="hidden" name="batch_id" value={id} /><input type="hidden" name="back" value={back} /><button className="btn-primary" disabled={bad > 0}>Create {rows.length} rental(s)</button></form>
        <form action={cancelRentalBatchAction} className="inline"><input type="hidden" name="batch_id" value={id} /><input type="hidden" name="back" value={back} /><button className="btn-danger">Cancel</button></form>
        <span className="small muted">{bad ? "Fix the rows with errors in your spreadsheet and upload it again." : "All rows are created in one transaction, or none are."}</span>
      </div>}
      <div className="table-wrap"><table>
        <thead><tr><th>Row</th><th>Contract</th><th>Unit</th><th>Description</th><th>Start</th><th>Bill from</th><th className="num">Rate</th><th>Job / WO</th><th>Jobsite</th><th>Check</th></tr></thead>
        <tbody>{rows.map((r) => { const v = r.values; return (
          <tr key={r.row_number} style={{ background: r.errors.length ? "#fff7f7" : undefined }}>
            <td>{r.row_number}</td><td className="nowrap">{v.contract_number ?? "—"}</td><td className="mono">{v.unit_number ?? "—"}</td><td>{v.description ?? "—"}<div className="small muted">{v.serial_number}</div></td>
            <td className="nowrap">{fmtDate(v.start_date)}</td><td className="nowrap">{fmtDate(v.billing_start_date ?? v.start_date)}</td><td className="num">{fmtUSD(v.rate_amount)} <span className="small muted">{v.rate_basis}</span></td>
            <td className="small">{v.job_number ?? "—"} / {v.work_order_number ?? "—"}</td><td className="small" style={{ whiteSpace: "pre-line" }}>{[v.jobsite_name, v.jobsite_address].filter(Boolean).join("\n") || "—"}</td>
            <td style={{ minWidth: 220 }}>{r.errors.map((e, i) => <div key={i} className="issue error">✗ {e}</div>)}{r.notes.map((n, i) => <div key={i} className="issue info">i {n}</div>)}{!r.errors.length && !r.notes.length && <span className="issue" style={{ color: "var(--ok)" }}>✓ Ready</span>}</td>
          </tr>); })}</tbody>
      </table></div>
    </>
  );
}
