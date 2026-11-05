import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { q } from "@/lib/db";
import { addDays, fmtDate, todayCentral } from "@/lib/dates";
import { Empty, Flash } from "@/components/ui";
import { listTickets } from "@/lib/services/dispatch";
import { scheduleTicketAction } from "../../actions";

export default async function Dispatch({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const today = todayCentral();
  const [scheduled, recent, lines] = await Promise.all([
    listTickets({ status: "scheduled" }),
    listTickets({ status: "completed", from: addDays(today, -30) }),
    q(`SELECT l.id, c.contract_number, e.unit_number, cu.name AS customer_name, l.status FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id
       JOIN equipment e ON e.id=l.equipment_id JOIN customers cu ON cu.id=c.customer_id WHERE l.status IN ('active','off_rent') ORDER BY e.unit_number`),
  ]);
  return (
    <>
      <div className="topbar"><div><h1>Dispatch</h1><div className="muted">Deliveries and pickups. The driver opens the ticket on a phone or tablet at the jobsite, records the hour meter and fuel, and has the customer sign.</div></div></div>
      <Flash sp={sp} />
      <div className="card">
        <h2>Scheduled</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Ticket</th><th>Unit</th><th>Customer</th><th>Jobsite</th><th>Driver / truck</th></tr></thead>
          <tbody>{scheduled.map((t: any) => <tr key={t.id}>
            <td className="nowrap">{fmtDate(t.scheduled_date)}{t.scheduled_date < today && <span className="badge b-bad" style={{ marginLeft: 6 }}>Late</span>}{t.time_window && <div className="small muted">{t.time_window}</div>}</td>
            <td><a href={`/dispatch/${t.id}`}>{t.ticket_number}</a> <span className={`badge ${t.kind === "delivery" ? "b-accent" : "b-info"}`}>{t.kind === "delivery" ? "Delivery" : "Pickup"}</span></td>
            <td className="mono">{t.unit_number}</td><td>{t.customer_name}<div className="small muted"><a href={`/rentals/${t.contract_line_id}`}>{t.contract_number}</a></div></td>
            <td className="small" style={{ whiteSpace: "pre-line" }}>{t.site_address ?? "—"}</td><td>{[t.driver, t.truck].filter(Boolean).join(" / ") || "—"}</td></tr>)}</tbody>
        </table>{!scheduled.length && <Empty>Nothing scheduled.</Empty>}</div>
      </div>
      {can(user, "edit_records") && (
        <form className="card" action={scheduleTicketAction}>
          <h2>Schedule a delivery or pickup</h2><input type="hidden" name="back" value="/dispatch" />
          <div className="row">
            <div className="field" style={{ flexBasis: 280 }}><label>Rental</label><select name="line_id" required defaultValue=""><option value="" disabled>Choose…</option>{lines.map((l: any) => <option key={l.id} value={l.id}>{l.unit_number} · {l.customer_name} · {l.contract_number}{l.status === "off_rent" ? " (called off)" : ""}</option>)}</select></div>
            <div className="field"><label>Type</label><select name="kind" defaultValue="delivery"><option value="delivery">Delivery</option><option value="pickup">Pickup</option></select></div>
            <div className="field"><label>Date</label><input type="date" name="scheduled_date" defaultValue={today} required /></div>
            <div className="field"><label>Time</label><input name="time_window" placeholder="7–9 am" /></div>
            <div className="field"><label>Driver</label><input name="driver" /></div>
            <div className="field"><label>Truck</label><input name="truck" /></div>
            <div className="field"><label>Site contact</label><input name="site_contact" placeholder="Name and phone" /></div>
          </div>
          <div className="field" style={{ marginTop: 6 }}><label>Instructions</label><textarea name="instructions" rows={2} placeholder="Gate code, where to drop, etc." /></div>
          <button className="btn-primary" style={{ marginTop: 8 }}>Schedule</button>
        </form>)}
      <div className="card">
        <h2>Signed in the last 30 days</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Ticket</th><th>Unit</th><th>Customer</th><th>Signed by</th><th>When</th><th className="num">Hours</th><th>Fuel</th><th /></tr></thead>
          <tbody>{recent.map((t: any) => <tr key={t.id}><td><a href={`/dispatch/${t.id}`}>{t.ticket_number}</a></td><td className="mono">{t.unit_number}</td><td>{t.customer_name}</td><td>{t.signed_by}</td>
            <td className="small">{new Date(t.completed_at).toLocaleString("en-US", { timeZone: "America/Chicago" })}</td><td className="num">{t.hours ?? "—"}</td><td>{t.fuel_level ?? "—"}</td>
            <td><a href={`/api/tickets/${t.id}/pdf`} target="_blank" rel="noopener">PDF</a></td></tr>)}</tbody>
        </table>{!recent.length && <Empty>No signed tickets yet.</Empty>}</div>
      </div>
    </>
  );
}
