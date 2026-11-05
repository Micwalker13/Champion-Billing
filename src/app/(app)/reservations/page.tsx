import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { q } from "@/lib/db";
import { fmtUSD } from "@/lib/money";
import { fmtDate, todayCentral } from "@/lib/dates";
import { RATE_BASIS_LABELS } from "@/lib/billing";
import { Empty, Flash } from "@/components/ui";
import { RES_STATUS_LABELS, listReservations } from "@/lib/services/dispatch";
import { equipmentCategories, unitsForReservation } from "@/lib/services/availability";
import { assignReservationAction, cancelReservationAction, createReservationAction, sendOutReservationAction } from "../../actions";

export default async function Reservations({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const today = todayCentral();
  const [rows, customers, categories] = await Promise.all([
    listReservations({ status: sp.all ? undefined : "reserved" }),
    q(`SELECT id, name FROM customers WHERE active ORDER BY name`),
    equipmentCategories(),
  ]);
  const edit = can(user, "edit_records");
  const freeFor = await Promise.all(rows.map((r: any) => (r.status === "reserved" ? unitsForReservation(r) : Promise.resolve([]))));
  return (
    <>
      <div className="topbar"><div><h1>Reservations</h1><div className="muted">Hold a class of machine (or a specific unit) for a customer&rsquo;s dates. Pick the actual unit when it goes out. See <a href="/availability">Availability</a> for what&rsquo;s free each day.</div></div>
        <a className="btn" href={sp.all ? "/reservations" : "/reservations?all=1"}>{sp.all ? "Open only" : "Show all"}</a></div>
      <Flash sp={sp} />
      <div className="table-wrap"><table>
        <thead><tr><th>Starts</th><th>Customer</th><th>Equipment</th><th>Unit</th><th className="num">Rate</th><th>Status</th>{edit && <th>Send out</th>}</tr></thead>
        <tbody>{rows.map((r: any, i: number) => <tr key={r.id}>
          <td className="nowrap">{fmtDate(r.start_date)}{r.end_date && <div className="small muted">to {fmtDate(r.end_date)}</div>}{r.status === "reserved" && r.start_date < today && <span className="badge b-warn">Past start</span>}</td>
          <td>{r.customer_name}{r.quote_number && <div className="small"><a href={`/quotes/${r.quote_id}`}>{r.quote_number}</a></div>}</td>
          <td>{r.description}{r.category && <div className="small muted">{r.category}</div>}</td>
          <td className="mono">{r.unit_number ?? <span className="muted">pick at dispatch</span>}</td>
          <td className="num">{r.rate_amount ? `${fmtUSD(r.rate_amount)} ${RATE_BASIS_LABELS[r.rate_basis as keyof typeof RATE_BASIS_LABELS] ?? ""}` : "—"}</td>
          <td>{RES_STATUS_LABELS[r.status]}{r.contract_line_id && <> · <a href={`/rentals/${r.contract_line_id}`}>rental</a></>}{r.cancel_reason && <div className="small muted">{r.cancel_reason}</div>}</td>
          {edit && <td style={{ minWidth: 460 }}>{r.status === "reserved" && <>
            <form action={sendOutReservationAction}><input type="hidden" name="reservation_id" value={r.id} /><input type="hidden" name="back" value="/reservations" />
              <div className="row">
                <div className="field"><label>Unit</label><select name="unit_number" required defaultValue={r.unit_number ?? ""}>
                  {!r.unit_number && <option value="" disabled>Pick a free unit…</option>}
                  {r.unit_number && <option value={r.unit_number}>{r.unit_number} (held)</option>}
                  {freeFor[i].map((u: any) => <option key={u.id} value={u.unit_number}>{u.unit_number} · {u.description}{u.same_category ? "" : ` (${u.category ?? "no class"})`}{u.status === "in_shop" ? " · in shop" : ""}{u.yard_name ? ` · ${u.yard_name}` : ""}</option>)}
                </select></div>
                <div className="field"><label>Quipli agreement #</label><input name="contract_number" required style={{ width: 140 }} /></div>
                <div className="field"><label>On rent</label><input type="date" name="start_date" defaultValue={r.start_date} /></div>
              </div>
              <div className="row">
                <label className="check" style={{ whiteSpace: "nowrap" }}><input type="checkbox" name="schedule_delivery" defaultChecked /> Schedule delivery</label>
                <div className="field"><input type="date" name="delivery_date" defaultValue={r.start_date} aria-label="Delivery date" /></div>
                <div className="field"><input name="time_window" placeholder="Time window" style={{ width: 110 }} /></div>
                <div className="field"><input name="driver" placeholder="Driver" style={{ width: 110 }} /></div>
                <button className="btn-sm btn-primary">Send out</button>
              </div>
            </form>
            {!r.equipment_id && freeFor[i].length > 0 && <details><summary className="small">Hold a unit now</summary>
              <form action={assignReservationAction} className="row"><input type="hidden" name="reservation_id" value={r.id} /><input type="hidden" name="back" value="/reservations" />
                <div className="field"><select name="unit_number" required defaultValue=""><option value="" disabled>Pick…</option>{freeFor[i].map((u: any) => <option key={u.id} value={u.unit_number}>{u.unit_number} · {u.description}</option>)}</select></div>
                <button className="btn-sm">Hold</button></form></details>}
            <details><summary className="small">Cancel</summary>
              <form action={cancelReservationAction} className="row"><input type="hidden" name="reservation_id" value={r.id} /><input type="hidden" name="back" value="/reservations" />
                <div className="field"><input name="reason" required minLength={3} placeholder="Reason" /></div><button className="btn-sm btn-danger">Cancel reservation</button></form></details>
          </>}</td>}
        </tr>)}</tbody>
      </table>{!rows.length && <Empty>No open reservations.</Empty>}</div>
      {edit && (
        <form className="card" action={createReservationAction}>
          <h2>Reserve equipment</h2><input type="hidden" name="back" value="/reservations" />
          <p className="small muted">Pick a class to hold any free unit of that kind, or type a unit number to hold that exact machine. A class can&rsquo;t be reserved on a day when none are free.</p>
          <div className="row">
            <div className="field"><label>Customer</label><select name="customer_id" required defaultValue=""><option value="" disabled>Choose…</option>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div className="field"><label>Class</label><select name="category" defaultValue=""><option value="">(from the unit)</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            <div className="field"><label>Unit (optional)</label><input name="unit_number" style={{ width: 110 }} /></div>
            <div className="field" style={{ flexBasis: 200 }}><label>Description</label><input name="description" required placeholder="e.g. Mini excavator" /></div>
            <div className="field"><label>Start</label><input type="date" name="start_date" required /></div>
            <div className="field"><label>End</label><input type="date" name="end_date" /></div>
            <div className="field"><label>Rate</label><input name="rate_amount" inputMode="decimal" style={{ width: 100 }} /></div>
            <div className="field"><label>Per</label><select name="rate_basis" defaultValue="monthly">{Object.entries(RATE_BASIS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          </div>
          <div className="field"><label>Notes</label><input name="notes" /></div>
          {can(user, "override_validation") && <label className="check"><input type="checkbox" name="overbook" /> Reserve anyway if none are free (wait list)</label>}
          <button className="btn-primary" style={{ marginTop: 8 }}>Reserve</button>
        </form>)}
    </>
  );
}
