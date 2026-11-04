import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { q } from "@/lib/db";
import { fmtUSD } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { Flash, StatusBadge, Empty } from "@/components/ui";
import { listSales } from "@/lib/services/sales";
import { createSaleAction } from "../../actions";

export default async function Sales({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const [sales, customers, forSale] = await Promise.all([
    listSales(),
    q(`SELECT id, name FROM customers WHERE active ORDER BY name`),
    q(`SELECT e.unit_number, e.description, e.asking_price FROM equipment e WHERE e.status IN ('available','in_shop','retired')
       AND NOT EXISTS (SELECT 1 FROM rental_contract_lines l WHERE l.equipment_id=e.id AND l.status IN ('active','off_rent'))
       AND NOT EXISTS (SELECT 1 FROM equipment_sales s WHERE s.equipment_id=e.id AND s.status <> 'voided') ORDER BY e.unit_number`),
  ]);
  return (
    <>
      <div className="topbar"><div><h1>Equipment sales</h1><div className="muted">Sell a unit from inventory on a numbered invoice. Sale invoices use the same invoice numbers as rentals and show up in Money owed.</div></div></div>
      <Flash sp={sp} />
      <div className="table-wrap"><table>
        <thead><tr><th>Invoice</th><th>Unit</th><th>Customer</th><th>Date</th><th>Due</th><th>Status</th><th className="num">Total</th><th className="num">Paid</th></tr></thead>
        <tbody>{sales.map((s: any) => <tr key={s.id}>
          <td><a href={`/sales/${s.id}`}>{s.sale_number ?? `Draft #${s.id}`}</a></td><td><span className="mono">{s.unit_number}</span><div className="small muted">{s.description}</div></td>
          <td>{s.customer_name}</td><td>{fmtDate(s.sale_date)}</td><td>{fmtDate(s.due_date)}</td><td><StatusBadge status={s.status} /></td><td className="num">{fmtUSD(s.total)}</td><td className="num">{fmtUSD(s.amount_paid)}</td></tr>)}</tbody>
      </table>{!sales.length && <Empty>No sales yet.</Empty>}</div>
      {can(user, "edit_records") && (
        <form className="card" action={createSaleAction}>
          <h2>Start a sale</h2>
          <p className="small muted">Units on rent or already sold are not listed. You can also start a sale from a unit&rsquo;s page.</p>
          <input type="hidden" name="back" value="/sales" />
          <div className="row">
            <div className="field"><label>Unit</label><select name="unit_number" required defaultValue=""><option value="" disabled>Choose…</option>{forSale.map((u: any) => <option key={u.unit_number} value={u.unit_number}>{u.unit_number} · {u.description}{u.asking_price ? ` · asking ${fmtUSD(u.asking_price)}` : ""}</option>)}</select></div>
            <div className="field"><label>Customer</label><select name="customer_id" required defaultValue=""><option value="" disabled>Choose…</option>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div className="field"><label>Sale price</label><input name="price" required inputMode="decimal" /></div>
            <div className="field"><label>Freight</label><input name="freight" inputMode="decimal" placeholder="0.00" /></div>
            <div className="field"><label>Tax rate %</label><input name="tax_percent" inputMode="decimal" placeholder="Customer's rate" /></div>
            <label className="check"><input type="checkbox" name="taxable" defaultChecked /> Taxable</label>
            <div className="field"><label>Terms (days)</label><input name="terms_days" inputMode="numeric" placeholder="Customer's terms" /></div>
          </div>
          <div className="field" style={{ marginTop: 6 }}><label>Notes printed on the invoice</label><textarea name="notes" rows={2} /></div>
          <button className="btn-primary" style={{ marginTop: 8 }}>Create draft sale</button>
        </form>)}
    </>
  );
}
