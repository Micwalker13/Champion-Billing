import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { q } from "@/lib/db";
import { fmtUSD } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { RATE_BASIS_LABELS } from "@/lib/billing";
import { Flash, RentalBadge, Empty } from "@/components/ui";

export default async function Rentals({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const customers = await q(`SELECT id, name FROM customers ORDER BY name`);
  const rows = await q(
    `SELECT l.id, l.status, l.on_rent_date, l.billing_start_date, l.off_rent_date, l.rate_amount, l.rate_basis, e.unit_number, e.description, rc.contract_number, rc.job_number, rc.work_order_number, c.name AS customer
     FROM rental_contract_lines l JOIN rental_contracts rc ON rc.id=l.contract_id JOIN customers c ON c.id=rc.customer_id JOIN equipment e ON e.id=l.equipment_id
     WHERE ($1::bigint IS NULL OR c.id=$1) AND ($2::text IS NULL OR l.status=$2) AND ($3::text IS NULL OR e.unit_number ILIKE '%'||$3||'%' OR rc.contract_number ILIKE '%'||$3||'%')
     ORDER BY c.name, e.unit_number`, [sp.customer || null, sp.status ?? "active", sp.q || null]);
  return (
    <>
      <div className="topbar"><div><h1>Rentals</h1><div className="muted">Continuous rental agreements. Monthly invoices never close or restart them.</div></div>
        {can(user, "edit_records") && <div className="actions"><a className="btn" href="/rentals/load">Bulk load from spreadsheet</a><a className="btn btn-primary" href="/rentals/new">New rental</a></div>}</div>
      <Flash sp={sp} />
      <form className="card row" method="get">
        <div className="field"><label>Customer</label><select name="customer" defaultValue={sp.customer ?? ""}><option value="">All</option>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="field"><label>Status</label><select name="status" defaultValue={sp.status ?? "active"}><option value="">Any</option><option value="active">Active</option><option value="off_rent">Off-rent</option><option value="returned">Returned</option><option value="closed">Closed</option></select></div>
        <div className="field"><label>Unit or agreement</label><input name="q" defaultValue={sp.q} /></div>
        <button type="submit">Filter</button>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Unit</th><th>Agreement</th><th>Customer</th><th>Job / WO</th><th>On rent</th><th>Billing here from</th><th className="num">Rate</th><th>Status</th></tr></thead>
        <tbody>{rows.map((r: any) => <tr key={r.id}>
          <td><a className="mono" href={`/rentals/${r.id}`}>{r.unit_number}</a><div className="small muted">{r.description}</div></td>
          <td>{r.contract_number}</td><td>{r.customer}</td><td className="small">{r.job_number ?? "—"} / {r.work_order_number ?? "—"}</td>
          <td>{fmtDate(r.on_rent_date)}</td><td>{fmtDate(r.billing_start_date)}</td><td className="num">{fmtUSD(r.rate_amount)} <span className="muted small">{RATE_BASIS_LABELS[r.rate_basis as keyof typeof RATE_BASIS_LABELS]}</span></td>
          <td><RentalBadge status={r.status} />{r.off_rent_date && <div className="small muted">off {fmtDate(r.off_rent_date)}</div>}</td></tr>)}</tbody>
      </table>{!rows.length && <Empty>No rentals match.</Empty>}</div>
    </>
  );
}
