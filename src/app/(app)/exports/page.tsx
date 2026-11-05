import { requireUser } from "@/lib/session";

export default async function Exports() {
  await requireUser("export_data");
  const items: Array<[string, string, string]> = [
    ["invoices", "Invoices", "Every invoice with its PO, billing period, totals, status and PDF fingerprint."],
    ["po-assignments", "PO assignments", "Full PO history per machine and month, including superseded and corrected POs."],
    ["rentals", "Rentals", "All rental agreements, units, dates, rates and Quipli references."],
    ["fee-lines", "Fees and taxes", "Every fee and tax line on finalized invoices and sales, with its code, accounting class (regulatory tax or business surcharge) and GL account."],
    ["audit", "Audit log", "Every change: who, when, before and after."],
  ];
  return (
    <>
      <div className="topbar"><div><h1>Exports</h1><div className="muted">CSV files open in Excel. Each export is recorded in the audit log.</div></div></div>
      <div className="grid g2">{items.map(([k, t, d]) => <div className="card" key={k}><h2>{t}</h2><p className="muted">{d}</p><a className="btn" href={`/api/export/${k}`}>Download CSV</a></div>)}</div>
    </>
  );
}
