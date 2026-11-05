import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { q } from "@/lib/db";
import { fmtUSD } from "@/lib/money";
import { fmtDate, todayCentral } from "@/lib/dates";
import { DueBadge, Empty, Flash, Kpi, UnitStatus, WoStatus } from "@/components/ui";
import { WO_KIND_LABELS, listWorkOrders, serviceDue } from "@/lib/services/shop";
import { createWorkOrderAction } from "../../actions";

export default async function Shop({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const view = sp.view === "closed" ? "closed" : sp.view === "all" ? "all" : "open";
  const [wos, openWos, due, units] = await Promise.all([
    listWorkOrders({ status: view, unit: sp.unit }),
    listWorkOrders({ status: "open" }),
    serviceDue({ onlyDue: true }),
    q(`SELECT unit_number, description FROM equipment WHERE status NOT IN ('sold','retired') ORDER BY unit_number`),
  ]);
  const overdue = due.filter((d: any) => d.status === "overdue").length;
  return (
    <>
      <div className="topbar"><div><h1>Shop</h1><div className="muted">Work orders for repairs and service, and which units are due for service by hour meter or date.</div></div></div>
      <Flash sp={sp} />
      <div className="grid g4">
        <Kpi label="Open work orders" value={openWos.length} />
        <Kpi label="Waiting on parts" value={openWos.filter((w: any) => w.status === "waiting_parts").length} tone={openWos.some((w: any) => w.status === "waiting_parts") ? "warn" : undefined} />
        <Kpi label="Service overdue" value={overdue} tone={overdue ? "bad" : "ok"} />
        <Kpi label="Service due soon" value={due.length - overdue} tone={due.length - overdue ? "warn" : undefined} />
      </div>

      <div className="card">
        <h2>Service due</h2>
        <p className="small muted">Set up service schedules (for example every 250 hours, or yearly) on each unit&rsquo;s page. Hours come from the unit&rsquo;s hour meter, which updates from invoices, exchanges and work orders.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Unit</th><th>Service</th><th>Status</th><th className="num">Hour meter</th><th className="num">Due at</th><th>Due date</th><th>Where</th><th /></tr></thead>
          <tbody>{due.map((d: any) => <tr key={d.id}>
            <td><a href={`/equipment/${d.equipment_id}`} className="mono">{d.unit_number}</a><div className="small muted">{d.description}</div></td>
            <td>{d.name}</td><td><DueBadge status={d.status} /></td>
            <td className="num">{d.hour_meter ?? "—"}</td>
            <td className="num">{d.due_at_hours ?? "—"}{d.hours_left != null && <div className="small muted">{Number(d.hours_left) < 0 ? `${Math.abs(Number(d.hours_left))} hrs over` : `${d.hours_left} hrs left`}</div>}</td>
            <td>{d.due_on ? fmtDate(d.due_on) : "—"}{d.days_left != null && <div className="small muted">{d.days_left < 0 ? `${-d.days_left} days late` : `${d.days_left} days`}</div>}</td>
            <td className="small">{d.on_rent ? <>On rent: <a href={`/rentals/${d.on_rent.id}`}>{d.on_rent.customer_name}</a></> : <UnitStatus status={d.unit_status} />}</td>
            <td>{d.open_wo ? <a href={`/shop/${d.open_wo_id}`}>{d.open_wo}</a> : can(user, "edit_records") &&
              <form action={createWorkOrderAction} className="inline"><input type="hidden" name="back" value="/shop" /><input type="hidden" name="unit_number" value={d.unit_number} />
                <input type="hidden" name="kind" value="service" /><input type="hidden" name="complaint" value={d.name} /><input type="hidden" name="service_interval_id" value={d.id} />
                <input type="hidden" name="hours_in" value={d.hour_meter ?? ""} /><input type="hidden" name="put_in_shop" value={d.on_rent ? "" : "on"} />
                <button className="btn-sm">Open work order</button></form>}</td>
          </tr>)}</tbody>
        </table>{!due.length && <Empty>Nothing due in the next two weeks or within 10% of its hours.</Empty>}</div>
      </div>

      <div className="card">
        <h2>Work orders</h2>
        <form className="row" method="get">
          <div className="field"><label>Show</label><select name="view" defaultValue={view}><option value="open">Open</option><option value="closed">Completed and cancelled</option><option value="all">All</option></select></div>
          <div className="field"><label>Unit</label><input name="unit" defaultValue={sp.unit ?? ""} placeholder="Any" /></div>
          <button>Filter</button>
        </form>
        <div className="table-wrap" style={{ marginTop: 8 }}><table>
          <thead><tr><th>Work order</th><th>Unit</th><th>Type</th><th>Problem</th><th>Opened</th><th>Status</th><th>Assigned</th><th className="num">Cost</th></tr></thead>
          <tbody>{wos.map((w: any) => <tr key={w.id}>
            <td><a href={`/shop/${w.id}`}>{w.wo_number}</a></td><td><span className="mono">{w.unit_number}</span><div className="small muted">{w.unit_description}</div></td>
            <td>{WO_KIND_LABELS[w.kind]}</td><td className="small">{w.complaint}</td><td>{fmtDate(w.opened_on)}</td><td><WoStatus status={w.status} /></td>
            <td>{w.assigned_to ?? "—"}</td><td className="num">{fmtUSD(w.total)}</td></tr>)}</tbody>
        </table>{!wos.length && <Empty>No work orders here.</Empty>}</div>
      </div>

      {can(user, "edit_records") && (
        <form className="card" action={createWorkOrderAction}>
          <h2>Open a work order</h2><input type="hidden" name="back" value="/shop" />
          <div className="row">
            <div className="field"><label>Unit</label><select name="unit_number" required defaultValue=""><option value="" disabled>Choose…</option>{units.map((u: any) => <option key={u.unit_number} value={u.unit_number}>{u.unit_number} · {u.description}</option>)}</select></div>
            <div className="field"><label>Type</label><select name="kind" defaultValue="repair">{Object.entries(WO_KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="field"><label>Opened</label><input type="date" name="opened_on" defaultValue={todayCentral()} /></div>
            <div className="field"><label>Hour meter</label><input name="hours_in" inputMode="decimal" /></div>
            <div className="field"><label>Assigned to</label><input name="assigned_to" placeholder="Mechanic" /></div>
          </div>
          <div className="field" style={{ marginTop: 6 }}><label>Problem or work to do</label><textarea name="complaint" rows={2} required minLength={3} /></div>
          <label className="check"><input type="checkbox" name="put_in_shop" defaultChecked /> Mark the unit &ldquo;In shop&rdquo; (only if it&rsquo;s in the yard, not on rent)</label>
          <button className="btn-primary" style={{ marginTop: 8 }}>Open work order</button>
        </form>)}
    </>
  );
}
