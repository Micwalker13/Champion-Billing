import { requireUser } from "@/lib/session";
import { overview } from "@/lib/services/dashboard";
import { addMonths, monthLabel, monthStart, todayCentral } from "@/lib/dates";
import { fmtUSD } from "@/lib/money";
import { Flash, Kpi, StatusBadge, Empty } from "@/components/ui";

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireUser();
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? `${sp.month}-01` : monthStart(todayCentral());
  const o = await overview(month);
  const ym = month.slice(0, 7);
  return (
    <>
      <div className="topbar">
        <div><h1>Billing dashboard</h1><div className="muted">{monthLabel(month)} · all customers</div></div>
        <div className="actions">
          <a className="btn" href={`/?month=${addMonths(month, -1).slice(0, 7)}`}>← Prev</a>
          <form className="inline"><input type="month" name="month" defaultValue={ym} aria-label="Month" style={{ width: 160 }} /> <button>Go</button></form>
          <a className="btn" href={`/?month=${addMonths(month, 1).slice(0, 7)}`}>Next →</a>
        </div>
      </div>
      <Flash sp={sp} />
      <div className="kpis">
        <Kpi label="Active rentals" value={o.active} href="/rentals" />
        <Kpi label={`Billable in ${monthLabel(month)}`} value={o.billable} />
        <Kpi label="Invoices this month" value={o.invoicesThisMonth} href={`/invoices?month=${ym}`} />
        <Kpi label="PO assignments this month" value={`${o.poAssigned}`} sub={`of ${o.billable} machines`} />
        <Kpi label="Missing POs" value={o.missingPo.length} tone={o.missingPo.length ? "bad" : "ok"} href={`/rpm?month=${ym}&flag=missing`} />
        <Kpi label="Pending approvals" value={o.pendingAll} tone={o.pendingAll ? "warn" : undefined} href="/invoices?status=pending_review" />
        <Kpi label="Discrepancies" value={o.discrepancies.length} tone={o.discrepancies.length ? "warn" : "ok"} />
        <Kpi label="Unbilled rentals" value={o.unbilled.length} tone={o.unbilled.length ? "warn" : "ok"} />
        <Kpi label="Overdue invoices" value={o.overdue.n} sub={fmtUSD(o.overdue.amt)} tone={o.overdue.n ? "bad" : undefined} href="/invoices?status=overdue" />
        <Kpi label="Billed this month" value={fmtUSD(o.billed)} sub="approved and later" />
        <div className="kpi"><div className="label">Billing completion</div><div className="value">{o.completionPct}%</div><div className="sub">{o.finalized} of {o.billable} finalized</div><div className="progress"><div style={{ width: `${o.completionPct}%` }} /></div></div>
      </div>
      <div className="grid g2">
        <div className="card">
          <h2>Active rentals by customer</h2>
          {o.byCustomer.length ? <div className="table-wrap"><table><thead><tr><th>Customer</th><th className="num">Machines</th><th></th></tr></thead><tbody>
            {o.byCustomer.map((c: any) => <tr key={c.id}><td>{c.name}</td><td className="num">{c.n}</td><td className="right"><a href={`/rpm?customer=${c.id}&month=${ym}`}>Billing board</a></td></tr>)}
          </tbody></table></div> : <Empty>No active rentals.</Empty>}
        </div>
        <div className="card">
          <h2>Needs attention</h2>
          {[...o.missingPo.map((r: any) => ({ r, why: "Missing PO" })), ...o.discrepancies.map((r: any) => ({ r, why: r.flags.filter((f: string) => f.startsWith("PO")).join(", ") }))].slice(0, 12).map(({ r, why }, i) => (
            <div key={i} className="row" style={{ justifyContent: "space-between", padding: "5px 0", borderBottom: "1px dashed var(--line)" }}>
              <span><a href={`/rentals/${r.line_id}`} className="mono">{r.unit_number}</a> <span className="muted small">{r.customer_name}</span></span>
              <span className="badge b-warn">{why}</span>
            </div>
          ))}
          {!o.missingPo.length && !o.discrepancies.length && <Empty>Nothing needs attention for this month.</Empty>}
        </div>
      </div>
      <div className="card">
        <h2>Current-month invoices</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Unit</th><th>Customer</th><th>PO</th><th>Invoice</th><th>Status</th><th className="num">Total</th></tr></thead>
          <tbody>{o.rows.filter((r: any) => r.invoice_id).slice(0, 50).map((r: any) => (
            <tr key={r.line_id}><td className="mono">{r.unit_number}</td><td>{r.customer_name}</td><td className="mono">{r.invoice_po ?? "—"}</td>
              <td><a href={`/invoices/${r.invoice_id}`}>{r.invoice_number ?? `Draft #${r.invoice_id}`}</a></td><td><StatusBadge status={r.invoice_status} /></td><td className="num">{fmtUSD(r.invoice_total)}</td></tr>
          ))}</tbody>
        </table>{!o.rows.some((r: any) => r.invoice_id) && <Empty>No invoices generated for {monthLabel(month)} yet.</Empty>}</div>
      </div>
    </>
  );
}
