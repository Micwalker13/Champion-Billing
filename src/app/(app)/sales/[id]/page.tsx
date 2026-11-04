import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { fmtUSD, dec } from "@/lib/money";
import { fmtDate, todayCentral } from "@/lib/dates";
import { Flash, StatusBadge } from "@/components/ui";
import { saleDetail } from "@/lib/services/sales";
import { finalizeSaleAction, salePaymentAction, voidSaleAction } from "../../../actions";

export default async function SalePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const d = await saleDetail(id);
  if (!d) notFound();
  const { sale, payments } = d;
  const back = `/sales/${id}`;
  const balance = dec(sale.total).sub(sale.amount_paid);
  const H = () => <><input type="hidden" name="sale_id" value={id} /><input type="hidden" name="back" value={back} /></>;
  const taxPct = (Number(sale.tax_rate) * 100).toFixed(3).replace(/\.?0+$/, "");
  return (
    <>
      <div className="topbar">
        <div><div className="muted small"><a href="/sales">Equipment sales</a></div>
          <h1>{sale.sale_number ?? `Draft sale #${sale.id}`} <StatusBadge status={sale.status} /></h1>
          <div className="muted">Unit <a href={`/equipment/${sale.equipment_id}`}>{sale.unit_number}</a> · {sale.description} to {sale.customer_name}</div></div>
        <div className="actions"><a className="btn" href={`/api/sales/${id}/pdf`} target="_blank" rel="noopener">{sale.finalized_at ? "Invoice PDF" : "Preview PDF"}</a></div>
      </div>
      <Flash sp={sp} />
      <div className="grid g2">
        <div className="card">
          <h2>Sale</h2>
          <dl className="kv">
            <dt>Customer</dt><dd><a href={`/customers/${sale.customer_id}`}>{sale.customer_name}</a> ({sale.customer_code})</dd>
            <dt>Unit</dt><dd>{sale.unit_number} · {[sale.year, sale.make, sale.model].filter(Boolean).join(" ")} {sale.description}{sale.serial_number ? ` · S/N ${sale.serial_number}` : ""}</dd>
            <dt>Hours at sale</dt><dd>{sale.hours_at_sale ?? "—"}</dd>
            <dt>Price</dt><dd>{fmtUSD(sale.price)}</dd>
            <dt>Freight</dt><dd>{fmtUSD(sale.freight)}</dd>
            <dt>Sales tax</dt><dd>{sale.taxable ? `${taxPct}%: ${fmtUSD(sale.tax_amount)}` : "Exempt"}</dd>
            <dt>Total</dt><dd><b>{fmtUSD(sale.total)}</b></dd>
            <dt>Terms</dt><dd>{Number(sale.terms_days) === 0 ? "Due on receipt" : `Net ${sale.terms_days}`}</dd>
            <dt>Invoice date / due</dt><dd>{fmtDate(sale.sale_date)} / {fmtDate(sale.due_date)}</dd>
            <dt>Notes</dt><dd style={{ whiteSpace: "pre-line" }}>{sale.notes ?? "—"}</dd>
            <dt>Created</dt><dd>{sale.created_by_name}</dd>
            {sale.finalized_by_name && <><dt>Finalized</dt><dd>{sale.finalized_by_name}, {new Date(sale.finalized_at).toLocaleString("en-US", { timeZone: "America/Chicago" })}</dd></>}
            {sale.voided_by_name && <><dt>Voided</dt><dd>{sale.voided_by_name}: {sale.void_reason}</dd></>}
          </dl>
        </div>
        <div className="card">
          {sale.status === "draft" && <>
            <h2>Finalize</h2>
            <p className="small muted">Finalizing gives the sale the next invoice number, stores the PDF so it can never change, and marks the unit sold so it can&rsquo;t be rented. To change the price, void this draft and start again.</p>
            {can(user, "approve_invoice") ? <form action={finalizeSaleAction}><H /><button className="btn-primary">Finalize sale</button></form> : <p className="muted small">A billing manager finalizes sales.</p>}
          </>}
          {["issued", "partially_paid"].includes(sale.status) && can(user, "record_payment") && <>
            <h2>Record a payment</h2>
            <p className="small muted">Balance due {fmtUSD(balance.toFixed(2))}.</p>
            <form action={salePaymentAction}><H />
              <div className="row">
                <div className="field"><label>Amount</label><input name="amount" required inputMode="decimal" defaultValue={balance.toFixed(2)} /></div>
                <div className="field"><label>Date</label><input type="date" name="paid_on" required defaultValue={todayCentral()} /></div>
                <div className="field"><label>Method</label><select name="method"><option>Check</option><option>ACH</option><option>Wire</option><option>Card</option><option>Financing</option></select></div>
                <div className="field"><label>Reference</label><input name="reference" /></div>
              </div>
              <button className="btn-primary" style={{ marginTop: 8 }}>Record payment</button>
            </form>
          </>}
          {payments.length > 0 && <><h2 style={{ marginTop: 14 }}>Payments</h2>{payments.map((p: any) => <div key={p.id}>{fmtDate(p.paid_on)} · {fmtUSD(p.amount)} · {[p.method, p.reference].filter(Boolean).join(" ")}</div>)}</>}
          {sale.status !== "voided" && dec(sale.amount_paid).eq(0) && can(user, "void_invoice") && (
            <details style={{ marginTop: 14 }}><summary>Void this sale</summary>
              <form action={voidSaleAction} className="row" style={{ marginTop: 6 }}><H /><input name="reason" required minLength={5} placeholder="Reason" /><button className="btn-danger">Void</button></form>
              <p className="small muted">{sale.finalized_at ? "The invoice number and PDF are kept; the unit becomes available again." : "The draft is cancelled."}</p>
            </details>)}
        </div>
      </div>
    </>
  );
}
