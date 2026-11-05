import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { fmtUSD } from "@/lib/money";
import { fmtDate, todayCentral } from "@/lib/dates";
import { RATE_BASIS_LABELS } from "@/lib/billing";
import { Empty, Flash } from "@/components/ui";
import { QUOTE_STATUS_LABELS, RES_STATUS_LABELS, quoteDetail } from "@/lib/services/dispatch";
import { acceptQuoteAction, addQuoteLineAction, declineQuoteAction, removeQuoteLineAction, sendQuoteAction } from "../../../actions";

export default async function QuotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^\d+$/.test(id)) notFound();
  const d = await quoteDetail(id);
  if (!d) notFound();
  const { qt, lines, reservations } = d;
  const edit = can(user, "edit_records");
  const H = ({ children }: { children: React.ReactNode }) => <><input type="hidden" name="quote_id" value={id} /><input type="hidden" name="back" value={`/quotes/${id}`} />{children}</>;
  const expired = qt.valid_until < todayCentral();
  return (
    <>
      <div className="topbar"><div>
        <div className="muted small"><a href="/quotes">Quotes</a></div>
        <h1>{qt.quote_number} <span className="badge">{QUOTE_STATUS_LABELS[qt.status]}</span>{expired && qt.status === "sent" && <span className="badge b-warn" style={{ marginLeft: 6 }}>Expired</span>}</h1>
        <div className="muted">{qt.customer_name} · {fmtDate(qt.quote_date)} · good through {fmtDate(qt.valid_until)}{qt.contact ? ` · Attn ${qt.contact}` : ""}</div>
      </div><a className="btn btn-primary" href={`/api/quotes/${id}/pdf`} target="_blank" rel="noopener">Quote PDF</a></div>
      <Flash sp={sp} />
      <div className="card">
        <h2>Equipment</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Equipment</th><th>Unit</th><th>Dates</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Delivery / pickup</th>{edit && qt.status === "draft" && <th />}</tr></thead>
          <tbody>{lines.map((l: any) => <tr key={l.id}><td>{l.description}{l.category && <div className="small muted">{l.category}</div>}{(d.fees[l.id] ?? []).length > 0 && <div className="small muted">Plus per unit: {d.fees[l.id].map((f) => `${f.description} ${fmtUSD(f.amount)}`).join("; ")}</div>}</td><td className="mono">{l.unit_number ?? "Any"}</td>
            <td>{fmtDate(l.start_date)} – {l.end_date ? fmtDate(l.end_date) : "open"}</td><td className="num">{l.quantity}</td><td className="num">{fmtUSD(l.rate_amount)} {RATE_BASIS_LABELS[l.rate_basis as keyof typeof RATE_BASIS_LABELS]}</td>
            <td className="num">{fmtUSD(l.delivery_charge)} / {fmtUSD(l.pickup_charge)}</td>
            {edit && qt.status === "draft" && <td><form action={removeQuoteLineAction} className="inline"><H><input type="hidden" name="line_id" value={l.id} /><button className="btn-sm">Remove</button></H></form></td>}</tr>)}</tbody>
        </table>{!lines.length && <Empty>No equipment on this quote yet.</Empty>}</div>
        {edit && qt.status === "draft" && (
          <form action={addQuoteLineAction} style={{ marginTop: 10 }}><H>
            <div className="row">
              <div className="field" style={{ flexBasis: 220 }}><label>Equipment</label><input name="description" required placeholder="e.g. 10K telehandler" /></div>
              <div className="field"><label>Category</label><input name="category" /></div>
              <div className="field"><label>Specific unit</label><input name="unit_number" placeholder="Optional" style={{ width: 110 }} /></div>
              <div className="field"><label>Qty</label><input name="quantity" defaultValue="1" inputMode="numeric" style={{ width: 60 }} /></div>
              <div className="field"><label>Rate</label><input name="rate_amount" required inputMode="decimal" style={{ width: 100 }} /></div>
              <div className="field"><label>Per</label><select name="rate_basis" defaultValue="monthly">{Object.entries(RATE_BASIS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
              <div className="field"><label>Start</label><input type="date" name="start_date" required /></div>
              <div className="field"><label>End</label><input type="date" name="end_date" /></div>
              <div className="field"><label>Delivery</label><input name="delivery_charge" inputMode="decimal" style={{ width: 90 }} /></div>
              <div className="field"><label>Pickup</label><input name="pickup_charge" inputMode="decimal" style={{ width: 90 }} /></div>
            </div>
            <button style={{ marginTop: 8 }}>Add to quote</button>
          </H></form>)}
      </div>
      {edit && ["draft", "sent"].includes(qt.status) && (
        <div className="card">
          <h2>Next step</h2>
          <div className="actions">
            {qt.status === "draft" && <form action={sendQuoteAction} className="inline"><H><button className="btn-primary">Mark as sent to customer</button></H></form>}
            {qt.status === "sent" && <form action={acceptQuoteAction} className="row"><H><div className="field"><input name="note" placeholder="How they accepted (e.g. Pat by phone)" /></div><button className="btn-primary" disabled={expired}>Customer accepted: reserve equipment</button></H></form>}
            <form action={declineQuoteAction} className="row"><H><div className="field"><input name="note" placeholder="Reason (optional)" /></div><button>Declined</button></H></form>
          </div>
          {qt.status === "draft" && <p className="small muted">Sending locks the prices. Download the PDF above to email it.</p>}
        </div>)}
      {qt.decided_note && <p className="muted">Decision note: {qt.decided_note}</p>}
      {reservations.length > 0 && (
        <div className="card">
          <h2>Reservations from this quote</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Equipment</th><th>Unit</th><th>Dates</th><th>Status</th></tr></thead>
            <tbody>{reservations.map((r: any) => <tr key={r.id}><td>{r.description}</td><td className="mono">{r.unit_number ?? "Not picked"}</td><td>{fmtDate(r.start_date)} – {r.end_date ? fmtDate(r.end_date) : "open"}</td>
              <td>{RES_STATUS_LABELS[r.status]}{r.contract_line_id && <> · <a href={`/rentals/${r.contract_line_id}`}>rental</a></>}</td></tr>)}</tbody>
          </table></div>
          <p className="small"><a href="/reservations">Manage reservations</a></p>
        </div>)}
    </>
  );
}
