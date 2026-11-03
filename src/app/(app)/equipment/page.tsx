import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { q } from "@/lib/db";
import { Flash, RentalBadge } from "@/components/ui";
import { createEquipmentAction } from "../../actions";

export default async function Equipment({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const rows = await q(`SELECT e.*, l.id AS line_id, l.status, c.name AS customer FROM equipment e
                        LEFT JOIN rental_contract_lines l ON l.equipment_id=e.id AND l.status IN ('active','off_rent') LEFT JOIN rental_contracts rc ON rc.id=l.contract_id LEFT JOIN customers c ON c.id=rc.customer_id
                        WHERE ($1::text IS NULL OR e.unit_number ILIKE '%'||$1||'%' OR e.description ILIKE '%'||$1||'%') ORDER BY e.unit_number`, [sp.q || null]);
  return (
    <>
      <div className="topbar"><h1>Equipment</h1><form method="get" className="row"><input name="q" defaultValue={sp.q} placeholder="Search units" /><button>Search</button></form></div>
      <Flash sp={sp} />
      {can(user, "edit_records") && <form className="card" action={createEquipmentAction}><h2>Add unit</h2><input type="hidden" name="back" value="/equipment" />
        <div className="row">
          <div className="field"><label>Unit #</label><input name="unit_number" required /></div>
          <div className="field" style={{ flexBasis: 220 }}><label>Description</label><input name="description" required /></div>
          <div className="field"><label>Serial #</label><input name="serial_number" /></div>
          <div className="field"><label>Make</label><input name="make" /></div>
          <div className="field"><label>Model</label><input name="model" /></div>
          <div className="field"><label>Year</label><input name="year" inputMode="numeric" /></div>
          <button className="btn-primary">Add</button>
        </div></form>}
      <div className="table-wrap"><table>
        <thead><tr><th>Unit</th><th>Description</th><th>Serial</th><th>Make / model</th><th>On rent to</th></tr></thead>
        <tbody>{rows.map((e: any) => <tr key={e.id}><td className="mono">{e.unit_number}</td><td>{e.description}</td><td>{e.serial_number ?? "—"}</td><td>{[e.make, e.model, e.year].filter(Boolean).join(" ") || "—"}</td>
          <td>{e.line_id ? <><a href={`/rentals/${e.line_id}`}>{e.customer}</a> <RentalBadge status={e.status} /></> : <span className="muted">Available</span>}</td></tr>)}</tbody>
      </table></div>
    </>
  );
}
