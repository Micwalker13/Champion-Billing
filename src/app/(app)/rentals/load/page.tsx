import { requireUser } from "@/lib/session";
import { one, q } from "@/lib/db";
import { rentalBatches } from "@/lib/services/rental-import";
import { Flash, Empty } from "@/components/ui";
import { uploadRentalFileAction } from "../../../actions";

export default async function RentalLoad({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireUser("edit_records");
  const sp = await searchParams;
  const customers = await q(`SELECT id, name FROM customers WHERE active ORDER BY name`);
  const rpm = await one(`SELECT id FROM customers WHERE customer_code='RPMX'`);
  const batches = await rentalBatches();
  return (
    <>
      <div className="topbar"><div><div className="muted small"><a href="/rentals">Rentals</a> / Bulk load</div><h1>Bulk-load existing rentals</h1>
        <div className="muted">Load the rentals already running in Quipli from a spreadsheet. Nothing is created until you review the preview.</div></div></div>
      <Flash sp={sp} />
      <form className="card" action={uploadRentalFileAction}>
        <input type="hidden" name="back" value="/rentals/load" />
        <div className="row">
          <div className="field"><label>Customer</label><select name="customer_id" defaultValue={rpm?.id}>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div className="field" style={{ flexBasis: 260 }}><label>CSV or Excel file</label><input type="file" name="file" accept=".csv,.xlsx" required /></div>
          <button className="btn-primary">Upload &amp; preview</button>
        </div>
        <p className="small muted">Columns (header names are matched flexibly): <strong>Contract, Unit, Start Date, Rate</strong> (required); Description, Serial, Make, Model, Bill From <em>or</em> Billed Through, Rate Basis (default monthly), Job, Work Order, Jobsite, Jobsite Address, Quipli Reference, Notes. <a href="/api/sample/rental-load-template.csv">Download template</a></p>
        <p className="small muted"><strong>Bill From</strong> is the first day this system should bill. For RPM rentals billed in Quipli through October 31, use 11/01/2026 so no day is billed twice.</p>
      </form>
      <div className="table-wrap"><table><thead><tr><th>#</th><th>Customer</th><th>File</th><th className="num">Rows</th><th>Status</th><th>Uploaded</th></tr></thead>
        <tbody>{batches.map((b: any) => <tr key={b.id}><td><a href={`/rentals/load/${b.id}`}>#{b.id}</a></td><td>{b.customer_name}</td><td>{b.filename}</td><td className="num">{b.n}</td><td><span className={`badge ${b.status === "applied" ? "b-ok" : b.status === "review" ? "b-info" : ""}`}>{b.status}</span></td><td className="small">{new Date(b.uploaded_at).toLocaleString("en-US", { timeZone: "America/Chicago" })}</td></tr>)}</tbody>
      </table>{!batches.length && <Empty>No loads yet.</Empty>}</div>
    </>
  );
}
