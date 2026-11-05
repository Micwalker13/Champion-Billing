import { FileInput } from "@/components/file-input";
import { maxUploadMb } from "@/lib/limits";
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
import { scheduleTicketAction, damageWaiverAction, assignPoAction, changeLineStatusAction, exchangeUnitAction, generateInvoiceAction, removePoAction, updateTermsAction, uploadDocumentAction } from "../../../actions";
import { availableUnits, exchangesForLine, listYards } from "@/lib/services/inventory";
import { TICKET_STATUS_LABELS, listTickets } from "@/lib/services/dispatch";
import { FEE_CATEGORY_LABELS, applicableFees, isExempt, pctLabel, rateOn } from "@/lib/fees";
import { feeOverrideAction, removeFeeOverrideAction } from "../../../actions";

export default async function RentalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const ctx = await loadLineContext(id).catch(() => null);
  if (!ctx) notFound();
  const { line, contract, customer, profile, equipment, jobsite, fees } = ctx;
  const tickets = await listTickets({ lineId: id });
  const [history, invoices, docs, exchanges, spares, yards] = await Promise.all([
    poHistoryForLine(id),
    q(`SELECT id, invoice_number, status, po_number, period_start, period_end, total, revision_no FROM invoices WHERE contract_line_id=$1 ORDER BY period_start DESC, id DESC`, [id]),
    q(`SELECT id, filename, mime_type, uploaded_at, is_original_agreement FROM contract_documents WHERE contract_id=$1 ORDER BY id`, [contract.id]),
    exchangesForLine(id), availableUnits(), listYards(),
  ]);
  const back = `/rentals/${id}`;
  const thisMonth = monthStart(todayCentral());
  const monthOptions = Array.from({ length: 8 }, (_, i) => addMonths(thisMonth, i - 3)).filter((m) => addMonths(m, 1) > line.billing_start_date);
  const last = lastBillableDay(ctx.window);
  const fs = ctx.feeSetup!;
  const today = todayCentral();
  const unitFees = applicableFees(fs.config.types, "rental", equipment, fs.config.assignments, fs.unitSettings[String(equipment.id)] ?? []);
  const canOverride = can(user, "override_fees");
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
            <dt>Equipment</dt><dd><a href={`/equipment/${equipment.id}`}>{equipment.unit_number}</a> · {equipment.description} · S/N {equipment.serial_number ?? "—"}{exchanges.length > 0 && <div className="small muted">Exchanged {exchanges.length}×; first unit was {exchanges.at(-1).out_unit}</div>}</dd>
            <dt>Job / work order</dt><dd>{contract.job_number ?? "—"} / {contract.work_order_number ?? "—"}</dd>
            <dt>Jobsite</dt><dd style={{ whiteSpace: "pre-line" }}>{jobsite ? `${jobsite.name}\n${jobsite.address}` : "—"}</dd>
            <dt>Rate</dt><dd>{fmtUSD(line.rate_amount)} {RATE_BASIS_LABELS[ctx.rateBasis]}{line.taxable ? "" : " (non-taxable)"}</dd>
            <dt>Billing</dt><dd>{BILLING_METHOD_LABELS[ctx.method]}; billed here from {fmtDate(line.billing_start_date)}{last ? `; last billable day ${fmtDate(last)}` : ""}</dd>
            <dt>Delivery / pickup</dt><dd>{fmtUSD(line.delivery_charge)} / {fmtUSD(line.pickup_charge)}</dd>
            <dt>Other fees</dt><dd>{fees.length ? fees.map((f: any) => <div key={f.id}>{f.description}: {fmtUSD(f.amount)} ({f.frequency === "one_time" ? "one time" : "per period"})</div>) : "—"}</dd>
            {profile.damage_waiver_pct && <><dt>Damage waiver</dt><dd>
              {line.damage_waiver_waived ? "Waived on this rental" : `${(Number(profile.damage_waiver_pct) * 100).toString()}% of rental each period${profile.rdw_choice === "coi" ? ", skipped for periods the customer's insurance certificate covers" : ""}`}
              {can(user, "edit_records") && (line.damage_waiver_waived
                ? <form action={damageWaiverAction} className="inline" style={{ marginLeft: 8 }}><H><input type="hidden" name="waived" value="false" /><button className="btn-sm">Charge it again</button></H></form>
                : <details><summary className="small">Waive for this rental</summary><form action={damageWaiverAction} className="row"><H><input type="hidden" name="waived" value="true" />
                    <div className="field"><input name="reason" required minLength={5} placeholder="e.g. Customer's insurance certificate on file" /></div><button className="btn-sm">Waive</button></H></form></details>)}
            </dd></>}
            <dt>Payment terms</dt><dd>{contract.payment_terms_days ? `Net ${contract.payment_terms_days}` : profile.payment_terms_label}</dd>
            <dt>Notes</dt><dd style={{ whiteSpace: "pre-line" }}>{contract.internal_notes ?? "—"}</dd>
          </dl>
        </div>
        <div className="card" id="fees">
          <h2>Fees &amp; taxes on this rental</h2>
          {unitFees.length === 0 ? <p className="muted small">No equipment fees or taxes apply to unit {equipment.unit_number}. They are set on the <a href={`/equipment/${equipment.id}#fees`}>equipment page</a>.</p> :
          <table className="small"><thead><tr><th>Fee</th><th>Rate</th><th></th></tr></thead><tbody>
            {unitFees.map((f) => {
              const r = rateOn(fs.config.rates, f.id, today);
              const ov = (fs.overrides as any[]).find((o) => String(o.fee_type_id) === String(f.id));
              const exempt = isExempt(fs.exemptions, f.id, today);
              return <tr key={f.id}>
                <td><span className="mono">{f.code}</span> {f.name}<div className="muted">{FEE_CATEGORY_LABELS[f.category]}{f.frequency === "one_time" ? ", first invoice only" : ", every billing cycle"}</div></td>
                <td>{exempt ? <span className="badge">Customer exempt</span>
                  : ov ? <><span className="badge b-accent">{ov.waived ? "Waived" : ov.percent ? pctLabel(ov.percent) : fmtUSD(ov.amount)}</span><div className="muted">Override: {ov.reason}</div></>
                  : r ? (r.percent ? `${pctLabel(r.percent)} of rental` : fmtUSD(r.amount)) : <span className="badge b-warn">No rate</span>}</td>
                <td>{canOverride && f.allow_override && (ov
                  ? <form action={removeFeeOverrideAction} className="inline"><input type="hidden" name="override_id" value={ov.id} /><input type="hidden" name="back" value={`${back}#fees`} /><button className="btn-sm">Use standard rate</button></form>
                  : <details><summary className="small">Override</summary><form action={feeOverrideAction}><input type="hidden" name="line_id" value={id} /><input type="hidden" name="fee_type_id" value={f.id} /><input type="hidden" name="back" value={`${back}#fees`} />
                      <div className="row"><select name="mode" defaultValue="rate"><option value="rate">Different {f.calc_type === "percent" ? "percent" : "amount"}</option><option value="waive">Waive it</option></select>
                        <input name="value" inputMode="decimal" placeholder={f.calc_type === "percent" ? "%" : "$"} style={{ width: 80 }} /></div>
                      <input name="reason" required minLength={5} placeholder="Reason" /> <button className="btn-sm">Save</button></form></details>)}</td>
              </tr>;
            })}
          </tbody></table>}
          <p className="small muted">Each fee is its own line on every invoice, worked out for that billing cycle.</p>
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
          {docs.length ? docs.map((d: any) => <div key={d.id}><a href={`/api/documents/${d.id}`}>{d.filename}</a> <span className="small muted">{d.is_original_agreement ? "original agreement · " : ""}{new Date(d.uploaded_at).toLocaleDateString("en-US", { timeZone: "America/Chicago" })}</span></div>) : <p className="muted">No documents.{profile.require_contract_attachment && " This customer requires the original agreement on every invoice."}</p>}
          {can(user, "edit_records") && <form action={uploadDocumentAction} className="row" style={{ marginTop: 10 }}><input type="hidden" name="contract_id" value={contract.id} /><input type="hidden" name="back" value={back} /><div className="field"><FileInput name="file" accept=".pdf,.png,.jpg,.jpeg" maxMb={maxUploadMb()} required /></div><button>Upload agreement</button></form>}
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

      <div className="card">
        <h2>Delivery and pickup</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Ticket</th><th>Date</th><th>Status</th><th>Signed by</th><th className="num">Hours</th><th /></tr></thead>
          <tbody>{tickets.map((t: any) => <tr key={t.id}><td><a href={`/dispatch/${t.id}`}>{t.ticket_number}</a> {t.kind === "delivery" ? "Delivery" : "Pickup"}</td><td>{fmtDate(t.scheduled_date)}</td>
            <td>{TICKET_STATUS_LABELS[t.status]}</td><td>{t.signed_by ?? "—"}</td><td className="num">{t.hours ?? "—"}</td>
            <td>{t.status === "completed" && <a href={`/api/tickets/${t.id}/pdf`} target="_blank" rel="noopener">PDF</a>}</td></tr>)}</tbody>
        </table>{!tickets.length && <Empty>No delivery or pickup tickets.</Empty>}</div>
        {can(user, "edit_records") && ["active", "off_rent"].includes(line.status) && (
          <details style={{ marginTop: 10 }}><summary>Schedule {line.status === "off_rent" ? "the pickup" : "a delivery or pickup"}</summary>
            <form action={scheduleTicketAction} className="row" style={{ marginTop: 6 }}><H>
              <div className="field"><label>Type</label><select name="kind" defaultValue={line.status === "off_rent" ? "pickup" : "delivery"}><option value="delivery">Delivery</option><option value="pickup">Pickup</option></select></div>
              <div className="field"><label>Date</label><input type="date" name="scheduled_date" required defaultValue={line.status === "off_rent" ? line.off_rent_date : line.on_rent_date} /></div>
              <div className="field"><label>Time</label><input name="time_window" /></div>
              <div className="field"><label>Driver</label><input name="driver" /></div>
              <div className="field"><label>Site contact</label><input name="site_contact" /></div>
              <div className="field" style={{ flexBasis: 240 }}><label>Instructions</label><input name="instructions" /></div>
              <button>Schedule</button>
            </H></form></details>)}
      </div>

      <div className="card">
        <h2>Exchange this machine</h2>
        <p className="small muted">Use this when a unit breaks down or the customer needs a different one of the same kind. The rental keeps going: same agreement, same rate, same monthly PO, so the bill does not change and no partial month is created. The old unit goes back to a yard or the shop. If the replacement needs a different rate, call this rental off and start a new one instead.</p>
        {exchanges.length > 0 && <div className="table-wrap" style={{ marginBottom: 12 }}><table>
          <thead><tr><th>Date</th><th>Out</th><th>In</th><th>Reason</th><th>Old unit went to</th><th className="num">Freight</th><th>By</th></tr></thead>
          <tbody>{exchanges.map((x: any) => <tr key={x.id}><td className="nowrap">{fmtDate(x.exchange_date)}</td><td className="mono">{x.out_unit}{x.out_hours != null && <div className="small muted">{x.out_hours} h</div>}</td><td className="mono">{x.in_unit}{x.in_hours != null && <div className="small muted">{x.in_hours} h</div>}</td>
            <td className="small">{x.reason}</td><td>{x.out_status === "in_shop" ? "Shop" : "Available"}{x.out_yard ? `, ${x.out_yard}` : ""}</td><td className="num">{x.freight ? fmtUSD(x.freight) : "—"}</td><td className="small">{x.user_name}</td></tr>)}</tbody>
        </table></div>}
        {can(user, "edit_records") && line.status === "active" ? (
          <form action={exchangeUnitAction}><H>
            <div className="row">
              <div className="field"><label>Replacement unit #</label><input name="in_unit" list="spare-units" required placeholder={spares.length ? `${spares.length} available` : "No units available"} /></div>
              <div className="field"><label>Exchange date</label><input type="date" name="exchange_date" required defaultValue={todayCentral()} /></div>
              <div className="field" style={{ flexBasis: 240 }}><label>Reason</label><input name="reason" required placeholder="e.g. hydraulic leak, swapped for same size" /></div>
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <div className="field"><label>{equipment.unit_number} goes to</label><select name="out_status" defaultValue="in_shop"><option value="in_shop">Shop (needs repair)</option><option value="available">Yard (ready to rent)</option></select></div>
              <div className="field"><label>Yard</label><select name="out_yard_id" defaultValue={equipment.yard_id ?? ""}><option value="">—</option>{yards.map((y: any) => <option key={y.id} value={y.id}>{y.name}</option>)}</select></div>
              <div className="field"><label>{equipment.unit_number} hours</label><input name="out_hours" inputMode="decimal" /></div>
              <div className="field"><label>Replacement hours</label><input name="in_hours" inputMode="decimal" /></div>
              <div className="field"><label>Exchange freight to bill</label><input name="freight_amount" inputMode="decimal" placeholder="0.00 (none)" /></div>
            </div>
            <datalist id="spare-units">{spares.map((u: any) => <option key={u.unit_number} value={u.unit_number}>{u.description}{u.yard_name ? ` (${u.yard_name})` : ""}</option>)}</datalist>
            <button className="btn-primary" style={{ marginTop: 8 }}>Exchange unit</button>
          </H></form>) : <p className="muted small">{line.status === "active" ? "You have read-only access." : "Only an active rental can have its unit exchanged."}</p>}
      </div>
    </>
  );
}
