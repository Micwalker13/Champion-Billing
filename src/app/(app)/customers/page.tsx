import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { q } from "@/lib/db";
import { BILLING_METHOD_LABELS } from "@/lib/billing";
import { Flash } from "@/components/ui";
import { createCustomerAction } from "../../actions";

export default async function Customers({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const rows = await q(`SELECT c.*, p.billing_method, p.require_monthly_po, p.proration_policy,
                          (SELECT count(*) FROM rental_contract_lines l JOIN rental_contracts rc ON rc.id=l.contract_id WHERE rc.customer_id=c.id AND l.status IN ('active','off_rent'))::int AS active
                        FROM customers c JOIN customer_billing_profiles p ON p.customer_id=c.id ORDER BY c.name`);
  return (
    <>
      <div className="topbar"><h1>Customers</h1></div>
      <Flash sp={sp} />
      <div className="table-wrap" style={{ marginBottom: 16 }}><table>
        <thead><tr><th>Customer</th><th>ID</th><th>Billing</th><th>Monthly PO</th><th>Proration</th><th className="num">Active rentals</th></tr></thead>
        <tbody>{rows.map((c: any) => <tr key={c.id}><td><a href={`/customers/${c.id}`}>{c.name}</a></td><td className="mono">{c.customer_code}</td><td>{BILLING_METHOD_LABELS[c.billing_method as keyof typeof BILLING_METHOD_LABELS]}</td>
          <td>{c.require_monthly_po ? <span className="badge b-accent">Required</span> : "—"}</td><td>{c.proration_policy === "unapproved" ? <span className="badge b-warn">Not approved</span> : c.proration_policy.replace(/_/g, " ")}</td><td className="num">{c.active}</td></tr>)}</tbody>
      </table></div>
      {can(user, "edit_records") && <form className="card" action={createCustomerAction}>
        <h2>Add customer</h2><input type="hidden" name="back" value="/customers" />
        <div className="grid g3">
          <div className="field"><label>Customer ID</label><input name="customer_code" required /></div>
          <div className="field"><label>Name</label><input name="name" required /></div>
          <div className="field"><label>AP email</label><input name="email" type="email" /></div>
          <div className="field"><label>Phone</label><input name="phone" /></div>
          <div className="field" style={{ gridColumn: "span 2" }}><label>Billing address</label><textarea name="billing_address" rows={2} required /></div>
        </div>
        <button className="btn-primary">Add customer</button>
      </form>}
    </>
  );
}
