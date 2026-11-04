import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { invoiceDetail, STATUS_LABELS } from "@/lib/services/invoices";
import { fmtUSD } from "@/lib/money";
import { fmtDate, todayCentral } from "@/lib/dates";
import { Flash, StatusBadge } from "@/components/ui";
import { approveInvoiceAction, issueInvoiceAction, overrideAction, paymentAction, refreshInvoiceAction, rejectInvoiceAction, reviseInvoiceAction, submitInvoiceAction, voidInvoiceAction } from "../../../actions";

const ICON: Record<string, string> = { pass: "✓", fail: "✗", warn: "!", info: "i" };

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const d = await invoiceDetail(id);
  if (!d) notFound();
  const { inv, lines, checks, reconciliation: rec } = d;
  const s = inv.snapshot;
  const back = `/invoices/${id}`;
  const blocking = checks.filter((c) => (c.status === "fail" || c.status === "warn") && !c.override);
  const H = ({ children }: { children: React.ReactNode }) => <><input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={back} />{children}</>;
  const finalized = !!inv.finalized_at;

  return (
    <>
      <div className="topbar">
        <div>
          <div className="muted small"><a href="/invoices">Invoices</a> / <a href={`/rentals/${inv.contract_line_id}`}>{s.equipment.unit_number}</a></div>
          <h1>{inv.invoice_number ?? `Draft invoice #${inv.id}`} <StatusBadge status={inv.status} />{inv.revision_no > 0 && <span className="badge b-info" style={{ marginLeft: 6 }}>Revision {inv.revision_no}</span>}</h1>
          <div className="muted">{s.customer.name} · Unit {s.equipment.unit_number} · {finalized ? `Finalized ${new Date(inv.finalized_at).toLocaleString("en-US", { timeZone: "America/Chicago" })} by ${inv.approved_by_name}` : "Not finalized: recalculates from current data"}</div>
        </div>
        <div className="actions">
          <a className="btn btn-primary" href={`/api/invoices/${id}/pdf`} target="_blank" rel="noopener">{finalized ? "Download PDF" : "Preview draft PDF"}</a>
        </div>
      </div>
      <Flash sp={sp} />
      {inv.status === "corrected" && <div className="alert alert-info">This invoice was superseded by a correction. It is kept unchanged for the record. {d.revisions.filter((r: any) => r.id !== inv.id).map((r: any) => <a key={r.id} href={`/invoices/${r.id}`}>{r.invoice_number ?? `Revision draft #${r.id}`}</a>)}</div>}
      {inv.revision_of && <div className="alert alert-info">Correction of <a href={`/invoices/${inv.revision_of}`}>the original invoice</a>.</div>}
      {inv.status === "rejected" && <div className="alert alert-bad">Rejected: {inv.rejection_reason}</div>}
      {inv.status === "voided" && <div className="alert alert-bad">Voided: {inv.void_reason}</div>}

      <div className="po-box">
        <div><div className="k">Customer PO number</div><div className="v mono">{inv.po_number ?? <span style={{ color: "var(--bad)" }}>None assigned</span>}</div></div>
        <div><div className="k">Billing period</div><div className="v">{fmtDate(inv.period_start)} – {fmtDate(inv.period_end)}</div></div>
        <div><div className="k">Original rental agreement</div><div className="v">{s.contract.number}</div></div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h2>Invoice</h2>
          <dl className="kv">
            <dt>Invoice date</dt><dd>{fmtDate(inv.invoice_date)}</dd>
            <dt>Due date</dt><dd>{fmtDate(inv.due_date)}</dd>
            <dt>Terms</dt><dd>{s.terms.label}</dd>
            <dt>Bill to</dt><dd style={{ whiteSpace: "pre-line" }}>{s.customer.name}{"\n"}{s.customer.billing_address}</dd>
            <dt>Jobsite</dt><dd style={{ whiteSpace: "pre-line" }}>{s.jobsite ? `${s.jobsite.name}\n${s.jobsite.address}` : "—"}</dd>
            <dt>Job / work order</dt><dd>{s.job_number ?? "—"} / {s.work_order_number ?? "—"}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Equipment</h2>
          <dl className="kv">
            <dt>Unit</dt><dd className="mono">{s.equipment.unit_number}</dd>
            <dt>Description</dt><dd>{s.equipment.description}</dd>
            <dt>Serial</dt><dd>{s.equipment.serial_number ?? "—"}</dd>
            <dt>Rental start</dt><dd>{fmtDate(s.line.on_rent_date)}</dd>
            <dt>Billing method</dt><dd>{s.period.billing_method}</dd>
            <dt>Attachments</dt><dd>{d.attachments.length ? d.attachments.map((a: any) => <div key={a.id}><a href={`/api/documents/${a.id}`}>{a.filename}</a></div>) : "—"}</dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <h2>Charges</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th><th>Taxable</th></tr></thead>
          <tbody>{lines.map((l: any) => <tr key={l.id}><td>{l.description}</td><td className="num">{Number(l.quantity).toString()} {l.unit}</td><td className="num">{fmtUSD(l.unit_price)}</td><td className="num">{fmtUSD(l.amount)}</td><td>{l.taxable ? "Yes" : "No"}</td></tr>)}</tbody>
          <tfoot>
            <tr><td colSpan={3} className="right">Subtotal</td><td className="num">{fmtUSD(inv.subtotal)}</td><td /></tr>
            <tr><td colSpan={3} className="right">Tax ({(Number(inv.tax_rate) * 100).toFixed(3).replace(/\.?0+$/, "")}% on {fmtUSD(inv.taxable_amount)}){s.tax?.is_placeholder && <span className="badge b-warn" style={{ marginLeft: 6 }}>Placeholder rate</span>}</td><td className="num">{fmtUSD(inv.tax_amount)}</td><td /></tr>
            <tr><td colSpan={3} className="right"><strong>Total</strong></td><td className="num"><strong>{fmtUSD(inv.total)}</strong></td><td /></tr>
            {Number(inv.amount_paid) > 0 && <tr><td colSpan={3} className="right">Paid</td><td className="num">{fmtUSD(inv.amount_paid)}</td><td /></tr>}
          </tfoot>
        </table></div>
        <p className="small muted">{inv.calc_details?.explanation}</p>
      </div>

      {rec && <div className="card">
        <h2>PO value reconciliation</h2>
        <div className="table-wrap"><table><tbody>
          <tr><td>Customer-supplied PO total (estimate)</td><td className="num">{fmtUSD(rec.poTotal)}</td></tr>
          <tr><td>Calculated subtotal</td><td className="num">{fmtUSD(rec.subtotal)}</td></tr>
          <tr><td>Tax</td><td className="num">{fmtUSD(rec.tax)}</td></tr>
          <tr><td>Final invoice total</td><td className="num">{fmtUSD(rec.total)}</td></tr>
          <tr><td><strong>Variance</strong> (tolerance ±{fmtUSD(rec.tolerance)})</td><td className="num"><strong style={{ color: rec.within ? "var(--ok)" : "var(--bad)" }}>{fmtUSD(rec.variance)} ({rec.pct}%)</strong></td></tr>
        </tbody></table></div>
        <p className="small muted">The PO total is RPM&apos;s estimate. It is not treated as a spending limit, and rental rates are never changed to match it.</p>
      </div>}

      <div className="card">
        <h2>Release checks {blocking.length ? <span className="badge b-bad">{blocking.length} blocking</span> : <span className="badge b-ok">Ready</span>}</h2>
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.rule}>
              <span className={`icon-${c.status}`} style={{ fontWeight: 700 }}>{ICON[c.status]}</span>
              <div>
                <strong>{c.label}</strong> <span className="muted">· {c.message}</span>
                {c.override && <div className="small" style={{ color: "var(--info)" }}>Override by {c.override.user_name} on {new Date(c.override.at).toLocaleDateString("en-US", { timeZone: "America/Chicago" })}: “{c.override.reason}”</div>}
                {!finalized && !c.override && (c.status === "fail" || c.status === "warn") && c.overridable && can(user, "override_validation") && (
                  <details><summary className="small">Record an authorized override</summary>
                    <form action={overrideAction} className="row" style={{ marginTop: 6 }}><H><input type="hidden" name="rule" value={c.rule} />
                      <div className="field"><input name="reason" placeholder="Reason and who authorized it" required minLength={5} /></div><button className="btn-sm">Override</button></H></form>
                  </details>)}
              </div>
            </li>))}
        </ul>
      </div>

      <div className="card">
        <h2>Actions</h2>
        <div className="actions">
          {["draft", "rejected"].includes(inv.status) && can(user, "generate_invoice") && <form action={refreshInvoiceAction} className="inline"><H><button>Recalculate from current PO and rental data</button></H></form>}
          {inv.status === "draft" && can(user, "submit_invoice") && <form action={submitInvoiceAction} className="inline"><H><button className="btn-primary">Submit for review</button></H></form>}
          {inv.status === "pending_review" && can(user, "approve_invoice") && <form action={approveInvoiceAction} className="row"><H><div className="field"><input name="invoice_number" placeholder="Invoice # (blank = next in sequence)" aria-label="Invoice number" /></div><button className="btn-primary" disabled={blocking.length > 0} title={blocking.length ? "Resolve or override blocking checks first" : ""}>Approve &amp; finalize</button></H></form>}
          {inv.status === "approved" && can(user, "issue_invoice") && <form action={issueInvoiceAction} className="inline"><H><button className="btn-primary">Mark issued to customer</button></H></form>}
        </div>
        {inv.status === "pending_review" && can(user, "approve_invoice") && (
          <form action={rejectInvoiceAction} className="row" style={{ marginTop: 10 }}><H><div className="field"><input name="reason" placeholder="Reason for rejecting" required /></div><button className="btn-danger">Reject</button></H></form>)}
        {["issued", "overdue", "partially_paid"].includes(inv.status) && can(user, "record_payment") && (
          <form action={paymentAction} className="row" style={{ marginTop: 10 }}><H>
            <div className="field"><label>Payment amount</label><input name="amount" inputMode="decimal" required /></div>
            <div className="field"><label>Date</label><input type="date" name="paid_on" defaultValue={todayCentral()} required /></div>
            <div className="field"><label>Method</label><input name="method" placeholder="Check / ACH" /></div>
            <div className="field"><label>Reference</label><input name="reference" /></div>
            <button>Record payment</button></H></form>)}
        {finalized && ["approved", "issued", "overdue"].includes(inv.status) && can(user, "void_invoice") && (
          <details style={{ marginTop: 12 }}><summary>Correct this invoice (revision or void)</summary>
            <p className="small muted">Finalized invoices are never edited. A revision creates a new draft (numbered {inv.invoice_number}-R{inv.revision_no + 1}) from current data and marks this one as corrected. Voiding frees the billing period to be invoiced again.</p>
            <form action={reviseInvoiceAction} className="row"><H><div className="field"><input name="reason" placeholder="Reason for correction (e.g. RPM reissued PO)" required minLength={5} /></div><button>Create revision</button></H></form>
            <form action={voidInvoiceAction} className="row" style={{ marginTop: 8 }}><H><div className="field"><input name="reason" placeholder="Reason for voiding" required minLength={5} /></div><button className="btn-danger">Void</button></H></form>
          </details>)}
        {inv.status === "draft" && can(user, "void_invoice") && (
          <details style={{ marginTop: 12 }}><summary>Void this draft</summary>
            <form action={voidInvoiceAction} className="row" style={{ marginTop: 6 }}><H><div className="field"><input name="reason" placeholder="Reason" required minLength={5} /></div><button className="btn-danger">Void draft</button></H></form></details>)}
      </div>

      <div className="card">
        <h2>History</h2>
        <div className="table-wrap"><table><thead><tr><th>When</th><th>Change</th><th>By</th><th>Note</th></tr></thead><tbody>
          {d.history.map((h: any) => <tr key={h.id}><td className="nowrap">{new Date(h.at).toLocaleString("en-US", { timeZone: "America/Chicago" })}</td><td>{h.from_status ? `${STATUS_LABELS[h.from_status]} → ` : ""}{STATUS_LABELS[h.to_status]}</td><td>{h.user_name ?? "System"}</td><td>{h.note}</td></tr>)}
          {d.payments.map((p: any) => <tr key={`p${p.id}`}><td>{fmtDate(p.paid_on)}</td><td>Payment {fmtUSD(p.amount)}</td><td /><td>{[p.method, p.reference].filter(Boolean).join(" · ")}</td></tr>)}
        </tbody></table></div>
        {inv.pdf_sha256 && <p className="small muted mono">Stored PDF SHA-256: {inv.pdf_sha256}</p>}
      </div>
    </>
  );
}
