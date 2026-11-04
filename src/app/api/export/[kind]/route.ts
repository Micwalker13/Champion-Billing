import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { audit, pool, q } from "@/lib/db";
import { isIsoDate, todayCentral } from "@/lib/dates";
import { BUCKET_LABELS, agingReport, rentalActivity } from "@/lib/services/reports";

// Exports computed in code rather than one SQL query.
const COMPUTED: Record<string, (sp: URLSearchParams) => Promise<any[]>> = {
  aging: async (sp) => {
    const asOf = isIsoDate(sp.get("asOf") ?? "") ? sp.get("asOf")! : todayCentral();
    const r = await agingReport(asOf);
    return r.invoices.map((i) => ({ as_of: asOf, customer: i.customer_name, customer_code: i.customer_code, invoice_number: i.invoice_number, status: i.status, unit: i.unit,
      rental_agreement: i.contract, po_number: i.po_number, period_start: i.period_start, period_end: i.period_end, invoice_date: i.invoice_date, due_date: i.due_date,
      days_past_due: i.days_past_due, aging_bucket: BUCKET_LABELS[i.bucket], total: i.total, amount_paid: i.amount_paid, balance: i.balance }));
  },
  "rental-activity": async (sp) => {
    const m = sp.get("month") ?? "";
    const month = /^\d{4}-\d{2}$/.test(m) ? `${m}-01` : `${todayCentral().slice(0, 7)}-01`;
    const c = sp.get("customer");
    const r = await rentalActivity(month, c && /^\d+$/.test(c) ? c : null);
    return r.rows.map((x: any) => ({ month: month.slice(0, 7), customer: x.customer_name, rental_agreement: x.contract_number, unit: x.unit_number, description: x.description,
      status: x.status, on_rent_date: x.on_rent_date, billing_start_date: x.billing_start_date, off_rent_date: x.off_rent_date, days_on_rent_in_month: x.days_on_rent,
      rate: x.rate_amount, rate_basis: x.rate_basis, billed_through: x.billed_through, billed_this_month: x.billed_this_month, billed_to_date: x.billed_to_date, paid_to_date: x.paid_to_date }));
  },
};

// CSV cells that start with = + - @ are prefixed so spreadsheets never execute them as formulas.
const cell = (v: unknown) => {
  if (v == null) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows: any[]) => rows.length ? [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.values(r).map(cell).join(","))].join("\r\n") + "\r\n" : "no rows\r\n";

const QUERIES: Record<string, { sql: string; params?: (sp: URLSearchParams) => unknown[] }> = {
  invoices: {
    sql: `SELECT i.id, i.invoice_number, i.status, c.customer_code, c.name AS customer, i.snapshot->'contract'->>'number' AS rental_agreement, i.snapshot->'equipment'->>'unit_number' AS unit,
                 i.po_number, i.snapshot->>'job_number' AS job, i.snapshot->>'work_order_number' AS work_order, i.period_start, i.period_end, i.invoice_date, i.due_date,
                 i.subtotal, i.tax_amount, i.total, i.amount_paid, i.revision_no, i.pdf_sha256
          FROM invoices i JOIN customers c ON c.id=i.customer_id
          WHERE ($1::bigint IS NULL OR i.customer_id=$1) AND ($2::text IS NULL OR i.status=$2) AND ($3::date IS NULL OR (i.period_start <= ($3::date + interval '1 month' - interval '1 day') AND i.period_end >= $3::date))
          ORDER BY i.period_start, unit`,
    params: (sp) => [sp.get("customer") || null, sp.get("status") || null, /^\d{4}-\d{2}$/.test(sp.get("month") ?? "") ? `${sp.get("month")}-01` : null],
  },
  "po-assignments": {
    sql: `SELECT a.id, c.name AS customer, e.unit_number, rc.contract_number, bp.period_start, bp.period_end, p.po_number, p.estimated_total, a.job_number, a.work_order_number,
                 a.status, a.source, a.reason, u.name AS assigned_by, a.assigned_at, ue.name AS ended_by, a.ended_at, a.superseded_by
          FROM po_assignments a JOIN purchase_orders p ON p.id=a.purchase_order_id JOIN customers c ON c.id=a.customer_id JOIN equipment e ON e.id=a.equipment_id
          JOIN billing_periods bp ON bp.id=a.billing_period_id JOIN rental_contract_lines l ON l.id=a.contract_line_id JOIN rental_contracts rc ON rc.id=l.contract_id
          LEFT JOIN users u ON u.id=a.assigned_by LEFT JOIN users ue ON ue.id=a.ended_by ORDER BY bp.period_start, e.unit_number, a.id`,
  },
  rentals: {
    sql: `SELECT rc.contract_number, c.name AS customer, e.unit_number, e.description, e.serial_number, l.status, l.on_rent_date, l.billing_start_date, l.off_rent_date, l.returned_date,
                 l.rate_amount, l.rate_basis, rc.job_number, rc.work_order_number, j.address AS jobsite, rc.quipli_reference
          FROM rental_contract_lines l JOIN rental_contracts rc ON rc.id=l.contract_id JOIN customers c ON c.id=rc.customer_id JOIN equipment e ON e.id=l.equipment_id LEFT JOIN jobsites j ON j.id=rc.jobsite_id
          ORDER BY c.name, e.unit_number`,
  },
  audit: { sql: `SELECT a.id, a.at, u.email AS user_email, a.action, a.entity, a.entity_id, a.note, a.before, a.after FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id` },
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!can(user, "export_data")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { kind } = await params;
  const def = QUERIES[kind];
  const computed = COMPUTED[kind];
  if (!def && !computed) return NextResponse.json({ error: "Unknown export" }, { status: 404 });
  const rows = computed ? await computed(req.nextUrl.searchParams) : await q(def.sql, def.params ? def.params(req.nextUrl.searchParams) : []);
  await audit(pool(), user.id, "export", kind, null, null, { rows: rows.length });
  return new NextResponse("﻿" + toCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="champion-${kind}-${todayCentral()}.csv"`, "Cache-Control": "private, no-store" } });
}
