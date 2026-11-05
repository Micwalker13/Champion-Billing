import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { one } from "@/lib/db";
import { fmtDate } from "@/lib/dates";
import { Flash } from "@/components/ui";
import { SignaturePad } from "@/components/signature-pad";
import { TICKET_STATUS_LABELS } from "@/lib/services/dispatch";
import { cancelTicketAction, completeTicketAction } from "../../../actions";

export default async function TicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const t = await one(`SELECT t.id, t.ticket_number, t.kind, t.status, t.scheduled_date, t.time_window, t.driver, t.truck, t.site_address, t.site_contact, t.instructions,
                         t.hours, t.fuel_level, t.condition_notes, t.signed_by, t.completed_at, t.cancel_reason, t.contract_line_id,
                         e.unit_number, e.description, e.serial_number, e.hour_meter, c.contract_number, cu.name AS customer_name
                       FROM delivery_tickets t JOIN equipment e ON e.id=t.equipment_id JOIN rental_contract_lines l ON l.id=t.contract_line_id
                       JOIN rental_contracts c ON c.id=l.contract_id JOIN customers cu ON cu.id=c.customer_id WHERE t.id=$1`, [id]);
  if (!t) notFound();
  const back = `/dispatch/${id}`;
  const label = t.kind === "delivery" ? "Delivery" : "Pickup";
  return (
    <>
      <div className="topbar"><div>
        <div className="muted small"><a href="/dispatch">Dispatch</a></div>
        <h1>{label} {t.ticket_number} <span className={`badge ${t.status === "completed" ? "b-ok" : t.status === "cancelled" ? "" : "b-info"}`}>{TICKET_STATUS_LABELS[t.status]}</span></h1>
        <div className="muted">{fmtDate(t.scheduled_date)}{t.time_window ? ` · ${t.time_window}` : ""} · {t.customer_name} · <a href={`/rentals/${t.contract_line_id}`}>{t.contract_number}</a></div>
      </div>{t.status === "completed" && <a className="btn btn-primary" href={`/api/tickets/${id}/pdf`} target="_blank" rel="noopener">Signed PDF</a>}</div>
      <Flash sp={sp} />
      <div className="card">
        <dl className="kv">
          <dt>Unit</dt><dd><b className="mono">{t.unit_number}</b> {t.description}{t.serial_number ? ` · S/N ${t.serial_number}` : ""}</dd>
          <dt>Jobsite</dt><dd style={{ whiteSpace: "pre-line" }}>{t.site_address ?? "—"}</dd>
          <dt>Site contact</dt><dd>{t.site_contact ?? "—"}</dd>
          <dt>Driver / truck</dt><dd>{[t.driver, t.truck].filter(Boolean).join(" / ") || "—"}</dd>
          <dt>Instructions</dt><dd style={{ whiteSpace: "pre-line" }}>{t.instructions ?? "—"}</dd>
          {t.status === "completed" && <><dt>Hour meter</dt><dd>{t.hours ?? "—"}</dd><dt>Fuel</dt><dd>{t.fuel_level ?? "—"}</dd><dt>Condition</dt><dd>{t.condition_notes ?? "No damage noted"}</dd>
            <dt>Signed by</dt><dd>{t.signed_by}, {new Date(t.completed_at).toLocaleString("en-US", { timeZone: "America/Chicago" })}</dd></>}
          {t.status === "cancelled" && <><dt>Cancelled</dt><dd>{t.cancel_reason}</dd></>}
        </dl>
      </div>
      {t.status === "scheduled" && can(user, "edit_records") && (
        <form className="card" action={completeTicketAction}>
          <h2>At the jobsite</h2>
          <input type="hidden" name="ticket_id" value={id} /><input type="hidden" name="back" value={back} />
          <div className="row">
            <div className="field"><label>Hour meter</label><input name="hours" inputMode="decimal" defaultValue={t.hour_meter ?? ""} /></div>
            <div className="field"><label>Fuel level</label><select name="fuel_level" defaultValue=""><option value="">—</option>{["empty", "1/4", "1/2", "3/4", "full"].map((f) => <option key={f} value={f}>{f}</option>)}</select></div>
          </div>
          <div className="field"><label>Condition and damage</label><textarea name="condition_notes" rows={2} placeholder="Leave blank if no damage" /></div>
          <p className="small muted" style={{ marginTop: 8 }}>{t.kind === "delivery" ? "Customer signs to confirm they received the unit in good working order, with the hour meter and fuel shown, unless noted above." : "Customer signs to release the unit for return, with the hour meter, fuel and condition shown."}</p>
          <div className="field"><label>Name of person signing</label><input name="signed_by" required minLength={2} autoComplete="off" /></div>
          <SignaturePad />
          <button className="btn-primary" style={{ marginTop: 10 }}>Save signed ticket</button>
        </form>)}
      {t.status === "scheduled" && can(user, "edit_records") && (
        <details className="card"><summary>Cancel this ticket</summary>
          <form action={cancelTicketAction} className="row" style={{ marginTop: 6 }}><input type="hidden" name="ticket_id" value={id} /><input type="hidden" name="back" value={back} />
            <div className="field"><input name="reason" required minLength={3} placeholder="Reason" /></div><button className="btn-danger">Cancel ticket</button></form>
        </details>)}
    </>
  );
}
