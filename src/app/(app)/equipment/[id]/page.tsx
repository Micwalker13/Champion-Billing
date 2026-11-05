import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { q } from "@/lib/db";
import { fmtUSD } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { RATE_BASIS_LABELS } from "@/lib/billing";
import { DueBadge, Flash, RentalBadge, StatusBadge, UnitStatus, WoStatus, Empty } from "@/components/ui";
import { WO_KIND_LABELS, listWorkOrders, serviceDue } from "@/lib/services/shop";
import { EVENT_LABELS, UNIT_STATUS_LABELS, listYards, unitDetail } from "@/lib/services/inventory";
import { createIntervalAction, createSaleAction, createWorkOrderAction, intervalActiveAction, updateUnitAction } from "../../../actions";

export default async function UnitPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const d = await unitDetail(id);
  if (!d) notFound();
  const { unit, open, events, rentals, sale } = d;
  const [yards, customers, services, wos] = await Promise.all([listYards(), q(`SELECT id, name FROM customers WHERE active ORDER BY name`), serviceDue({ equipmentId: id }), listWorkOrders({ status: "all", unit: unit.unit_number })]);
  const myWos = wos.filter((w: any) => String(w.equipment_id) === String(id));
  const where = open ? "on_rent" : unit.status;
  const back = `/equipment/${id}`;
  const canSell = can(user, "edit_records") && !open && !sale && unit.status !== "sold";
  return (
    <>
      <div className="topbar">
        <div><div className="muted small"><a href="/equipment">Equipment</a></div>
          <h1><span className="mono">{unit.unit_number}</span> · {unit.description} <UnitStatus status={where} /></h1>
          <div className="muted">{[unit.year, unit.make, unit.model].filter(Boolean).join(" ") || "Make and model not set"}{unit.serial_number ? ` · S/N ${unit.serial_number}` : ""}</div></div>
      </div>
      <Flash sp={sp} />
      <div className="grid g2">
        <div className="card">
          <h2>Where it is now</h2>
          {open ? <p>On rent to <b>{open.customer_name}</b> on <a href={`/rentals/${open.id}`}>{open.contract_number}</a>. To swap it for another machine, use <b>Exchange this machine</b> on that rental.</p>
            : sale ? <p>On sale <a href={`/sales/${sale.id}`}>{sale.sale_number ?? `draft #${sale.id}`}</a> to {sale.customer_name} ({fmtUSD(sale.total)}) <StatusBadge status={sale.status} /></p>
            : <p>{UNIT_STATUS_LABELS[unit.status]}{unit.yard_name ? ` at ${unit.yard_name}` : ""}.</p>}
          <dl className="kv">
            <dt>Category</dt><dd>{unit.category ?? "—"}</dd>
            <dt>Yard</dt><dd>{unit.yard_name ?? "—"}</dd>
            <dt>Hour meter</dt><dd>{unit.hour_meter ?? "—"}</dd>
            <dt>Asking price</dt><dd>{unit.asking_price ? fmtUSD(unit.asking_price) : "—"}</dd>
            <dt>Notes</dt><dd style={{ whiteSpace: "pre-line" }}>{unit.notes ?? "—"}</dd>
          </dl>
        </div>
        {can(user, "edit_records") && unit.status !== "sold" && (
          <form className="card" action={updateUnitAction}>
            <h2>Edit unit</h2>
            <input type="hidden" name="equipment_id" value={id} /><input type="hidden" name="back" value={back} />
            <div className="row">
              <div className="field" style={{ flexBasis: 220 }}><label>Description</label><input name="description" defaultValue={unit.description} required /></div>
              <div className="field"><label>Category</label><input name="category" defaultValue={unit.category ?? ""} /></div>
              <div className="field"><label>Serial #</label><input name="serial_number" defaultValue={unit.serial_number ?? ""} /></div>
              <div className="field"><label>Make</label><input name="make" defaultValue={unit.make ?? ""} /></div>
              <div className="field"><label>Model</label><input name="model" defaultValue={unit.model ?? ""} /></div>
              <div className="field"><label>Year</label><input name="year" defaultValue={unit.year ?? ""} inputMode="numeric" /></div>
              <div className="field"><label>Yard</label><select name="yard_id" defaultValue={unit.yard_id ?? ""}><option value="">—</option>{yards.map((y: any) => <option key={y.id} value={y.id}>{y.name}</option>)}</select></div>
              <div className="field"><label>Status</label>
                <select name="status" defaultValue={unit.status} disabled={!!open}>{["available", "in_shop", "retired"].map((s) => <option key={s} value={s}>{UNIT_STATUS_LABELS[s]}</option>)}</select>
                {open && <input type="hidden" name="status" value={unit.status} />}</div>
              <div className="field"><label>Hour meter</label><input name="hour_meter" defaultValue={unit.hour_meter ?? ""} inputMode="decimal" /></div>
              <div className="field"><label>Asking price</label><input name="asking_price" defaultValue={unit.asking_price ?? ""} inputMode="decimal" /></div>
            </div>
            <div className="field" style={{ marginTop: 6 }}><label>Notes</label><textarea name="notes" defaultValue={unit.notes ?? ""} rows={2} /></div>
            <div className="row" style={{ marginTop: 6 }}><div className="field" style={{ flexBasis: 260 }}><input name="note" placeholder="Why (kept in the unit's history)" /></div><button className="btn-primary">Save</button></div>
          </form>)}
      </div>

      {canSell && (
        <details className="card">
          <summary><b>Sell this unit</b> <span className="muted small">(creates a draft; nothing changes until a manager finalizes it)</span></summary>
          <form action={createSaleAction} style={{ marginTop: 10 }}>
            <input type="hidden" name="unit_number" value={unit.unit_number} /><input type="hidden" name="back" value={back} />
            <div className="row">
              <div className="field"><label>Customer</label><select name="customer_id" required defaultValue=""><option value="" disabled>Choose…</option>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div className="field"><label>Sale price</label><input name="price" required inputMode="decimal" defaultValue={unit.asking_price ?? ""} /></div>
              <div className="field"><label>Freight</label><input name="freight" inputMode="decimal" placeholder="0.00" /></div>
              <div className="field"><label>Tax rate %</label><input name="tax_percent" inputMode="decimal" placeholder="Customer's rate" /></div>
              <label className="check"><input type="checkbox" name="taxable" defaultChecked /> Taxable</label>
              <div className="field"><label>Terms (days)</label><input name="terms_days" inputMode="numeric" placeholder="Customer's terms" /></div>
              <div className="field"><label>Hours at sale</label><input name="hours_at_sale" inputMode="decimal" defaultValue={unit.hour_meter ?? ""} /></div>
            </div>
            <div className="field" style={{ marginTop: 6 }}><label>Notes printed on the invoice</label><textarea name="notes" rows={2} /></div>
            <button className="btn-primary" style={{ marginTop: 8 }}>Create draft sale</button>
          </form>
        </details>)}

      <div className="card">
        <h2>Service and shop</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Service</th><th>Every</th><th>Last done</th><th>Next due</th><th>Status</th>{can(user, "edit_records") && <th />}</tr></thead>
          <tbody>{services.map((s: any) => <tr key={s.id}><td>{s.name}</td>
            <td>{[s.every_hours ? `${Number(s.every_hours)} hrs` : null, s.every_days ? `${s.every_days} days` : null].filter(Boolean).join(" or ")}</td>
            <td>{[s.last_done_hours != null ? `${s.last_done_hours} hrs` : null, s.last_done_on ? fmtDate(s.last_done_on) : null].filter(Boolean).join(", ") || "—"}</td>
            <td>{[s.due_at_hours ? `${s.due_at_hours} hrs` : null, s.due_on ? fmtDate(s.due_on) : null].filter(Boolean).join(" or ") || "—"}</td>
            <td><DueBadge status={s.status} />{s.open_wo && <> <a href={`/shop/${s.open_wo_id}`}>{s.open_wo}</a></>}</td>
            {can(user, "edit_records") && <td><form action={intervalActiveAction} className="inline"><input type="hidden" name="back" value={back} /><input type="hidden" name="interval_id" value={s.id} /><input type="hidden" name="active" value="false" /><button className="btn-sm">Turn off</button></form></td>}</tr>)}</tbody>
        </table>{!services.length && <Empty>No service schedules for this unit.</Empty>}</div>
        {can(user, "edit_records") && unit.status !== "sold" && (
          <details style={{ marginTop: 10 }}><summary>Add a service schedule</summary>
            <form action={createIntervalAction} className="row" style={{ marginTop: 6 }}>
              <input type="hidden" name="equipment_id" value={id} /><input type="hidden" name="back" value={back} />
              <div className="field" style={{ flexBasis: 200 }}><label>Service</label><input name="name" required placeholder="250-hour service" /></div>
              <div className="field"><label>Every (hours)</label><input name="every_hours" inputMode="decimal" style={{ width: 90 }} /></div>
              <div className="field"><label>Every (days)</label><input name="every_days" inputMode="numeric" style={{ width: 90 }} /></div>
              <div className="field"><label>Last done at (hours)</label><input name="last_done_hours" inputMode="decimal" defaultValue={unit.hour_meter ?? ""} style={{ width: 110 }} /></div>
              <div className="field"><label>Last done on</label><input type="date" name="last_done_on" /></div>
              <button>Add</button>
            </form></details>)}
        <h3 style={{ marginTop: 14 }}>Work orders</h3>
        <div className="table-wrap"><table>
          <thead><tr><th>Work order</th><th>Type</th><th>Problem</th><th>Opened</th><th>Status</th><th className="num">Cost</th></tr></thead>
          <tbody>{myWos.map((w: any) => <tr key={w.id}><td><a href={`/shop/${w.id}`}>{w.wo_number}</a></td><td>{WO_KIND_LABELS[w.kind]}</td><td className="small">{w.complaint}</td><td>{fmtDate(w.opened_on)}</td><td><WoStatus status={w.status} /></td><td className="num">{fmtUSD(w.total)}</td></tr>)}</tbody>
        </table>{!myWos.length && <Empty>No work orders yet.</Empty>}</div>
        {can(user, "edit_records") && !["sold", "retired"].includes(unit.status) && (
          <details style={{ marginTop: 10 }}><summary>Open a work order</summary>
            <form action={createWorkOrderAction} style={{ marginTop: 6 }}>
              <input type="hidden" name="unit_number" value={unit.unit_number} /><input type="hidden" name="back" value={back} />
              <div className="row">
                <div className="field"><label>Type</label><select name="kind" defaultValue="repair">{Object.entries(WO_KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                <div className="field"><label>Hour meter</label><input name="hours_in" inputMode="decimal" defaultValue={unit.hour_meter ?? ""} /></div>
                <div className="field"><label>Assigned to</label><input name="assigned_to" /></div>
              </div>
              <div className="field"><label>Problem or work to do</label><textarea name="complaint" rows={2} required minLength={3} /></div>
              <label className="check"><input type="checkbox" name="put_in_shop" defaultChecked={!open} /> Mark the unit &ldquo;In shop&rdquo;</label>
              <button className="btn-primary" style={{ marginTop: 8 }}>Open work order</button>
            </form></details>)}
      </div>

      <div className="card">
        <h2>Rentals</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Rental</th><th>Customer</th><th>On rent</th><th>Off rent</th><th>Rate</th><th>Status</th></tr></thead>
          <tbody>{rentals.map((r: any) => <tr key={r.id}><td><a href={`/rentals/${r.id}`}>{r.contract_number}</a></td><td>{r.customer_name}</td><td>{fmtDate(r.on_rent_date)}</td><td>{fmtDate(r.off_rent_date)}</td><td>{fmtUSD(r.rate_amount)} {RATE_BASIS_LABELS[r.rate_basis as keyof typeof RATE_BASIS_LABELS]}</td><td><RentalBadge status={r.status} /></td></tr>)}</tbody>
        </table>{!rentals.length && <Empty>Never rented.</Empty>}</div>
      </div>

      <div className="card">
        <h2>History <span className="muted small">(kept permanently)</span></h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>What happened</th><th>Yard</th><th className="num">Hours</th><th>Details</th><th>By</th></tr></thead>
          <tbody>{events.map((ev: any) => <tr key={ev.id}><td className="nowrap">{fmtDate(ev.event_date)}</td><td>{EVENT_LABELS[ev.kind] ?? ev.kind}{ev.status ? <> → <UnitStatus status={ev.status} /></> : null}</td><td>{ev.yard_name ?? "—"}</td><td className="num">{ev.hours ?? "—"}</td>
            <td className="small">{ev.note ?? ""}{ev.contract_line_id && <> <a href={`/rentals/${ev.contract_line_id}`}>{ev.contract_number}</a></>}{ev.sale_id && <> <a href={`/sales/${ev.sale_id}`}>sale</a></>}{ev.work_order_id && <> <a href={`/shop/${ev.work_order_id}`}>work order</a></>}</td><td className="small">{ev.user_name ?? "—"}</td></tr>)}</tbody>
        </table>{!events.length && <Empty>No history recorded yet.</Empty>}</div>
      </div>
    </>
  );
}
