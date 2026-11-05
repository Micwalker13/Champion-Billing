import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { invoiceDetail, STATUS_LABELS } from "@/lib/services/invoices";
import { creditsForInvoice, invoiceBalance } from "@/lib/services/credits";
import { emailEnabled, emailsFor } from "@/lib/services/email";
import { usageForm } from "@/lib/services/usage";
import { fmtUSD } from "@/lib/money";
import { fmtDate, todayCentral } from "@/lib/dates";
import { Flash, StatusBadge } from "@/components/ui";
import { saveUsageAction, creditAction, emailCreditAction, emailInvoiceAction, approveInvoiceAction, issueInvoiceAction, overrideAction, paymentAction, refreshInvoiceAction, rejectInvoiceAction, reviseInvoiceAction, submitInvoiceAction, voidInvoiceAction } from "../../../actions";

const ICON: Record<string, string> = { pass: "✓", fail: "✗", warn: "!", info: "i" };

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const d = await invoiceDetail(id);
  if (!d) notFound();
  const { inv, lines, checks, reconciliation: rec, profile } = d;
  const [credits, emails, usage] = await Promise.all([creditsForInvoice(id), emailsFor("invoice", id), usageForm(id).catch(() => [])]);
  const mailOn = emailEnabled();
  const s = inv.snapshot;
  const back = `/invoices/${id}`;
  const blocking = checks.filter((c) => (c.status === "fail" || c.status === "warn") && !c.override);
  const H = ({ children }: { children: React.ReactNode }) => <><input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={back} />{children}</>;
  const finalized = !!inv.finalized_at;
  const showUsage = profile?.overtime_enabled || profile?.fuel_price_per_gallon || usage.some((u) => u.saved);
  const usageEditable = ["draft", "rejected"].includes(inv.status) && can(user, "generate_invoice");
  const hrs = (v: string | null) => (v == null ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: 1 }));

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

      {showUsage && <div className="card">
        <h2>Hour meter and fuel</h2>
        <p className="small muted">
          {profile?.overtime_enabled
            ? `The rate covers ${Number(profile.hours_per_month)} hours a month (${Number(profile.hours_per_day)} a day, ${Number(profile.hours_per_week)} a week). Each extra hour is billed at the rate ÷ included hours × ${Number(profile.overtime_multiplier)}.`
            : "Extra hours aren't billed for this customer; readings still go into each unit's hour meter history."}
          {" "}{profile?.fuel_price_per_gallon ? `Fuel is billed at ${fmtUSD(profile.fuel_price_per_gallon)} a gallon.` : ""}
          {usage.length > 1 ? " The unit was exchanged during this period, so enter readings for each unit." : ""}
        </p>
        {usageEditable ? (
          <form action={saveUsageAction}><H>
            <div className="table-wrap"><table>
              <thead><tr><th>Unit</th><th>On site</th><th>Start reading</th><th>End reading</th><th>Fuel added (gal)</th></tr></thead>
              <tbody>{usage.map((u) => <tr key={u.equipment_id}>
                <td><input type="hidden" name="eid" value={u.equipment_id} /><strong>{u.unit_number}</strong> <span className="muted small">{u.description}</span></td>
                <td className="small">{fmtDate(u.from)} – {fmtDate(u.to)}</td>
                <td><input name={`start_${u.equipment_id}`} inputMode="decimal" defaultValue={u.start_hours ?? u.start_hint ?? ""} aria-label={`Start reading for ${u.unit_number}`} style={{ width: 110 }} />
                  {!u.start_hours && u.start_hint && <div className="small muted">From {u.start_source}</div>}</td>
                <td><input name={`end_${u.equipment_id}`} inputMode="decimal" defaultValue={u.end_hours ?? u.end_hint ?? ""} aria-label={`End reading for ${u.unit_number}`} style={{ width: 110 }} />
                  {!u.end_hours && u.end_hint && <div className="small muted">From {u.end_source}</div>}</td>
                <td><input name={`fuel_${u.equipment_id}`} inputMode="decimal" defaultValue={Number(u.fuel_gallons) ? u.fuel_gallons : ""} aria-label={`Fuel for ${u.unit_number}`} style={{ width: 90 }} /></td>
              </tr>)}</tbody>
            </table></div>
            <button style={{ marginTop: 8 }}>Save readings and recalculate</button>
          </H></form>
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Unit</th><th>On site</th><th className="num">Start</th><th className="num">End</th><th className="num">Hours</th><th className="num">Fuel (gal)</th></tr></thead>
            <tbody>{usage.map((u) => <tr key={u.equipment_id}><td>{u.unit_number}</td><td className="small">{fmtDate(u.from)} – {fmtDate(u.to)}</td>
              <td className="num">{hrs(u.start_hours)}</td><td className="num">{hrs(u.end_hours)}</td>
              <td className="num">{u.start_hours != null && u.end_hours != null ? hrs((Number(u.end_hours) - Number(u.start_hours)).toFixed(1)) : "—"}</td>
              <td className="num">{Number(u.fuel_gallons) ? u.fuel_gallons : "—"}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>}

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
          {finalized && !["voided", "corrected"].includes(inv.status) && can(user, "issue_invoice") && (mailOn
            ? <form action={emailInvoiceAction} className="inline"><H><button className={inv.status === "approved" ? "btn-primary" : ""}>{emails.some((e: any) => e.status === "sent") ? "Email again" : "Email to customer"}</button></H></form>
            : <span className="small muted">Email isn&rsquo;t switched on yet.</span>)}
          {inv.status === "approved" && can(user, "issue_invoice") && <form action={issueInvoiceAction} className="inline"><H><button>Mark issued (sent another way)</button></H></form>}
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
        {finalized && ["approved", "issued", "overdue", "partially_paid"].includes(inv.status) && can(user, "void_invoice") && (
          <details style={{ marginTop: 12 }}><summary>Issue a credit memo</summary>
            <p className="small muted">For an overcharge, a disputed day, or a machine that was down. The invoice stays exactly as sent; the credit is its own numbered PDF ({inv.invoice_number}-CM{credits.length + 1}) and lowers this invoice&rsquo;s balance. Open balance: {fmtUSD(invoiceBalance(inv).toFixed(2))}.</p>
            <form action={creditAction} className="row"><H>
              <div className="field"><label>Credit before tax</label><input name="amount" inputMode="decimal" required placeholder="0.00" /></div>
              <label className="check"><input type="checkbox" name="credit_tax" defaultChecked /> Also credit the sales tax</label>
              <div className="field" style={{ flexBasis: 280 }}><label>Reason (prints on the credit)</label><input name="reason" required minLength={5} placeholder="e.g. Unit down 3 days for repair, 11/12–11/14" /></div>
              <button>Issue credit</button></H></form>
          </details>)}
        {finalized && ["approved", "issued", "overdue"].includes(inv.status) && Number(inv.amount_credited) === 0 && can(user, "void_invoice") && (
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
          {credits.map((c: any) => <tr key={`c${c.id}`}><td>{fmtDate(c.credit_date)}</td><td>Credit <a href={`/api/credits/${c.id}/pdf`} target="_blank" rel="noopener">{c.credit_number}</a> {fmtUSD(c.total)}</td><td>{c.created_by_name}</td><td>{c.reason}{mailOn && can(user, "issue_invoice") && <form action={emailCreditAction} className="inline" style={{ marginLeft: 8 }}><H><input type="hidden" name="credit_id" value={c.id} /><button className="btn-sm">Email credit</button></H></form>}</td></tr>)}
          {emails.map((e: any) => <tr key={`e${e.id}`}><td className="nowrap">{new Date(e.sent_at).toLocaleString("en-US", { timeZone: "America/Chicago" })}</td><td>{e.status === "sent" ? "Emailed" : <span style={{ color: "var(--bad)" }}>Email failed</span>} to {e.to_addresses}</td><td>{e.sent_by_name}</td><td className="small">{e.error ?? e.subject}</td></tr>)}
          {d.payments.map((p: any) => <tr key={`p${p.id}`}><td>{fmtDate(p.paid_on)}</td><td>Payment {fmtUSD(p.amount)}</td><td /><td>{[p.method, p.reference].filter(Boolean).join(" · ")}</td></tr>)}
        </tbody></table></div>
        {inv.pdf_sha256 && <p className="small muted mono">Stored PDF SHA-256: {inv.pdf_sha256}</p>}
      </div>
    </>
  );
}
