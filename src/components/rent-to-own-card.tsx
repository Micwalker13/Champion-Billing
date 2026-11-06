import { purchaseOptionStatus } from "@/lib/services/rent-to-own";
import { fmtUSD } from "@/lib/money";
import { fmtDate, todayCentral } from "@/lib/dates";
import { cancelRtoAction, exerciseRtoAction, setUpRtoAction } from "@/app/actions";

/** Rent-to-own on a rental: set it up, watch the credit build from on-time rent, and convert it to a sale. */
export async function RentToOwnCard({ lineId, lineStatus, onRentDate, canManage, back }: { lineId: string; lineStatus: string; onRentDate: string; canManage: boolean; back: string }) {
  const s = await purchaseOptionStatus(lineId);
  const H = () => <><input type="hidden" name="line_id" value={lineId} /><input type="hidden" name="back" value={`${back}#rto`} /></>;
  const open = ["active", "off_rent"].includes(lineStatus);
  if (!s || s.option.status === "cancelled") {
    if (!open) return null;
    return (
      <div className="card" id="rto">
        <h2>Rent-to-own</h2>
        {s?.option.status === "cancelled" && <p className="small muted">An earlier rent-to-own was cancelled: {s.option.cancel_reason}</p>}
        <p className="small muted">Set a purchase price, the percent of rent that counts toward it, and the number of months. Only rent paid on time (within 30 days of the invoice date) counts. Rent means the rental charge only, not tax, delivery, fees or the damage waiver.</p>
        {canManage ? <details><summary>Set up rent-to-own</summary><form action={setUpRtoAction}><H />
          <div className="grid g4">
            <div className="field"><label>Purchase price ($)</label><input name="purchase_price" inputMode="decimal" required /></div>
            <div className="field"><label>Percent of rent that counts</label><input name="credit_percent" inputMode="decimal" placeholder="80" required /></div>
            <div className="field"><label>Months</label><input name="term_months" type="number" min={1} max={120} required /></div>
            <div className="field"><label>Starts</label><input name="starts_on" type="date" defaultValue={onRentDate} min={onRentDate} required /></div>
          </div>
          <div className="field"><label>Notes</label><input name="notes" maxLength={1000} /></div>
          <button type="submit">Save rent-to-own</button>
        </form></details> : <p className="small muted">A billing manager or administrator sets this up.</p>}
      </div>
    );
  }
  const o = s.option;
  const pct = `${(Number(o.credit_pct) * 100).toFixed(2).replace(/\.00$/, "")}%`;
  return (
    <div className="card" id="rto">
      <h2>Rent-to-own</h2>
      <div className="muted small">{fmtUSD(o.purchase_price)} price · {pct} of on-time rent counts · {o.term_months} months, {fmtDate(o.starts_on)} to {fmtDate(o.ends_on)}{o.notes ? ` · ${o.notes}` : ""}</div>
      {o.status === "exercised" && <div className="alert alert-ok" style={{ marginTop: 8 }}>Converted to a sale{o.sale_number ? ` (${o.sale_number})` : " (draft)"}: <a href={`/sales/${o.sale_id}`}>open the sale</a>. Credit applied: {fmtUSD(o.credit_at_exercise)}.</div>}
      {s.ready && <div className="alert alert-warn" style={{ marginTop: 8 }}>{s.readyText}</div>}
      <div className="grid g4" style={{ marginTop: 10 }}>
        <div><div className="muted small">On-time rent</div><div style={{ fontWeight: 700, fontSize: 18 }}>{fmtUSD(s.rentCounted)}</div></div>
        <div><div className="muted small">Credit toward purchase</div><div style={{ fontWeight: 700, fontSize: 18 }}>{fmtUSD(s.credit)}</div></div>
        <div><div className="muted small">{s.termEnded ? "Balloon payment" : "Left to buy it"}</div><div style={{ fontWeight: 700, fontSize: 18 }}>{fmtUSD(s.balance)}</div></div>
        <div><div className="muted small">Term ends</div><div style={{ fontWeight: 700, fontSize: 18 }}>{fmtDate(o.ends_on)}</div></div>
      </div>
      {s.invoices.length > 0 && <div className="table-wrap" style={{ marginTop: 10 }}><table className="small"><thead><tr><th>Invoice</th><th>Date</th><th className="num">Rent</th><th className="num">Counts</th><th>Why</th></tr></thead><tbody>
        {s.invoices.map((i) => <tr key={i.id} className={i.on_time ? "" : "muted"}><td><a href={`/invoices/${i.id}`}>{i.invoice_number}</a></td><td>{fmtDate(i.invoice_date)}</td><td className="num">{fmtUSD(i.rent)}</td><td className="num">{fmtUSD(i.counted)}</td><td>{i.why}</td></tr>)}
      </tbody></table></div>}
      {o.status === "active" && canManage && <div className="grid g2" style={{ marginTop: 10 }}>
        <form action={exerciseRtoAction} className="card" style={{ marginBottom: 0 }}><H />
          <strong>Convert to a sale</strong>
          <p className="small muted">First call off the rental with the purchase date and bill its final rent. This then ends the rental and creates a draft sale for {fmtUSD(s.balance)} (price less credit) for you to review and finalize.</p>
          <button type="submit" className="btn-primary" disabled={lineStatus !== "off_rent"}>Convert to sale</button>
          {lineStatus !== "off_rent" && <div className="small muted">Available once the rental is called off.</div>}
        </form>
        <form action={cancelRtoAction} className="card" style={{ marginBottom: 0 }}><H />
          <strong>Cancel rent-to-own</strong>
          <div className="field"><label>Reason</label><input name="reason" required minLength={5} /></div>
          <button type="submit">Cancel it</button>
        </form>
      </div>}
      <p className="small muted" style={{ marginBottom: 0 }}>Checked as of {fmtDate(todayCentral())}. An invoice counts once it is fully paid within 30 days of its invoice date.</p>
    </div>
  );
}
