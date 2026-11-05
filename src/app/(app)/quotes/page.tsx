import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { q } from "@/lib/db";
import { fmtDate, todayCentral } from "@/lib/dates";
import { Empty, Flash } from "@/components/ui";
import { QUOTE_STATUS_LABELS, listQuotes } from "@/lib/services/dispatch";
import { createQuoteAction } from "../../actions";

const QUOTE_CLASS: Record<string, string> = { draft: "", sent: "b-info", accepted: "b-ok", declined: "b-bad" };

export default async function Quotes({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const [quotes, customers] = await Promise.all([listQuotes(), q(`SELECT id, name FROM customers WHERE active ORDER BY name`)]);
  const today = todayCentral();
  return (
    <>
      <div className="topbar"><div><h1>Quotes</h1><div className="muted">Price equipment for a customer. When they accept, the equipment is reserved for their dates; see Reservations.</div></div></div>
      <Flash sp={sp} />
      <div className="table-wrap"><table>
        <thead><tr><th>Quote</th><th>Customer</th><th>Date</th><th>Good through</th><th>Lines</th><th>Status</th></tr></thead>
        <tbody>{quotes.map((x: any) => <tr key={x.id}><td><a href={`/quotes/${x.id}`}>{x.quote_number}</a></td><td>{x.customer_name}</td><td>{fmtDate(x.quote_date)}</td>
          <td>{fmtDate(x.valid_until)}{x.status === "sent" && x.valid_until < today && <span className="badge b-warn" style={{ marginLeft: 6 }}>Expired</span>}</td><td>{x.lines}</td>
          <td><span className={`badge ${QUOTE_CLASS[x.status]}`}>{QUOTE_STATUS_LABELS[x.status]}</span></td></tr>)}</tbody>
      </table>{!quotes.length && <Empty>No quotes yet.</Empty>}</div>
      {can(user, "edit_records") && (
        <form className="card" action={createQuoteAction}>
          <h2>New quote</h2><input type="hidden" name="back" value="/quotes" />
          <div className="row">
            <div className="field"><label>Customer</label><select name="customer_id" required defaultValue=""><option value="" disabled>Choose…</option>{customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div className="field"><label>Good for (days)</label><input name="valid_days" defaultValue="30" inputMode="numeric" style={{ width: 90 }} /></div>
            <div className="field"><label>Attention</label><input name="contact" /></div>
          </div>
          <div className="field"><label>Jobsite</label><textarea name="jobsite" rows={2} /></div>
          <div className="field"><label>Notes printed on the quote</label><textarea name="notes" rows={2} /></div>
          <button className="btn-primary" style={{ marginTop: 8 }}>Start quote</button>
        </form>)}
    </>
  );
}
