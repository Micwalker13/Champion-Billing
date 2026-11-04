import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { q } from "@/lib/db";
import { fmtUSD } from "@/lib/money";
import { fmtDate, isIsoDate, monthLabel, monthStart, todayCentral } from "@/lib/dates";
import { Kpi, RentalBadge, StatusBadge, Empty } from "@/components/ui";
import { AGING_BUCKETS, BUCKET_LABELS, agingReport, rentalActivity } from "@/lib/services/reports";

export default async function Reports({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = sp.tab === "activity" ? "activity" : "aging";
  const asOf = isIsoDate(sp.asOf ?? "") ? sp.asOf : todayCentral();
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? `${sp.month}-01` : monthStart(todayCentral());
  const customers = await q(`SELECT id, name FROM customers WHERE active ORDER BY name`);
  const canExport = can(user, "export_data");
  return (
    <>
      <div className="topbar">
        <div><h1>Reports</h1><div className="muted">Money owed, statements and rental activity. Reports only read data; they never change an invoice.</div></div>
        <div className="actions">
          <a className={`btn ${tab === "aging" ? "btn-primary" : ""}`} href="/reports?tab=aging">Money owed (aging)</a>
          <a className={`btn ${tab === "activity" ? "btn-primary" : ""}`} href="/reports?tab=activity">Rental activity</a>
        </div>
      </div>
      {tab === "aging" ? <Aging asOf={asOf} showInvoices={sp.customer} canExport={canExport} /> : <Activity month={month} customerId={sp.customer} customers={customers} canExport={canExport} />}
    </>
  );
}

async function Aging({ asOf, showInvoices, canExport }: { asOf: string; showInvoices?: string; canExport: boolean }) {
  const r = await agingReport(asOf);
  const overdue = ["d1_30", "d31_60", "d61_90", "d90_plus"].reduce((s, k) => s + Number(r.totals[k as keyof typeof r.totals]), 0);
  return (
    <>
      <form className="row card" method="get" style={{ alignItems: "flex-end" }}>
        <input type="hidden" name="tab" value="aging" />
        <div className="field"><label htmlFor="asOf">As of</label><input id="asOf" type="date" name="asOf" defaultValue={asOf} /></div>
        <button>Show</button>
        {canExport && <a className="btn" href={`/api/export/aging?asOf=${asOf}`}>Download CSV</a>}
      </form>
      <div className="kpis">
        <Kpi label="Total owed" value={fmtUSD(r.totals.total)} sub={`${r.invoices.length} open invoices`} />
        <Kpi label="Not yet due" value={fmtUSD(r.totals.current)} tone="ok" />
        <Kpi label="Past due" value={fmtUSD(overdue.toFixed(2))} tone={overdue > 0 ? "bad" : "ok"} />
        <Kpi label="Over 90 days" value={fmtUSD(r.totals.d90_plus)} tone={Number(r.totals.d90_plus) > 0 ? "bad" : "ok"} />
      </div>
      <div className="card">
        <h2>By customer</h2>
        <p className="muted small">Approved and sent invoices (rentals and equipment sales) that still have a balance, grouped by how far past the due date they are on {fmtDate(asOf)}. Drafts and voided invoices are not included.</p>
        {r.customers.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Customer</th><th className="num">Invoices</th>{AGING_BUCKETS.map((b) => <th key={b} className="num">{BUCKET_LABELS[b]}</th>)}<th className="num">Total</th><th>Statement</th></tr></thead>
            <tbody>
              {r.customers.map((c) => (
                <tr key={c.customer_id}>
                  <td><a href={`/reports?tab=aging&asOf=${asOf}&customer=${c.customer_id}`}>{c.customer_name}</a></td>
                  <td className="num">{c.count}</td>
                  {AGING_BUCKETS.map((b) => <td key={b} className="num" style={b !== "current" && Number(c.totals[b]) > 0 ? { color: "var(--bad)", fontWeight: 600 } : undefined}>{fmtUSD(c.totals[b])}</td>)}
                  <td className="num"><b>{fmtUSD(c.totals.total)}</b></td>
                  <td><a className="btn btn-sm" href={`/api/statements/${c.customer_id}?asOf=${asOf}`} target="_blank">Statement PDF</a></td>
                </tr>
              ))}
              <tr><td><b>All customers</b></td><td className="num">{r.invoices.length}</td>{AGING_BUCKETS.map((b) => <td key={b} className="num"><b>{fmtUSD(r.totals[b])}</b></td>)}<td className="num"><b>{fmtUSD(r.totals.total)}</b></td><td /></tr>
            </tbody>
          </table></div>
        ) : <Empty>Nothing is owed as of {fmtDate(asOf)}.</Empty>}
      </div>
      {showInvoices && (
        <div className="card">
          <h2>Open invoices: {r.customers.find((c) => c.customer_id === showInvoices)?.customer_name ?? "customer"}</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Invoice</th><th>Status</th><th>Unit</th><th>PO</th><th>Period</th><th>Due</th><th className="num">Days late</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Balance</th></tr></thead>
            <tbody>{r.invoices.filter((i) => i.customer_id === showInvoices).map((i) => (
              <tr key={`${i.kind}${i.id}`}>
                <td><a href={i.href}>{i.invoice_number}</a>{i.kind === "sale" && <div className="small muted">Equipment sale</div>}</td><td><StatusBadge status={i.status} /></td><td>{i.unit}</td><td className="mono">{i.po_number ?? "—"}</td>
                <td className="nowrap">{fmtDate(i.period_start)} – {fmtDate(i.period_end)}</td><td>{fmtDate(i.due_date)}</td>
                <td className="num" style={i.days_past_due > 0 ? { color: "var(--bad)" } : undefined}>{i.days_past_due || "—"}</td>
                <td className="num">{fmtUSD(i.total)}</td><td className="num">{fmtUSD(i.amount_paid)}</td><td className="num"><b>{fmtUSD(i.balance)}</b></td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
    </>
  );
}

async function Activity({ month, customerId, customers, canExport }: { month: string; customerId?: string; customers: any[]; canExport: boolean }) {
  const r = await rentalActivity(month, customerId);
  const ym = month.slice(0, 7);
  return (
    <>
      <form className="row card" method="get" style={{ alignItems: "flex-end" }}>
        <input type="hidden" name="tab" value="activity" />
        <div className="field"><label htmlFor="month">Month</label><input id="month" type="month" name="month" defaultValue={ym} /></div>
        <div className="field"><label htmlFor="customer">Customer</label><select id="customer" name="customer" defaultValue={customerId ?? ""}><option value="">All customers</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <button>Show</button>
        {canExport && <a className="btn" href={`/api/export/rental-activity?month=${ym}${customerId ? `&customer=${customerId}` : ""}`}>Download CSV</a>}
      </form>
      <div className="kpis">
        <Kpi label="Machines on rent" value={r.totals.lines} sub={monthLabel(month)} />
        <Kpi label="Machine-days on rent" value={r.totals.unit_days} />
        <Kpi label="Approved billing for the month" value={fmtUSD(r.totals.billed_this_month)} />
      </div>
      <div className="card">
        <h2>Rental activity: {monthLabel(month)}</h2>
        <p className="muted small">Every machine that was on rent at any point in the month. &ldquo;Billed through&rdquo; is the end of the last approved invoice period, so you can compare it with Quipli.</p>
        {r.rows.length ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Unit</th><th>Customer</th><th>Rental</th><th>Status</th><th>On rent</th><th>Off rent</th><th className="num">Days this month</th><th>Billed through</th><th className="num">Billed this month</th><th className="num">Billed to date</th><th className="num">Paid to date</th></tr></thead>
            <tbody>{r.rows.map((x: any) => (
              <tr key={x.line_id}>
                <td><a href={`/rentals/${x.line_id}`}>{x.unit_number}</a><div className="small muted">{x.description}</div></td>
                <td>{x.customer_name}</td><td>{x.contract_number}</td><td><RentalBadge status={x.status} /></td>
                <td>{fmtDate(x.on_rent_date)}</td><td>{fmtDate(x.off_rent_date)}</td><td className="num">{x.days_on_rent}</td>
                <td>{fmtDate(x.billed_through)}</td><td className="num">{fmtUSD(x.billed_this_month)}</td><td className="num">{fmtUSD(x.billed_to_date)}</td><td className="num">{fmtUSD(x.paid_to_date)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>No machines were on rent in {monthLabel(month)}.</Empty>}
      </div>
    </>
  );
}
