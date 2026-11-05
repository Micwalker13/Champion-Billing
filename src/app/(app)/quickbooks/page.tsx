import { requireUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { Flash } from "@/components/ui";
import { fmtDate } from "@/lib/dates";
import { ENTITY_LABELS, JOB_STATUS_LABELS, qboLists, qboOverview, recentQboJobs } from "@/lib/services/quickbooks";
import { q } from "@/lib/db";
import { qboDisconnectAction, qboMappingAction, qboRetryAction, qboSettingsAction, qboSyncNowAction } from "../../actions";

type Opt = { id: string; name: string };

function MapRow({ kind, localKey, label, current, options }: { kind: string; localKey: string; label: string; current?: { qbo_id: string; qbo_name: string }; options: Opt[] | null }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{current ? current.qbo_name : <span className="badge b-warn">Not matched</span>}</td>
      <td>{options && (
        <form action={qboMappingAction} className="row">
          <input type="hidden" name="kind" value={kind} /><input type="hidden" name="local_key" value={localKey} /><input type="hidden" name="back" value="/quickbooks" />
          <select name="qbo" defaultValue={current ? `${current.qbo_id}|${current.qbo_name}` : ""}>
            <option value="">(not matched)</option>
            {options.map((o) => <option key={o.id} value={`${o.id}|${o.name}`}>{o.name}</option>)}
          </select>
          <button className="btn-sm">Save</button>
        </form>)}</td>
    </tr>
  );
}

export default async function QuickBooksPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const me = await requireUser("run_quickbooks_sync");
  const admin = can(me, "manage_quickbooks");
  const sp = await searchParams;
  const o = await qboOverview();
  let lists: Awaited<ReturnType<typeof qboLists>> = null, listError = "";
  if (o.conn && admin) { try { lists = await qboLists(); } catch (e: any) { listError = e?.message ?? String(e); } }
  const jobs = await recentQboJobs(50);
  const customers = await q(`SELECT id, name FROM customers WHERE active ORDER BY name`);
  const map = (kind: string, key: string) => o.mappings.find((m: any) => m.kind === kind && m.local_key === key);
  const attention = o.counts.needs_attention ?? 0;

  return (
    <>
      <div className="topbar"><h1>QuickBooks</h1></div>
      <Flash sp={sp} />
      <p className="muted">Finalized invoices, credit memos, payments and voids are sent to QuickBooks Online, once each. Nothing in QuickBooks ever changes an invoice here.</p>

      <div className="card">
        <h2>Connection</h2>
        {!o.configured ? (
          <div className="alert alert-warn">The QuickBooks app keys aren&apos;t set on the server yet. An administrator adds <code>QBO_CLIENT_ID</code> and <code>QBO_CLIENT_SECRET</code> in Vercel (see docs/QUICKBOOKS.md), then redeploys.</div>
        ) : o.conn ? (
          <>
            <p>Connected to <b>{o.conn.company_name ?? `company ${o.conn.realm_id}`}</b>{o.conn.environment === "sandbox" && <> <span className="badge b-warn">Sandbox (test company)</span></>} by {o.conn.connected_by_name ?? "an administrator"} on {fmtDate(new Date(o.conn.connected_at).toISOString().slice(0, 10))}.</p>
            {admin && <form action={qboDisconnectAction} className="inline"><input type="hidden" name="back" value="/quickbooks" /><button className="btn-sm">Disconnect</button></form>}
          </>
        ) : (
          <p>Not connected. {admin ? <a className="btn btn-primary" href="/api/qbo/connect">Connect to QuickBooks</a> : "Ask an administrator to connect QuickBooks."}</p>
        )}
      </div>

      <form className="card" action={qboSettingsAction}>
        <h2>Sync</h2><input type="hidden" name="back" value="/quickbooks" />
        <div className="grid g3">
          <div className="field"><label>Send items dated on or after</label><input type="date" name="sync_from" defaultValue={o.settings?.sync_from ?? ""} disabled={!admin} /></div>
        </div>
        <label className="check"><input type="checkbox" name="enabled" defaultChecked={o.settings?.enabled} disabled={!admin} /> Sync is on</label>
        {admin && <button className="btn-primary">Save</button>}
        <p className="small muted">Pick the first date you have <b>not</b> already typed into QuickBooks by hand. Anything earlier is never sent. If an invoice number already exists in QuickBooks with the same total, it is linked instead of sent again.</p>
      </form>

      {admin && o.conn && (
        <div className="card">
          <h2>Match items</h2>
          {listError && <div className="alert alert-bad">Couldn&apos;t load lists from QuickBooks: {listError}</div>}
          <p className="small muted">Each kind of invoice line goes to a QuickBooks product or service. Sales tax is sent as its own line, using the amount Champion worked out.</p>
          <div className="table-wrap"><table><thead><tr><th>Champion line</th><th>QuickBooks item</th><th></th></tr></thead><tbody>
            {o.itemKeys.map((k) => <MapRow key={k.key} kind="item" localKey={k.key} label={k.label} current={map("item", k.key)} options={lists?.items ?? null} />)}
          </tbody></table></div>
          <h2 style={{ marginTop: 16 }}>Match customers</h2>
          <p className="small muted">A customer with exactly the same name in QuickBooks is matched automatically the first time it&apos;s needed.</p>
          <div className="table-wrap"><table><thead><tr><th>Champion customer</th><th>QuickBooks customer</th><th></th></tr></thead><tbody>
            {customers.map((c: any) => <MapRow key={c.id} kind="customer" localKey={String(c.id)} label={c.name} current={map("customer", String(c.id))} options={lists?.customers ?? null} />)}
          </tbody></table></div>
          <h2 style={{ marginTop: 16 }}>Payments</h2>
          <div className="table-wrap"><table><tbody>
            <MapRow kind="deposit_account" localKey="default" label="Deposit payments to (blank = Undeposited Funds)" current={map("deposit_account", "default")} options={lists?.depositAccounts ?? null} />
          </tbody></table></div>
        </div>
      )}

      <div className="card">
        <h2>Queue</h2>
        <p>{o.counts.synced ?? 0} in QuickBooks · {o.counts.pending ?? 0} waiting · {attention ? <b>{attention} need attention</b> : "0 need attention"} · {o.counts.skipped ?? 0} not sent</p>
        {o.settings?.enabled && <form action={qboSyncNowAction} className="inline"><input type="hidden" name="back" value="/quickbooks" /><button className="btn-sm">Sync now</button></form>}
        <div className="table-wrap" style={{ marginTop: 8 }}><table><thead><tr><th>What</th><th>Invoice</th><th>Status</th><th>Details</th><th>Tries</th><th></th></tr></thead><tbody>
          {jobs.map((j: any) => (
            <tr key={j.id}>
              <td>{ENTITY_LABELS[j.entity]}{j.credit_number ? ` ${j.credit_number}` : ""}{j.payment_amount ? ` $${j.payment_amount}` : ""}</td>
              <td>{j.invoice_number}</td>
              <td><span className={`badge ${j.status === "synced" ? "b-ok" : j.status === "needs_attention" ? "b-bad" : j.status === "pending" ? "b-warn" : ""}`}>{JOB_STATUS_LABELS[j.status]}</span></td>
              <td className="small">{j.last_error}</td>
              <td>{j.attempts}</td>
              <td>{["needs_attention", "skipped"].includes(j.status) && <form action={qboRetryAction} className="inline"><input type="hidden" name="job_id" value={j.id} /><input type="hidden" name="back" value="/quickbooks" /><button className="btn-sm">Retry</button></form>}</td>
            </tr>))}
          {!jobs.length && <tr><td colSpan={6} className="muted">Nothing queued yet. Invoices are queued when they&apos;re approved.</td></tr>}
        </tbody></table></div>
      </div>
    </>
  );
}
