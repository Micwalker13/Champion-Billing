import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { fmtUSD, dec } from "@/lib/money";
import { fmtDate, todayCentral } from "@/lib/dates";
import { Empty, Flash } from "@/components/ui";
import { listYards } from "@/lib/services/inventory";
import { q } from "@/lib/db";
import { COST_BASIS_LABELS, listReRents, reRentBills, vendorNames } from "@/lib/services/rerents";
import { addReRentAction, addReRentBillAction, returnToVendorAction, voidReRentBillAction } from "../../actions";

export default async function ReRents({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const edit = can(user, "edit_records");
  const today = todayCentral();
  const [rows, vendors, yards, classes] = await Promise.all([listReRents({ open: !sp.all }), vendorNames(), listYards(), q(`SELECT DISTINCT btrim(category) AS c FROM equipment WHERE category IS NOT NULL AND btrim(category) <> '' ORDER BY 1`).then((r) => r.map((x: any) => x.c as string))]);
  const bills = await Promise.all(rows.map((r: any) => reRentBills(r.id)));
  return (
    <>
      <div className="topbar"><div><h1>Re-rents</h1><div className="muted">Machines rented from a supplier and rented out to your customers. They rent, bill and dispatch like your own units. Record the supplier&rsquo;s bills here to see what each one really makes.</div></div>
        <a className="btn" href={sp.all ? "/rerents" : "/rerents?all=1"}>{sp.all ? "Open only" : "Show returned too"}</a></div>
      <Flash sp={sp} />
      <div className="table-wrap"><table>
        <thead><tr><th>Unit</th><th>Supplier</th><th className="num">Cost</th><th>Out to</th><th className="num">Billed to customer</th><th className="num">Supplier bills</th><th className="num">Margin</th></tr></thead>
        <tbody>{rows.map((r: any, i: number) => {
          const margin = dec(r.revenue_billed).sub(r.cost_billed);
          return <tr key={r.id}>
            <td><a className="mono" href={`/equipment/${r.equipment_id}`}>{r.unit_number}</a><div className="small">{r.description}{r.category && <span className="muted"> · {r.category}</span>}</div>
              <div className="small muted">In {fmtDate(r.received_date)}{r.returned_date ? `, back ${fmtDate(r.returned_date)}` : ""}</div></td>
            <td>{r.vendor_name}<div className="small muted">{[r.vendor_agreement && `Agreement ${r.vendor_agreement}`, r.vendor_po && `PO ${r.vendor_po}`, r.vendor_unit && `Their unit ${r.vendor_unit}`].filter(Boolean).join(" · ")}</div></td>
            <td className="num nowrap">{fmtUSD(r.cost_amount)} <span className="small muted">{COST_BASIS_LABELS[r.cost_basis]}</span></td>
            <td>{r.line_id ? <><a href={`/rentals/${r.line_id}`}>{r.contract_number}</a><div className="small">{r.customer_name}</div></> : <span className="muted">{r.returned_date ? "Returned" : "In yard"}</span>}</td>
            <td className="num">{fmtUSD(r.revenue_billed)}</td>
            <td className="num">{fmtUSD(r.cost_billed)}
              <details><summary className="small">{bills[i].length} bill{bills[i].length === 1 ? "" : "s"}</summary>
                <table className="small"><tbody>{bills[i].map((b: any) => <tr key={b.id} style={b.voided_at ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>
                  <td>{b.vendor_invoice}</td><td>{fmtDate(b.bill_date)}</td><td className="num">{fmtUSD(b.amount)}</td>
                  <td>{b.voided_at ? <span title={b.void_reason}>voided</span> : edit && <form action={voidReRentBillAction} className="row"><input type="hidden" name="bill_id" value={b.id} /><input type="hidden" name="back" value="/rerents" /><input name="reason" placeholder="Why void?" required minLength={3} style={{ width: 90 }} /><button className="btn-sm">Void</button></form>}</td>
                </tr>)}</tbody></table>
                {edit && <form action={addReRentBillAction} style={{ textAlign: "left" }}><input type="hidden" name="re_rent_id" value={r.id} /><input type="hidden" name="back" value="/rerents" />
                  <div className="row">
                    <div className="field"><label>Their invoice #</label><input name="vendor_invoice" required style={{ width: 110 }} /></div>
                    <div className="field"><label>Bill date</label><input type="date" name="bill_date" required defaultValue={today} /></div>
                    <div className="field"><label>Amount</label><input name="amount" required inputMode="decimal" style={{ width: 100 }} /></div>
                  </div>
                  <div className="row">
                    <div className="field"><label>Period from</label><input type="date" name="period_start" /></div>
                    <div className="field"><label>to</label><input type="date" name="period_end" /></div>
                    <button className="btn-sm">Add bill</button>
                  </div></form>}
              </details></td>
            <td className={`num ${margin.lt(0) ? "text-bad" : ""}`}>{fmtUSD(margin)}
              {edit && !r.returned_date && !r.line_id && <details><summary className="small">Return to supplier</summary>
                <form action={returnToVendorAction} className="row"><input type="hidden" name="re_rent_id" value={r.id} /><input type="hidden" name="back" value="/rerents" />
                  <input type="date" name="returned_date" defaultValue={today} required /><button className="btn-sm">Returned</button></form></details>}</td>
          </tr>;
        })}</tbody>
      </table>{!rows.length && <Empty>No re-rented machines{sp.all ? "" : " right now"}.</Empty>}</div>
      <p className="small muted">Billed to customer is every finalized invoice for the unit, before sales tax and without HET/TERP-type taxes. Supplier bills are what you&rsquo;ve entered here. Customer invoices never change because of a re-rent.</p>

      {edit && (
        <form className="card" action={addReRentAction}>
          <h2>Add a re-rented machine</h2><input type="hidden" name="back" value="/rerents" />
          <datalist id="vendors">{vendors.map((v) => <option key={v} value={v} />)}</datalist>
          <datalist id="classes">{classes.map((c) => <option key={c} value={c} />)}</datalist>
          <div className="row">
            <div className="field" style={{ flexBasis: 200 }}><label>Supplier</label><input name="vendor_name" list="vendors" required /></div>
            <div className="field"><label>Your unit #</label><input name="unit_number" required placeholder="e.g. RR-1001" style={{ width: 120 }} /></div>
            <div className="field" style={{ flexBasis: 200 }}><label>Description</label><input name="description" required placeholder="e.g. 60' boom lift" /></div>
            <div className="field"><label>Class</label><input name="category" list="classes" /></div>
          </div>
          <div className="row">
            <div className="field"><label>Their unit #</label><input name="vendor_unit" style={{ width: 110 }} /></div>
            <div className="field"><label>Their agreement #</label><input name="vendor_agreement" style={{ width: 130 }} /></div>
            <div className="field"><label>Your PO to them</label><input name="vendor_po" style={{ width: 120 }} /></div>
            <div className="field"><label>Cost</label><input name="cost_amount" required inputMode="decimal" style={{ width: 100 }} /></div>
            <div className="field"><label>Per</label><select name="cost_basis" defaultValue="monthly">{Object.entries(COST_BASIS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="field"><label>Received</label><input type="date" name="received_date" required defaultValue={today} /></div>
            <div className="field"><label>Yard</label><select name="yard_id" defaultValue=""><option value="">—</option>{yards.map((y: any) => <option key={y.id} value={y.id}>{y.name}</option>)}</select></div>
          </div>
          <div className="row">
            <div className="field"><label>Make</label><input name="make" /></div>
            <div className="field"><label>Model</label><input name="model" /></div>
            <div className="field"><label>Serial #</label><input name="serial_number" /></div>
            <div className="field" style={{ flexBasis: 240 }}><label>Notes</label><input name="notes" /></div>
          </div>
          <button className="btn-primary" style={{ marginTop: 8 }}>Add re-rent</button>
          <p className="small muted">Then put it on rent from Rentals or a reservation&rsquo;s Send out, the same as your own machines. You bill the customer your normal rate.</p>
        </form>)}
    </>
  );
}
