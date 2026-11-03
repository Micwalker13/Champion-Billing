import { requireUser } from "@/lib/session";
import { q } from "@/lib/db";

export default async function Audit({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireUser();
  const sp = await searchParams;
  const rows = await q(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
                        WHERE ($1::text IS NULL OR a.entity=$1) AND ($2::text IS NULL OR a.action=$2) ORDER BY a.id DESC LIMIT 300`, [sp.entity || null, sp.action || null]);
  const entities = await q(`SELECT DISTINCT entity FROM audit_log ORDER BY 1`);
  return (
    <>
      <div className="topbar"><div><h1>Audit log</h1><div className="muted">Append-only. The database rejects edits and deletions.</div></div><a className="btn" href="/api/export/audit">Export CSV</a></div>
      <form className="card row" method="get">
        <div className="field"><label>Record type</label><select name="entity" defaultValue={sp.entity ?? ""}><option value="">All</option>{entities.map((e: any) => <option key={e.entity}>{e.entity}</option>)}</select></div>
        <div className="field"><label>Action</label><input name="action" defaultValue={sp.action} placeholder="e.g. correct_po" /></div>
        <button>Filter</button>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Change</th><th>Note</th></tr></thead>
        <tbody>{rows.map((r: any) => <tr key={r.id}>
          <td className="nowrap small">{new Date(r.at).toLocaleString("en-US", { timeZone: "America/Chicago" })}</td><td>{r.user_name ?? "System"}</td><td className="mono small">{r.action}</td><td className="small">{r.entity} {r.entity_id}</td>
          <td className="small" style={{ maxWidth: 420 }}><details><summary>View</summary><pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{r.before ? `Before: ${JSON.stringify(r.before, null, 1)}\n` : ""}{r.after ? `After: ${JSON.stringify(r.after, null, 1)}` : ""}</pre></details></td>
          <td className="small">{r.note}</td></tr>)}</tbody>
      </table></div>
    </>
  );
}
