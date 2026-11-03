import { requireUser } from "@/lib/session";
import { q } from "@/lib/db";
import { BILLING_METHOD_LABELS, RATE_BASIS_LABELS } from "@/lib/billing";
import { Flash } from "@/components/ui";
import { createRentalAction } from "../../../actions";

export default async function NewRental({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireUser("edit_records");
  const sp = await searchParams;
  const customers = await q(`SELECT id, name FROM customers WHERE active ORDER BY name`);
  const units = await q(`SELECT e.unit_number, e.description FROM equipment e WHERE NOT EXISTS (SELECT 1 FROM rental_contract_lines l WHERE l.equipment_id=e.id AND l.status IN ('active','off_rent')) ORDER BY e.unit_number`);
  return (
    <>
      <div className="topbar"><div><div className="muted small"><a href="/rentals">Rentals</a> / New</div><h1>New continuous rental</h1>
        <div className="muted">For rentals already running in Quipli, set &quot;Bill in this system from&quot; to the first day Quipli has not billed, so no day is billed twice.</div></div></div>
      <Flash sp={sp} />
      <form action={createRentalAction} className="card">
        <input type="hidden" name="back" value="/rentals/new" />
        <h2>Agreement</h2>
        <div className="grid g3">
          <div className="field"><label>Rental contract #</label><input name="contract_number" required placeholder="CE-10025" /></div>
          <div className="field"><label>Customer</label><select name="customer_id" required>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div className="field"><label>Equipment unit</label><input name="unit_number" list="units" required placeholder="MUR002101" /><datalist id="units">{units.map((u: any) => <option key={u.unit_number} value={u.unit_number}>{u.description}</option>)}</datalist></div>
          <div className="field"><label>Original rental start date</label><input type="date" name="start_date" required /></div>
          <div className="field"><label>Bill in this system from</label><input type="date" name="billing_start_date" /><div className="small muted">Blank = start date</div></div>
          <div className="field"><label>Quipli reference (read-only note)</label><input name="quipli_reference" /></div>
          <div className="field"><label>Job number</label><input name="job_number" /></div>
          <div className="field"><label>Work order</label><input name="work_order_number" /></div>
          <div className="field"><label>Payment terms (days)</label><input name="payment_terms_days" inputMode="numeric" placeholder="Customer default" /></div>
        </div>
        <h2>Jobsite</h2>
        <div className="grid g2">
          <div className="field"><label>Jobsite name</label><input name="jobsite_name" /></div>
          <div className="field"><label>Jobsite address</label><textarea name="jobsite_address" rows={2} /></div>
        </div>
        <h2>Rates &amp; charges</h2>
        <div className="grid g4">
          <div className="field"><label>Rental rate</label><input name="rate_amount" required inputMode="decimal" placeholder="1924.25" /></div>
          <div className="field"><label>Rate basis</label><select name="rate_basis" defaultValue="monthly">{Object.entries(RATE_BASIS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="field"><label>Billing frequency</label><select name="billing_method" defaultValue=""><option value="">Customer default</option>{Object.entries(BILLING_METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="field"><label className="check" style={{ marginTop: 22 }}><input type="checkbox" name="taxable" defaultChecked /> Taxable</label></div>
          <div className="field"><label>Delivery charge</label><input name="delivery_charge" inputMode="decimal" defaultValue="0" /></div>
          <div className="field"><label>Pickup charge</label><input name="pickup_charge" inputMode="decimal" defaultValue="0" /></div>
        </div>
        <div className="grid g4">
          <div className="field"><label>Additional fee (optional)</label><input name="fee_description" placeholder="Environmental fee" /></div>
          <div className="field"><label>Fee amount</label><input name="fee_amount" inputMode="decimal" /></div>
          <div className="field"><label>Fee frequency</label><select name="fee_frequency"><option value="per_period">Every billing period</option><option value="one_time">One time</option></select></div>
          <div className="field"><label className="check" style={{ marginTop: 22 }}><input type="checkbox" name="fee_taxable" defaultChecked /> Fee taxable</label></div>
        </div>
        <h2>Original rental agreement</h2>
        <div className="field"><input type="file" name="agreement" accept=".pdf,.png,.jpg,.jpeg" /></div>
        <div className="field"><label>Internal notes</label><textarea name="internal_notes" rows={2} /></div>
        <button className="btn-primary">Create rental</button>
      </form>
    </>
  );
}
