import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { fmtUSD } from "@/lib/money";
import { fmtDate, todayCentral } from "@/lib/dates";
import { Empty, Flash, UnitStatus, WoStatus } from "@/components/ui";
import { LINE_KIND_LABELS, WO_KIND_LABELS, WO_STATUS_LABELS, workOrderDetail } from "@/lib/services/shop";
import { addWorkOrderLineAction, cancelWorkOrderAction, completeWorkOrderAction, linkWorkOrderRentalAction, removeWorkOrderLineAction, updateWorkOrderAction } from "../../../actions";

export default async function WorkOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const d = await workOrderDetail(id);
  if (!d) notFound();
  const { wo, lines, totals, total, rentals } = d;
  const back = `/shop/${id}`;
  const open = !["completed", "cancelled"].includes(wo.status);
  const edit = open && can(user, "edit_records");
  const H = ({ children }: { children: React.ReactNode }) => <><input type="hidden" name="wo_id" value={id} /><input type="hidden" name="back" value={back} />{children}</>;
  return (
    <>
      <div className="topbar"><div>
        <div className="muted small"><a href="/shop">Shop</a> / <a href={`/equipment/${wo.equipment_id}`}>{wo.unit_number}</a></div>
        <h1>{wo.wo_number} <WoStatus status={wo.status} /></h1>
        <div className="muted">{WO_KIND_LABELS[wo.kind]} · Unit <span className="mono">{wo.unit_number}</span> {wo.unit_description} <UnitStatus status={wo.unit_status} /> · opened {fmtDate(wo.opened_on)} by {wo.created_by_name ?? "—"}</div>
      </div></div>
      <Flash sp={sp} />

      <div className="grid g2">
        <div className="card">
          <h2>Work</h2>
          <dl className="kv">
            <dt>Problem</dt><dd style={{ whiteSpace: "pre-line" }}>{wo.complaint}</dd>
            <dt>Cause</dt><dd style={{ whiteSpace: "pre-line" }}>{wo.cause ?? "—"}</dd>
            <dt>Correction</dt><dd style={{ whiteSpace: "pre-line" }}>{wo.correction ?? "—"}</dd>
            <dt>Assigned to</dt><dd>{wo.assigned_to ?? "—"}</dd>
            <dt>Hour meter in</dt><dd>{wo.hours_in ?? "—"}</dd>
            {wo.interval_name && <><dt>Service schedule</dt><dd>{wo.interval_name} (completing this resets it)</dd></>}
            <dt>Rental</dt><dd>{wo.contract_number ? <><a href={`/rentals/${wo.contract_line_id}`}>{wo.contract_number}</a> · {wo.customer_name}</> : "—"}</dd>
            {wo.completed_on && <><dt>Completed</dt><dd>{fmtDate(wo.completed_on)}</dd></>}
            {wo.billed_fee_id && <><dt>Billed to customer</dt><dd>{fmtUSD(total)} as a one-time charge on {wo.contract_number}{wo.billed_on_invoice_id ? <> (<a href={`/invoices/${wo.billed_on_invoice_id}`}>invoice</a>)</> : " (on its next invoice)"}</dd></>}
          </dl>
        </div>
        {edit && (
          <form className="card" action={updateWorkOrderAction}><H>
            <h2>Update</h2>
            <div className="row">
              <div className="field"><label>Status</label><select name="status" defaultValue={wo.status}>{["open", "in_progress", "waiting_parts"].map((s) => <option key={s} value={s}>{WO_STATUS_LABELS[s]}</option>)}</select></div>
              <div className="field"><label>Assigned to</label><input name="assigned_to" defaultValue={wo.assigned_to ?? ""} /></div>
            </div>
            <div className="field"><label>Cause</label><textarea name="cause" rows={2} defaultValue={wo.cause ?? ""} /></div>
            <div className="field"><label>Correction so far</label><textarea name="correction" rows={2} defaultValue={wo.correction ?? ""} /></div>
            <button style={{ marginTop: 8 }}>Save</button>
          </H></form>)}
      </div>

      <div className="card">
        <h2>Parts, labor and outside repair</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Type</th><th>Description</th><th>Part #</th><th className="num">Qty</th><th className="num">Each</th><th className="num">Amount</th>{edit && <th />}</tr></thead>
          <tbody>{lines.map((l: any) => <tr key={l.id}><td>{LINE_KIND_LABELS[l.kind]}</td><td>{l.description}</td><td className="mono">{l.part_number ?? ""}</td>
            <td className="num">{Number(l.quantity)}</td><td className="num">{fmtUSD(l.unit_cost)}</td><td className="num">{fmtUSD(l.amount)}</td>
            {edit && <td><form action={removeWorkOrderLineAction} className="inline"><H><input type="hidden" name="line_id" value={l.id} /><button className="btn-sm">Remove</button></H></form></td>}</tr>)}</tbody>
          <tfoot>
            <tr><td colSpan={5} className="right">Parts {fmtUSD(totals.part)} · Labor {fmtUSD(totals.labor)} · Outside {fmtUSD(totals.outside)}</td><td className="num"><strong>{fmtUSD(total)}</strong></td>{edit && <td />}</tr>
          </tfoot>
        </table>{!lines.length && <Empty>No parts or labor yet.</Empty>}</div>
        {edit && (
          <form action={addWorkOrderLineAction} className="row" style={{ marginTop: 10 }}><H>
            <div className="field"><label>Type</label><select name="kind" defaultValue="part">{Object.entries(LINE_KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="field" style={{ flexBasis: 240 }}><label>Description</label><input name="description" required placeholder="e.g. Hydraulic hose, or Mechanic hours" /></div>
            <div className="field"><label>Part #</label><input name="part_number" /></div>
            <div className="field"><label>Qty / hours</label><input name="quantity" inputMode="decimal" required defaultValue="1" style={{ width: 80 }} /></div>
            <div className="field"><label>Cost each</label><input name="unit_cost" inputMode="decimal" required placeholder="0.00" style={{ width: 100 }} /></div>
            <button>Add</button>
          </H></form>)}
      </div>

      {edit && (
        <div className="card">
          <h2>Finish</h2>
          {wo.kind === "damage" || wo.contract_line_id ? (
            <form action={linkWorkOrderRentalAction} className="row"><H>
              <div className="field" style={{ flexBasis: 360 }}><label>Rental the damage came from</label>
                <select name="contract_line_id" defaultValue={wo.contract_line_id ?? ""}><option value="">None</option>{rentals.map((r: any) => <option key={r.id} value={r.id}>{r.contract_number} · {r.customer_name} · {fmtDate(r.on_rent_date)} to {r.off_rent_date ? fmtDate(r.off_rent_date) : "now"}</option>)}</select></div>
              <button>Save link</button>
            </H></form>) : null}
          <form action={completeWorkOrderAction} style={{ marginTop: 10 }}><H>
            <div className="row">
              <div className="field"><label>Completed</label><input type="date" name="completed_on" defaultValue={todayCentral()} required /></div>
              <div className="field"><label>Hour meter out</label><input name="hours_out" inputMode="decimal" defaultValue={wo.hour_meter ?? ""} /></div>
              <div className="field"><label>Unit afterwards</label><select name="return_to" defaultValue="available"><option value="available">Ready (available)</option><option value="in_shop">Stays in shop</option></select></div>
            </div>
            <div className="field"><label>What was done</label><textarea name="correction" rows={2} required minLength={3} defaultValue={wo.correction ?? ""} /></div>
            {wo.contract_line_id && can(user, "approve_invoice") && <label className="check"><input type="checkbox" name="bill_customer" /> Bill {fmtUSD(total)} to {wo.customer_name} on {wo.contract_number} (adds a one-time charge to its next invoice)</label>}
            <button className="btn-primary" style={{ marginTop: 8 }}>Complete work order</button>
          </H></form>
          <details style={{ marginTop: 12 }}><summary>Cancel this work order</summary>
            <form action={cancelWorkOrderAction} className="row" style={{ marginTop: 6 }}><H><div className="field"><input name="reason" required minLength={5} placeholder="Reason" /></div><button className="btn-danger">Cancel work order</button></H></form>
          </details>
        </div>)}
    </>
  );
}
