import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { one, q } from "@/lib/db";
import { fmtDate, monthLabel, monthStart, todayCentral } from "@/lib/dates";
import { Flash, Empty } from "@/components/ui";
import { uploadImportAction } from "../../actions";

export default async function Imports({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const customers = await q(`SELECT id, name FROM customers WHERE active ORDER BY name`);
  const rpm = await one(`SELECT id FROM customers WHERE customer_code='RPMX'`);
  const batches = await q(`SELECT b.id, b.billing_month, b.filename, b.status, b.row_count, b.summary, b.uploaded_at, b.applied_at, c.name AS customer, u.name AS uploaded_by, ua.name AS applied_by
                           FROM import_batches b JOIN customers c ON c.id=b.customer_id LEFT JOIN users u ON u.id=b.uploaded_by LEFT JOIN users ua ON ua.id=b.applied_by ORDER BY b.id DESC LIMIT 200`);
  return (
    <>
      <div className="topbar"><div><h1>PO imports</h1><div className="muted">Upload the customer&apos;s monthly PO list. Nothing is assigned until you review and apply it.</div></div></div>
      <Flash sp={sp} />
      {can(user, "import_po") && <form className="card" action={uploadImportAction}>
        <h2>New import</h2>
        <input type="hidden" name="back" value="/imports" />
        <div className="row">
          <div className="field"><label>Customer</label><select name="customer_id" defaultValue={sp.customer ?? rpm?.id}>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div className="field"><label>Billing month</label><input type="month" name="month" required defaultValue={sp.month ?? monthStart(todayCentral()).slice(0, 7)} /></div>
          <div className="field" style={{ flexBasis: 260 }}><label>CSV or Excel file</label><input type="file" name="file" accept=".csv,.xlsx" required /></div>
          <button className="btn-primary">Upload &amp; preview</button>
        </div>
        <p className="small muted">Expected columns: PO Number, Unit, Work Order, Job, PO Total. Header names are matched flexibly. Sample files: <a href="/api/sample/rpm-po-2026-11.csv">CSV</a> · <a href="/api/sample/rpm-po-2026-11.xlsx">Excel</a></p>
      </form>}
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Customer</th><th>Month</th><th>File</th><th className="num">Rows</th><th>Errors</th><th>Status</th><th>Uploaded</th><th>Applied</th></tr></thead>
        <tbody>{batches.map((b: any) => <tr key={b.id}>
          <td><a href={`/imports/${b.id}`}>#{b.id}</a></td><td>{b.customer}</td><td>{monthLabel(b.billing_month)}</td><td>{b.filename}</td><td className="num">{b.row_count}</td>
          <td>{b.summary?.with_errors ? <span className="badge b-bad">{b.summary.with_errors}</span> : <span className="badge b-ok">0</span>}</td>
          <td><span className={`badge ${b.status === "applied" ? "b-ok" : b.status === "review" ? "b-info" : ""}`}>{b.status}</span></td>
          <td className="small">{b.uploaded_by}<br />{new Date(b.uploaded_at).toLocaleString("en-US", { timeZone: "America/Chicago" })}</td>
          <td className="small">{b.applied_by ? <>{b.applied_by}<br />{new Date(b.applied_at).toLocaleString("en-US", { timeZone: "America/Chicago" })}</> : "—"}</td>
        </tr>)}</tbody>
      </table>{!batches.length && <Empty>No imports yet.</Empty>}</div>
    </>
  );
}
