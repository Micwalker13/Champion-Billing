import { requireUser } from "@/lib/session";
import { q } from "@/lib/db";
import { fmtUSD } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { Flash, StatusBadge, Empty } from "@/components/ui";
import { STATUS_LABELS } from "@/lib/services/invoices";

export default async function Invoices({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireUser();
  const sp = await searchParams;
  const customers = await q(`SELECT id, name FROM customers ORDER BY name`);
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? `${sp.month}-01` : null;
  const rows = await q(
    `SELECT i.id, i.invoice_number, i.status, i.po_number, i.period_start, i.period_end, i.total, i.invoice_date, i.due_date, i.revision_no,
            i.snapshot->'equipment'->>'unit_number' AS unit, i.snapshot->'contract'->>'number' AS contract, c.name AS customer
     FROM invoices i JOIN customers c ON c.id=i.customer_id
     WHERE ($1::bigint IS NULL OR i.customer_id=$1) AND ($2::text IS NULL OR i.status=$2) AND ($3::date IS NULL OR (i.period_start <= ($3::date + interval '1 month' - interval '1 day') AND i.period_end >= $3::date))
       AND ($4::text IS NULL OR i.snapshot->'equipment'->>'unit_number' ILIKE '%'||$4||'%') AND ($5::text IS NULL OR i.po_number ILIKE '%'||$5||'%')
     ORDER BY i.period_start DESC, unit LIMIT 500`,
    [sp.customer || null, sp.status || null, month, sp.unit || null, sp.po || null]);
  const qs = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && !["msg", "err"].includes(k))).toString();
  return (
    <>
      <div className="topbar"><div><h1>Invoices</h1><div className="muted">{rows.length} shown</div></div>
        <a className="btn" href={`/api/export/invoices${qs ? `?${qs}` : ""}`}>Export CSV</a></div>
      <Flash sp={sp} />
      <form className="card row" method="get">
        <div className="field"><label>Customer</label><select name="customer" defaultValue={sp.customer ?? ""}><option value="">All</option>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="field"><label>Billing month</label><input type="month" name="month" defaultValue={sp.month} /></div>
        <div className="field"><label>Status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">Any</option>{Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label>Equipment</label><input name="unit" defaultValue={sp.unit} /></div>
        <div className="field"><label>PO number</label><input name="po" defaultValue={sp.po} /></div>
        <button type="submit">Filter</button>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Invoice</th><th>Customer</th><th>Unit</th><th>Agreement</th><th>PO</th><th>Billing period</th><th>Status</th><th className="num">Total</th><th>Due</th></tr></thead>
        <tbody>{rows.map((r: any) => (
          <tr key={r.id}>
            <td><a href={`/invoices/${r.id}`}>{r.invoice_number ?? `Draft #${r.id}`}</a>{r.revision_no > 0 && <span className="badge b-info" style={{ marginLeft: 4 }}>Rev {r.revision_no}</span>}</td>
            <td>{r.customer}</td><td className="mono">{r.unit}</td><td>{r.contract}</td><td className="mono" style={{ fontWeight: 700 }}>{r.po_number ?? <span className="badge b-bad">None</span>}</td>
            <td className="nowrap">{fmtDate(r.period_start)} – {fmtDate(r.period_end)}</td><td><StatusBadge status={r.status} /></td><td className="num">{fmtUSD(r.total)}</td><td className="nowrap">{fmtDate(r.due_date)}</td>
          </tr>))}</tbody>
      </table>{!rows.length && <Empty>No invoices match.</Empty>}</div>
    </>
  );
}
