import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { Flash, Empty } from "@/components/ui";
import { feeAdminList, feeReport, equipmentClasses, equipmentCategories } from "@/lib/services/fees";
import { FEE_CATEGORY_LABELS, FEE_FREQUENCY_LABELS, pctLabel } from "@/lib/fees";
import { addDays, addMonths, fmtDate, monthLabel, monthStart, todayCentral } from "@/lib/dates";
import { fmtUSD } from "@/lib/money";
import { addFeeAssignmentAction, addFeeRateAction, createFeeTypeAction, endFeeRateAction, feeActiveAction, removeFeeAssignmentAction, updateFeeTypeAction } from "../../actions";

const rateText = (calc: string, r: any) => (calc === "percent" ? pctLabel(r.percent) : fmtUSD(r.amount));

function FeeFields({ f, disabled }: { f?: any; disabled: boolean }) {
  return (
    <>
      <div className="row">
        <div className="field"><label>Code</label><input name="code" defaultValue={f?.code ?? ""} placeholder="HET" required disabled={disabled} style={{ width: 110, textTransform: "uppercase" }} /></div>
        <div className="field" style={{ flexBasis: 260 }}><label>Name shown on invoices</label><input name="name" defaultValue={f?.name ?? ""} placeholder="Heavy equipment rental tax" required disabled={disabled} /></div>
        <div className="field"><label>Type</label><select name="category" defaultValue={f?.category ?? ""} required disabled={disabled}>
          <option value="" disabled>Choose…</option>{Object.entries(FEE_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label>Charged as</label><select name="calc_type" defaultValue={f?.calc_type ?? ""} required disabled={disabled || !!f}>
          <option value="" disabled>Choose…</option><option value="percent">Percent of rental or sale price</option><option value="fixed">Flat dollar amount</option></select>
          {f && <input type="hidden" name="calc_type" value={f.calc_type} />}</div>
        <div className="field"><label>How often</label><select name="frequency" defaultValue={f?.frequency ?? "per_billing_cycle"} disabled={disabled}>
          {Object.entries(FEE_FREQUENCY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label>GL account</label><input name="gl_account" defaultValue={f?.gl_account ?? ""} disabled={disabled} style={{ width: 110 }} /></div>
      </div>
      <div className="row">
        <label className="check"><input type="checkbox" name="applies_rentals" defaultChecked={f ? f.applies_rentals : true} disabled={disabled} /> Rentals (quotes, contracts, invoices)</label>
        <label className="check"><input type="checkbox" name="applies_sales" defaultChecked={f?.applies_sales ?? false} disabled={disabled} /> Equipment sales</label>
        <label className="check"><input type="checkbox" name="taxable" defaultChecked={f?.taxable ?? false} disabled={disabled} /> Sales tax is charged on this fee</label>
        <label className="check"><input type="checkbox" name="allow_override" defaultChecked={f ? f.allow_override : true} disabled={disabled} /> Approvers may change or waive it on one rental or sale</label>
      </div>
      <div className="field"><label>Notes</label><input name="description" defaultValue={f?.description ?? ""} placeholder="Where the rate comes from, who it applies to" disabled={disabled} /></div>
    </>
  );
}

export default async function FeesPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const admin = can(user, "manage_fees");
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? `${sp.month}-01` : monthStart(todayCentral());
  const [{ types, rates, assignments }, report, classes, cats] = await Promise.all([
    feeAdminList(), feeReport(month, addDays(addMonths(month, 1), -1)), equipmentClasses(), equipmentCategories(),
  ]);
  const today = todayCentral();
  const groups = (["regulatory_tax", "business_surcharge"] as const).map((c) => ({ c, rows: report.filter((r: any) => r.category === c) }));
  return (
    <>
      <div className="topbar"><div><h1>Fees &amp; taxes</h1><div className="muted">HET, TERP, environmental and any other fee charged per unit. Nothing is charged until a fee has a rate and is assigned to equipment.</div></div></div>
      <Flash sp={sp} />
      <datalist id="classes">{classes.map((c) => <option key={c.v} value={c.v} />)}</datalist>
      <datalist id="cats">{cats.map((c) => <option key={c.v} value={c.v} />)}</datalist>

      {types.length === 0 && <Empty>No fees or taxes are set up yet.</Empty>}
      {types.map((f: any) => {
        const fr = rates.filter((r: any) => String(r.fee_type_id) === String(f.id));
        const current = fr.find((r: any) => r.effective_from <= today && (!r.effective_to || r.effective_to >= today));
        const asg = assignments.filter((a: any) => String(a.fee_type_id) === String(f.id));
        return (
          <div className="card" key={f.id} id={`fee-${f.id}`} style={f.active ? undefined : { opacity: 0.7 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}><span className="mono">{f.code}</span> {f.name}</h2>
              <div className="row">
                <span className={`badge ${f.category === "regulatory_tax" ? "b-info" : ""}`}>{FEE_CATEGORY_LABELS[f.category as keyof typeof FEE_CATEGORY_LABELS]}</span>
                <span className={`badge ${f.active ? "b-ok" : ""}`}>{f.active ? "On" : "Off"}</span>
                {admin && <form action={feeActiveAction} className="inline"><input type="hidden" name="fee_id" value={f.id} /><input type="hidden" name="active" value={String(!f.active)} /><input type="hidden" name="back" value={`/fees#fee-${f.id}`} /><button className="btn-sm">{f.active ? "Turn off" : "Turn on"}</button></form>}
              </div>
            </div>
            <p className="small">
              {current ? <>Current rate <b>{rateText(f.calc_type, current)}</b>{f.calc_type === "percent" ? " of the rental or sale price" : ""}, {FEE_FREQUENCY_LABELS[f.frequency as keyof typeof FEE_FREQUENCY_LABELS].toLowerCase()}, since {fmtDate(current.effective_from)}{current.effective_to ? ` through ${fmtDate(current.effective_to)}` : ""}.</>
                : <span className="badge b-warn">No rate in effect today</span>}
              {" "}{[f.applies_rentals && "Rentals", f.applies_sales && "Sales"].filter(Boolean).join(" and ")}. {f.taxable ? "Sales tax applies to it." : "No sales tax on it."}{f.gl_account ? ` GL ${f.gl_account}.` : ""}
            </p>
            <p className="small"><b>Applies to:</b>{" "}
              {asg.length === 0 && Number(f.units_on) === 0 ? <span className="muted">no equipment yet</span> : <>
                {asg.map((a: any) => <span key={a.id} className="badge" style={{ marginRight: 4 }}>
                  {a.scope === "all" ? "All equipment" : a.scope === "class" ? `Class: ${a.equipment_class}` : `Category: ${a.category}`}
                  {admin && <form action={removeFeeAssignmentAction} className="inline"><input type="hidden" name="assignment_id" value={a.id} /><input type="hidden" name="back" value={`/fees#fee-${f.id}`} /><button className="btn-link small" title="Remove" aria-label="Remove">×</button></form>}
                </span>)}
                {Number(f.units_on) > 0 && <span className="badge">{f.units_on} unit(s) switched on individually</span>}
              </>}
              {Number(f.units_off) > 0 && <span className="muted"> · switched off on {f.units_off} unit(s)</span>}
            </p>
            {admin && <div className="grid g3">
              <details><summary className="small">Assign to equipment</summary>
                <form action={addFeeAssignmentAction}><input type="hidden" name="fee_id" value={f.id} /><input type="hidden" name="back" value={`/fees#fee-${f.id}`} />
                  <div className="field"><label>Assign by</label><select name="scope" defaultValue="class"><option value="class">Equipment class</option><option value="category">Product category</option><option value="all">All equipment</option></select></div>
                  <div className="field"><label>Class or category (leave blank for all)</label><input name="value" list="classes" /></div>
                  <p className="small muted">Single units are switched on or off from each unit's equipment page.</p>
                  <button className="btn-sm">Add</button></form></details>
              <details><summary className="small">New rate</summary>
                <form action={addFeeRateAction}><input type="hidden" name="fee_id" value={f.id} /><input type="hidden" name="back" value={`/fees#fee-${f.id}`} />
                  <div className="row"><div className="field"><label>{f.calc_type === "percent" ? "Percent" : "Amount ($)"}</label><input name="rate" inputMode="decimal" required style={{ width: 100 }} /></div>
                    <div className="field"><label>Starts</label><input type="date" name="effective_from" required /></div></div>
                  <div className="field"><label>Source or note</label><input name="rate_note" placeholder="e.g. State notice dated …" /></div>
                  <button className="btn-sm">Save rate</button></form>
                {fr.some((r: any) => !r.effective_to) && <form action={endFeeRateAction} style={{ marginTop: 8 }}><input type="hidden" name="fee_id" value={f.id} /><input type="hidden" name="back" value={`/fees#fee-${f.id}`} />
                  <div className="row"><div className="field"><label>Or end the current rate on</label><input type="date" name="last_day" required /></div><button className="btn-sm">End rate</button></div></form>}
              </details>
              <details><summary className="small">Edit details</summary>
                <form action={updateFeeTypeAction}><input type="hidden" name="fee_id" value={f.id} /><input type="hidden" name="back" value={`/fees#fee-${f.id}`} /><FeeFields f={f} disabled={false} /><button className="btn-sm">Save</button></form></details>
            </div>}
            {fr.length > 0 && <details><summary className="small">Rate history ({fr.length})</summary>
              <table className="small"><thead><tr><th>Rate</th><th>From</th><th>Through</th><th>Note</th></tr></thead><tbody>
                {fr.map((r: any) => <tr key={r.id}><td>{rateText(f.calc_type, r)}</td><td>{fmtDate(r.effective_from)}</td><td>{r.effective_to ? fmtDate(r.effective_to) : "open"}</td><td>{r.note ?? ""}</td></tr>)}
              </tbody></table></details>}
          </div>
        );
      })}

      {admin && <form className="card" action={createFeeTypeAction}>
        <h2>Add a fee or tax</h2><input type="hidden" name="back" value="/fees" />
        <p className="small muted">Keep government-required charges (HET, TERP) as <b>Regulatory tax or assessment</b> and Champion's own charges as <b>Business surcharge</b>. They are reported and exported separately. Enter rates from the current official source; the system has no built-in rates.</p>
        <FeeFields disabled={false} />
        <div className="row">
          <div className="field"><label>First rate (percent, or $ for flat)</label><input name="rate" inputMode="decimal" style={{ width: 120 }} /></div>
          <div className="field"><label>Rate starts</label><input type="date" name="effective_from" /></div>
          <div className="field" style={{ flexBasis: 300 }}><label>Source or note</label><input name="rate_note" /></div>
        </div>
        <button className="btn-primary">Create fee</button>
      </form>}

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Billed in {monthLabel(month)}</h2>
          <div className="row"><a className="btn btn-sm" href={`/fees?month=${addMonths(month, -1).slice(0, 7)}`}>← Prev</a><a className="btn btn-sm" href={`/fees?month=${addMonths(month, 1).slice(0, 7)}`}>Next →</a>
            {can(user, "export_data") && <a className="btn btn-sm" href="/api/export/fee-lines">Export all fee lines</a>}</div>
        </div>
        <p className="small muted">Finalized invoices and sales dated this month. Voided and replaced invoices are left out.</p>
        {groups.map(({ c, rows }) => <div key={c}>
          <h3>{FEE_CATEGORY_LABELS[c]}s</h3>
          {rows.length ? <table><thead><tr><th>Fee</th><th>GL account</th><th className="num">Lines</th><th className="num">Total</th></tr></thead><tbody>
            {rows.map((r: any) => <tr key={r.id}><td><span className="mono">{r.code}</span> {r.name}</td><td>{r.gl_account ?? ""}</td><td className="num">{r.lines}</td><td className="num">{fmtUSD(r.total)}</td></tr>)}
            <tr><td colSpan={3}><b>Total</b></td><td className="num"><b>{fmtUSD(rows.reduce((s: number, r: any) => s + Number(r.total), 0))}</b></td></tr>
          </tbody></table> : <p className="muted small">None billed.</p>}
        </div>)}
      </div>
    </>
  );
}
