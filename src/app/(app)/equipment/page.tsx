import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { fmtUSD } from "@/lib/money";
import { Flash, Kpi, Empty, UnitStatus } from "@/components/ui";
import { UNIT_STATUS_LABELS, inventory, listYards } from "@/lib/services/inventory";
import { createEquipmentAction, createYardAction } from "../../actions";

export default async function Equipment({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const status = sp.status && UNIT_STATUS_LABELS[sp.status] ? sp.status : null;
  const yard = /^\d+$/.test(sp.yard ?? "") ? sp.yard : null;
  const [{ rows, counts, utilization }, yards] = await Promise.all([inventory({ q: sp.q, status, yard }), listYards()]);
  const link = (s: string | null) => `/equipment?${new URLSearchParams({ ...(s ? { status: s } : {}), ...(yard ? { yard } : {}), ...(sp.q ? { q: sp.q } : {}) })}`;
  return (
    <>
      <div className="topbar">
        <div><h1>Equipment</h1><div className="muted">Every unit, where it is, and whether it can go out. &ldquo;On rent&rdquo; comes from the open rental, so it is always current.</div></div>
      </div>
      <Flash sp={sp} />
      <div className="kpis">
        <Kpi label="On rent" value={counts.on_rent} sub={`${utilization}% of the rental fleet`} href={link("on_rent")} />
        <Kpi label="Available in the yard" value={counts.available} tone="ok" href={link("available")} />
        <Kpi label="In the shop" value={counts.in_shop} tone={counts.in_shop ? "warn" : undefined} href={link("in_shop")} />
        <Kpi label="Sold" value={counts.sold} href={link("sold")} />
      </div>

      <form method="get" className="card row" style={{ alignItems: "flex-end" }}>
        <div className="field"><label htmlFor="q">Search</label><input id="q" name="q" defaultValue={sp.q} placeholder="Unit, serial, description, category" /></div>
        <div className="field"><label htmlFor="status">Status</label><select id="status" name="status" defaultValue={status ?? ""}><option value="">Any</option>{Object.entries(UNIT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label htmlFor="yard">Yard</label><select id="yard" name="yard" defaultValue={yard ?? ""}><option value="">All yards</option>{yards.map((y: any) => <option key={y.id} value={y.id}>{y.name}</option>)}</select></div>
        <button>Show</button>
      </form>

      <div className="table-wrap"><table>
        <thead><tr><th>Unit</th><th>Description</th><th>Category</th><th>Serial</th><th>Status</th><th>Where</th><th className="num">Hours</th><th className="num">Asking price</th></tr></thead>
        <tbody>{rows.map((e: any) => (
          <tr key={e.id}>
            <td><a className="mono" href={`/equipment/${e.id}`}>{e.unit_number}</a></td>
            <td>{e.description}<div className="small muted">{[e.year, e.make, e.model].filter(Boolean).join(" ")}</div></td>
            <td>{e.category ?? "—"}</td><td>{e.serial_number ?? "—"}</td>
            <td><UnitStatus status={e.where_status} /></td>
            <td>{e.line_id ? <><a href={`/rentals/${e.line_id}`}>{e.customer_name}</a><div className="small muted">{e.contract_number}</div></> : e.yard_name ?? <span className="muted">No yard set</span>}</td>
            <td className="num">{e.hour_meter ?? "—"}</td><td className="num">{e.asking_price ? fmtUSD(e.asking_price) : "—"}</td>
          </tr>))}</tbody>
      </table>{!rows.length && <Empty>No units match.</Empty>}</div>

      {can(user, "edit_records") && <div className="grid g2">
        <form className="card" action={createEquipmentAction}><h2>Add a unit</h2><input type="hidden" name="back" value="/equipment" />
          <div className="row">
            <div className="field"><label>Unit #</label><input name="unit_number" required /></div>
            <div className="field" style={{ flexBasis: 220 }}><label>Description</label><input name="description" required placeholder="e.g. 10K telehandler" /></div>
            <div className="field"><label>Category</label><input name="category" placeholder="e.g. Telehandler" /></div>
            <div className="field"><label>Serial #</label><input name="serial_number" /></div>
            <div className="field"><label>Make</label><input name="make" /></div>
            <div className="field"><label>Model</label><input name="model" /></div>
            <div className="field"><label>Year</label><input name="year" inputMode="numeric" /></div>
            <div className="field"><label>Hours</label><input name="hour_meter" inputMode="decimal" /></div>
            <div className="field"><label>Yard</label><select name="yard_id" defaultValue=""><option value="">—</option>{yards.map((y: any) => <option key={y.id} value={y.id}>{y.name}</option>)}</select></div>
          </div>
          <button className="btn-primary" style={{ marginTop: 8 }}>Add unit</button>
        </form>
        <div className="card"><h2>Yards</h2>
          {yards.length ? <ul>{yards.map((y: any) => <li key={y.id}><a href={`/equipment?yard=${y.id}`}>{y.name}</a>{y.address && <span className="small muted"> · {y.address}</span>}</li>)}</ul> : <p className="muted">No yards yet. Add the places you keep equipment so each unit shows where it is.</p>}
          <form action={createYardAction} className="row" style={{ marginTop: 8 }}><input type="hidden" name="back" value="/equipment" />
            <div className="field"><label>Yard name</label><input name="name" required /></div>
            <div className="field" style={{ flexBasis: 220 }}><label>Address</label><input name="address" /></div>
            <button>Add yard</button>
          </form>
        </div>
      </div>}
    </>
  );
}
