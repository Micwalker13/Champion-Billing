import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { one, q } from "@/lib/db";
import { customerMonthSummary } from "@/lib/services/dashboard";
import { addMonths, monthLabel, monthStart, todayCentral } from "@/lib/dates";
import { fmtUSD } from "@/lib/money";
import { Flash, Kpi, StatusBadge, RentalBadge, Empty } from "@/components/ui";
import { STATUS_LABELS } from "@/lib/services/invoices";
import { assignPoAction, bulkApproveAction, bulkSubmitAction, generateMonthAction } from "../../actions";

export default async function RpmBoard({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? `${sp.month}-01` : monthStart(todayCentral());
  const ym = month.slice(0, 7);
  const customers = await q(`SELECT id, name FROM customers WHERE active ORDER BY name`);
  const rpm = await one(`SELECT id FROM customers WHERE customer_code='RPMX'`);
  const customerId = sp.customer || rpm?.id || customers[0]?.id;
  if (!customerId) return <Empty>Add a customer first.</Empty>;
  const customer = await one(`SELECT c.*, p.* FROM customers c JOIN customer_billing_profiles p ON p.customer_id=c.id WHERE c.id=$1`, [customerId]);
  const { stats, rows: all, imports } = await customerMonthSummary(customerId, month, { unit: sp.unit || undefined, po: sp.po || undefined, status: sp.status || undefined });
  const rows = sp.flag === "missing" ? all.filter((r: any) => r.flags.includes("Missing PO")) : sp.flag === "issues" ? all.filter((r: any) => r.flags.length) : all;
  const back = `/rpm?customer=${customerId}&month=${ym}${sp.unit ? `&unit=${encodeURIComponent(sp.unit)}` : ""}${sp.po ? `&po=${encodeURIComponent(sp.po)}` : ""}${sp.status ? `&status=${sp.status}` : ""}${sp.flag ? `&flag=${sp.flag}` : ""}`;
  const pct = (n: number) => (stats.active ? Math.round((n / stats.active) * 100) : 0);
  return (
    <>
      <div className="topbar">
        <div><h1>{customer.name} billing</h1><div className="muted">{monthLabel(month)} · {customer.require_monthly_po ? "new PO required per machine every month" : "monthly PO not required"}</div></div>
        <div className="actions">
          <a className="btn" href={`/rpm?customer=${customerId}&month=${addMonths(month, -1).slice(0, 7)}`}>← {monthLabel(addMonths(month, -1))}</a>
          <a className="btn" href={`/rpm?customer=${customerId}&month=${addMonths(month, 1).slice(0, 7)}`}>{monthLabel(addMonths(month, 1))} →</a>
        </div>
      </div>
      <Flash sp={sp} />
      {customer.proration_policy === "unapproved" && <div className="alert alert-warn">Partial-month proration is not approved for {customer.name}, so partial months (mid-month deliveries and call-offs) can't be invoiced yet. Full months bill normally. <a href={`/customers/${customerId}`}>Billing profile</a></div>}
      <div className="kpis">
        <Kpi label="Active machines" value={stats.active} />
        <Kpi label="POs received" value={stats.posReceived} sub="from applied imports" />
        <Kpi label="POs assigned" value={`${stats.posAssigned} / ${stats.active}`} tone={stats.posAssigned < stats.active ? "warn" : "ok"} sub={<div className="progress"><div style={{ width: `${pct(stats.posAssigned)}%` }} /></div>} />
        <Kpi label="Invoices generated" value={`${stats.generated} / ${stats.active}`} sub={<div className="progress"><div style={{ width: `${pct(stats.generated)}%` }} /></div>} />
        <Kpi label="Pending review" value={stats.pending} tone={stats.pending ? "warn" : undefined} />
        <Kpi label="Invoices approved" value={`${stats.approved} / ${stats.active}`} sub={<div className="progress"><div style={{ width: `${pct(stats.approved)}%` }} /></div>} />
        <Kpi label="Invoices submitted to customer" value={`${stats.submitted} / ${stats.active}`} sub={<div className="progress"><div style={{ width: `${pct(stats.submitted)}%` }} /></div>} />
      </div>

      <div className="card">
        <div className="actions">
          <a className="btn" href={`/imports?customer=${customerId}&month=${ym}`}>Import PO file</a>
          {can(user, "generate_invoice") && <form action={generateMonthAction} className="inline"><input type="hidden" name="customer_id" value={customerId} /><input type="hidden" name="month" value={month} /><input type="hidden" name="back" value={back} /><button className="btn-primary">Generate draft invoices for {monthLabel(month)}</button></form>}
          {can(user, "submit_invoice") && <form action={bulkSubmitAction} className="inline"><input type="hidden" name="customer_id" value={customerId} /><input type="hidden" name="month" value={month} /><input type="hidden" name="back" value={back} /><button>Submit all drafts for review</button></form>}
          {can(user, "approve_invoice") && <form action={bulkApproveAction} className="inline"><input type="hidden" name="customer_id" value={customerId} /><input type="hidden" name="month" value={month} /><input type="hidden" name="back" value={back} /><button>Approve all that pass checks</button></form>}
          {imports.length > 0 && <span className="muted small">Imports this month: {imports.map((i: any) => <a key={i.id} href={`/imports/${i.id}`} style={{ marginRight: 6 }}>#{i.id} ({i.status})</a>)}</span>}
        </div>
      </div>

      <form className="card row" method="get">
        <input type="hidden" name="month" value={ym} />
        <div className="field"><label>Customer</label><select name="customer" defaultValue={customerId}>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="field"><label>Equipment</label><input name="unit" defaultValue={sp.unit} placeholder="Unit #" /></div>
        <div className="field"><label>PO number</label><input name="po" defaultValue={sp.po} /></div>
        <div className="field"><label>Invoice status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">Any</option><option value="none">Not generated</option>{Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label>Show</label><select name="flag" defaultValue={sp.flag ?? ""}><option value="">All machines</option><option value="missing">Missing PO</option><option value="issues">Any flag</option></select></div>
        <button type="submit">Filter</button>
      </form>

      <div className="table-wrap">
        <table>
          <thead><tr><th>Unit</th><th>Rental</th><th>Job / WO</th><th>{monthLabel(month)} PO</th><th className="num">PO total</th><th>Invoice</th><th>Status</th><th className="num">Invoice total</th><th>Flags</th></tr></thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.line_id}>
                <td><a className="mono" href={`/rentals/${r.line_id}`}>{r.unit_number}</a><div className="small muted">{r.description}</div></td>
                <td>{r.contract_number}<div><RentalBadge status={r.line_status} /></div></td>
                <td className="small">{r.po_job ?? r.contract_job ?? "—"} / {r.po_wo ?? r.contract_wo ?? "—"}</td>
                <td>{r.po_number ? <span className="mono" style={{ fontWeight: 700 }}>{r.po_number}</span> : can(user, "assign_po") ? (
                  <form action={assignPoAction} className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                    <input type="hidden" name="line_id" value={r.line_id} /><input type="hidden" name="period" value={month} /><input type="hidden" name="back" value={back} />
                    <input name="po_number" placeholder="PO #" required style={{ width: 90 }} aria-label={`PO for ${r.unit_number}`} />
                    <button className="btn-sm">Assign</button>
                  </form>) : <span className="badge b-bad">Missing</span>}</td>
                <td className="num">{fmtUSD(r.estimated_total)}</td>
                <td>{r.invoice_id ? <a href={`/invoices/${r.invoice_id}`}>{r.invoice_number ?? `Draft #${r.invoice_id}`}</a> : <span className="muted">—</span>}</td>
                <td>{r.invoice_status ? <StatusBadge status={r.invoice_status} /> : <span className="badge">Not generated</span>}</td>
                <td className="num">{fmtUSD(r.invoice_total)}</td>
                <td>{r.flags.map((f: string) => <span key={f} className={`badge ${f === "Missing PO" ? "b-bad" : "b-warn"}`} style={{ marginRight: 4 }}>{f}</span>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty>No machines match these filters.</Empty>}
      </div>
    </>
  );
}
