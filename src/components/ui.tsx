import { STATUS_LABELS } from "@/lib/services/invoices";
import { UNIT_STATUS_LABELS } from "@/lib/services/inventory";

export function Flash({ sp }: { sp: { msg?: string; err?: string } }) {
  return <>
    {sp.msg && <div className="alert alert-ok" role="status">{sp.msg}</div>}
    {sp.err && <div className="alert alert-bad" role="alert">{sp.err}</div>}
  </>;
}

const STATUS_CLASS: Record<string, string> = {
  draft: "", pending_review: "b-info", rejected: "b-bad", approved: "b-ok", issued: "b-accent", partially_paid: "b-warn",
  paid: "b-ok", overdue: "b-bad", voided: "", corrected: "",
};
export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_CLASS[status] ?? ""}`}>{STATUS_LABELS[status] ?? status}</span>;
}

const RENTAL_CLASS: Record<string, string> = { active: "b-ok", off_rent: "b-warn", returned: "", closed: "" };
export function RentalBadge({ status }: { status: string }) {
  return <span className={`badge ${RENTAL_CLASS[status] ?? ""}`}>{status.replace("_", "-").replace(/^./, (c) => c.toUpperCase())}</span>;
}

export function Kpi({ label, value, sub, tone, href }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "ok" | "warn" | "bad"; href?: string }) {
  const body = <div className={`kpi ${tone ?? ""}`}><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
  return href ? <a href={href} style={{ color: "inherit", textDecoration: "none" }}>{body}</a> : body;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="muted" style={{ padding: 16, textAlign: "center" }}>{children}</div>;
}

const UNIT_CLASS: Record<string, string> = { on_rent: "b-accent", available: "b-ok", in_shop: "b-warn", sold: "", retired: "" };
export function UnitStatus({ status }: { status: string }) {
  return <span className={`badge ${UNIT_CLASS[status] ?? ""}`}>{UNIT_STATUS_LABELS[status] ?? status}</span>;
}

const WO_CLASS: Record<string, string> = { open: "b-info", in_progress: "b-accent", waiting_parts: "b-warn", completed: "b-ok", cancelled: "" };
const WO_LABELS: Record<string, string> = { open: "Open", in_progress: "In progress", waiting_parts: "Waiting on parts", completed: "Completed", cancelled: "Cancelled" };
export function WoStatus({ status }: { status: string }) {
  return <span className={`badge ${WO_CLASS[status] ?? ""}`}>{WO_LABELS[status] ?? status}</span>;
}
const DUE_CLASS: Record<string, string> = { overdue: "b-bad", due_soon: "b-warn", ok: "b-ok", unknown: "" };
const DUE_TEXT: Record<string, string> = { overdue: "Overdue", due_soon: "Due soon", ok: "OK", unknown: "Needs last-done reading" };
export function DueBadge({ status }: { status: string }) {
  return <span className={`badge ${DUE_CLASS[status] ?? ""}`}>{DUE_TEXT[status] ?? status}</span>;
}
