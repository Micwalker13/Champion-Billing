import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { q } from "@/lib/db";
import { loadLineContext } from "@/lib/services/records";
import { poHistoryForLine } from "@/lib/services/pos";
import { fmtUSD } from "@/lib/money";
import { addMonths, fmtDate, monthLabel, monthStart, todayCentral } from "@/lib/dates";
import { BILLING_METHOD_LABELS, RATE_BASIS_LABELS, lastBillableDay } from "@/lib/billing";
import { Flash, RentalBadge, StatusBadge, Empty } from "@/components/ui";
import { assignPoAction, changeLineStatusAction, generateInvoiceAction, removePoAction, updateTermsAction, uploadDocumentAction } from "../../../actions";

export default async function RentalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const ctx = await loadLineContext(id).catch(() => null);
  if (!ctx) notFound();
  const { line, contract, customer, profile, equipment, jobsite, fees } = ctx;
  const [history, invoices, docs] = await Promise.all([
    poHistoryForLine(id),
    q(`SELECT id, invoice_number, status, po_number, period_start, period_end, total, revision_no FROM invoices WHERE contract_line_id=$1 ORDER BY period_start DESC, id DESC`, [id]),
    q(`SELECT id, filename, mime_type, uploaded_at, is_original_agreement FROM contract_documents WHERE contract_id=$1 ORDER BY id`, [contract.id]),
  ]);
  const back = `/rentals/${id}`;
  const thisMonth = monthStart(todayCentral());
  const monthOptions = Array.from({ length: 8 }, (_, i) => addMonths(thisMonth, i - 3)).filter((m) => addMonths(m, 1) > line.billing_start_date);
  const last = lastBillableDay(ctx.window);
  const H = ({ children }: { children: React.ReactNode }) => <><input type="hidden" name="line_id" value={id} /><input type="hidden" name="back" value={back} />{children}</>;
  const MonthSelect = ({ name = "period" }: { name?: string }) => <select name={name} defaultValue={thisMonth}>{monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select>;

  return (
    <>
      <div className="topbar">
        <div><div className="muted small"><a href="/rentals">Rentals</a> / {contract.contract_number}</div>
          <h1><span className="mono">{equipment.unit_number}</span> · {contract.contract_number} <RentalBadge status={line.status} /></h1>
          <div className="muted">{customer.name} · {equipment.description} · on rent since {fmtDate(line.on_rent_date)}</div></div>
      </div>
      <Flash sp={sp} />
      <div className="grid g2">
        <div className="card">
          <h2>Rental agreement</h2>
          <dl className="kv">
            <dt>Customer</dt><dd><a href={`/customers/${customer.id}`}>{customer.name}</a> ({customer.customer_code})</dd>
            <dt>Agreement #</dt><dd>{contract.contract_number}</dd>
            <dt>Quipli reference</dt><dd>{contract.quipli_reference ?? "—"} <span className="small muted">(reference only; this app never changes Quipli)</span></dd>
            <dt>Equipment</dt><dd>{equipment.unit_number} · {equipment.description} · S/N {equipment.serial_number ?? "—"}</dd>
            <dt>Job / work order</dt><dd>{contract.job_number ?? "—"} / {contract.work_order_number ?? "—"}</dd>
            <dt>Jobsite</dt><dd style={{ whiteSpace: "pre-line" }}>{jobsite ? `${jobsite.name}\n${jobsite.address}` : "—"}</dd>
            <dt>Rate</dt><dd>{fmtUSD(line.rate_amount)} {RATE_BASIS_LABELS[ctx.rateBasis]}{line.taxable ? "" : " (non-taxable)"}</dd>
            <dt>Billing</dt><dd>{BILLING_METHOD_LABELS[ctx.method]}; billed here from {fmtDate(line.billing_start_date)}{last ? `; last billable day ${fmtDate(last)}` : ""}</dd>
            <dt>Delivery / pickup</dt><dd>{fmtUSD(line.delivery_charge)} / {fmtUSD(line.pickup_charge)}</dd>
            <dt>Other fees</dt><dd>{fees.length ? fees.map((f: any) => <div key={f.id}>{f.description}: {fmtUSD(f.amount)} ({f.frequency === "one_time" ? "one time" : "per period"})</div>) : "—"}</dd>
            <dt>Payment terms</dt><dd>{contract.payment_terms_days ? `Net ${contract.payment_terms_days}` : profile.payment_terms_label}</dd>
            <dt>Notes</dt><dd style={{ whiteSpace: "pre-line" }}>{contract.internal_notes ?? "—"}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Assign a monthly PO</h2>
          {can(user, "assign_po") ? (
            <form action={assignPoAction}><H>
              <div className="row">
                <div className="field"><label>Billing month</label><MonthSelect /></div>
                <div className="field"><label>PO number</label><input name="po_number" required placeholder={profile.po_pattern_description ?? ""} /></div>
                <div className="field"><label>PO total (estimate)</label><input name="estimated_total" inputMode="decimal" /></div>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <div className="field"><label>Job</label><input name="job_number" defaultValue={contract.job_number ?? ""} /></div>
                <div className="field"><label>Work order</label><input name="work_order_number" defaultValue={contract.work_order_number ?? ""} /></div>
                <div className="field"><label>PO expires</label><input type="date" name="expires_on" /></div>
              </div>
              {can(user, "correct_po") && <div className="row" style={{ marginTop: 8 }}>
                <label className="check"><input type="checkbox" name="replace" /> Replace the PO already assigned to this month</label>
                <div className="field"><input name="reason" placeholder="Reason (required when replacing)" /></div>
              </div>}
              <button className="btn-primary" style={{ marginTop: 8 }}>Assign PO</button>
            </H></form>) : <p className="muted">You have read-only access.</p>}
          <h2 style={{ marginTop: 18 }}>Generate an invoice</h2>
          {can(user, "generate_invoice") && <form action={generateInvoiceAction} className="row"><H><div className="field"><MonthSelect /></div><button>Generate draft</button></H></form>}
        </div>
      </div>

      <div className="card">
        <h2>PO history <span className="muted small">(every assignment is kept permanently)</span></h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Billing period</th><th>PO</th><th className="num">PO total</th><th>Job / WO</th><th>Status</th><th>Source</th><th>Assigned</th><th>Ended</th><th>Reason</th><th></th></tr></thead>
          <tbody>{history.map((h: any) => <tr key={h.id} style={{ opacity: h.status === "active" ? 1 : 0.65 }}>
            <td className="nowrap">{fmtDate(h.period_start)} – {fmtDate(h.period_end)}</td><td className="mono" style={{ fontWeight: 700 }}>{h.po_number}</td><td className="num">{fmtUSD(h.estimated_total)}</td>
            <td className="small">{h.job_number ?? "—"} / {h.work_order_number ?? "—"}</td>
            <td><span className={`badge ${h.status === "active" ? "b-ok" : ""}`}>{h.status}</span></td><td>{h.source}</td>
            <td className="small">{h.assigned_by_name}<br />{new Date(h.assigned_at).toLocaleString("en-US", { timeZone: "America/Chicago" })}</td>
            <td className="small">{h.ended_by_name ? <>{h.ended_by_name}<br />{new Date(h.ended_at).toLocaleString("en-US", { timeZone: "America/Chicago" })}</> : "—"}</td>
            <td className="small">{h.reason ?? ""}</td>
            <td>{h.status === "active" && can(user, "correct_po") && <details><summary className="small">Remove</summary><form action={removePoAction} className="row"><input type="hidden" name="assignment_id" value={h.id} /><input type="hidden" name="back" value={back} /><input name="reason" placeholder="Reason" required minLength={5} /><button className="btn-sm btn-danger">Remove</button></form></details>}</td>
          </tr>)}</tbody>
        </table>{!history.length && <Empty>No POs assigned yet.</Empty>}</div>
      </div>

      <div className="card">
        <h2>Invoices for this rental</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Invoice</th><th>Billing period</th><th>PO on invoice</th><th>Status</th><th className="num">Total</th><th></th></tr></thead>
          <tbody>{invoices.map((i: any) => <tr key={i.id}>
            <td><a href={`/invoices/${i.id}`}>{i.invoice_number ?? `Draft #${i.id}`}</a></td><td className="nowrap">{fmtDate(i.period_start)} – {fmtDate(i.period_end)}</td>
            <td className="mono" style={{ fontWeight: 700 }}>{i.po_number ?? "—"}</td><td><StatusBadge status={i.status} /></td><td className="num">{fmtUSD(i.total)}</td>
            <td><a href={`/api/invoices/${i.id}/pdf`} target="_blank" rel="noopener">PDF</a></td></tr>)}</tbody>
        </table>{!invoices.length && <Empty>No invoices yet.</Empty>}</div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h2>Documents</h2>
          {docs.length ? docs.map((d: any) => <div key={d.id}><a href={`/api/documents/${d.id}`}>{d.filename}</a> <span className="small muted">{d.is_original_agreement ? "original agreement · " : ""}{new Date(d.uploaded_at).toLocaleDateString("en-US")}</span></div>) : <p className="muted">No documents.{profile.require_contract_attachment && " This customer requires the original agreement on every invoice."}</p>}
          {can(user, "edit_records") && <form action={uploadDocumentAction} className="row" style={{ marginTop: 10 }}><input type="hidden" name="contract_id" value={contract.id} /><input type="hidden" name="back" value={back} /><div className="field"><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" required /></div><button>Upload agreement</button></form>}
        </div>
        <div className="card">
          <h2>Rental status</h2>
          <p className="small muted">Calling off or returning a unit sets its last billable day. It never touches finalized invoices.</p>
          {can(user, "edit_records") && <>
            <form action={changeLineStatusAction} className="row"><H>
              <div className="field"><label>Change to</label><select name="status">{line.status === "active" && <option value="off_rent">Off-rent (called off)</option>}{line.status !== "returned" && line.status !== "closed" && <option value="returned">Returned</option>}{line.status === "off_rent" && <option value="active">Active again (extension)</option>}{line.status === "returned" && <option value="closed">Closed</option>}</select></div>
              <div className="field"><label>Date</label><input type="date" name="date" /></div>
              <div className="field"><label>Note</label><input name="note" /></div>
              <button>Update</button></H></form>
            <details style={{ marginTop: 12 }}><summary>Change rate, job or work order going forward</summary>
              <form action={updateTermsAction} style={{ marginTop: 8 }}><H>
                <div className="row"><div className="field"><label>Rate</label><input name="rate_amount" defaultValue={line.rate_amount} /></div><div className="field"><label>Job</label><input name="job_number" defaultValue={contract.job_number ?? ""} /></div><div className="field"><label>Work order</label><input name="work_order_number" defaultValue={contract.work_order_number ?? ""} /></div></div>
                <div className="row" style={{ marginTop: 6 }}><div className="field"><input name="note" placeholder="Reason for change" required /></div><button>Save</button></div>
              </H></form></details>
          </>}
        </div>
      </div>
    </>
  );
}
