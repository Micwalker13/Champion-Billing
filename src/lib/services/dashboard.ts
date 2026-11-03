import { q, one } from "../db";
import { monthEnd, monthStart } from "../dates";
import { refreshOverdue } from "./invoices";
import { D, cents, dec } from "../money";

const FINAL = ["approved", "issued", "partially_paid", "paid", "overdue"];

/** One row per rental line billable in the month, with its PO and invoice status. */
export async function machineMonthRows(month: string, filters: { customerId?: string; unit?: string; po?: string; status?: string } = {}) {
  const ms = monthStart(month), me = monthEnd(month);
  const rows = await q(
    `SELECT l.id AS line_id, l.status AS line_status, l.rate_amount, l.off_rent_date, e.unit_number, e.description, c.contract_number, c.job_number AS contract_job, c.work_order_number AS contract_wo,
            cu.id AS customer_id, cu.name AS customer_name, prof.require_monthly_po, prof.po_variance_tolerance_pct, prof.po_variance_tolerance_amount,
            bp.id AS period_id, bp.period_start, bp.period_end,
            pa.po_number, pa.estimated_total, pa.job_number AS po_job, pa.work_order_number AS po_wo,
            i.id AS invoice_id, i.invoice_number, i.status AS invoice_status, i.total AS invoice_total, i.po_number AS invoice_po
     FROM rental_contract_lines l
     JOIN rental_contracts c ON c.id=l.contract_id JOIN customers cu ON cu.id=c.customer_id JOIN customer_billing_profiles prof ON prof.customer_id=cu.id
     JOIN equipment e ON e.id=l.equipment_id
     LEFT JOIN billing_periods bp ON bp.contract_line_id=l.id AND bp.period_start <= $2 AND bp.period_end >= $1
     LEFT JOIN LATERAL (SELECT p.po_number, p.estimated_total, a.job_number, a.work_order_number FROM po_assignments a JOIN purchase_orders p ON p.id=a.purchase_order_id
                        WHERE a.billing_period_id=bp.id AND a.status='active') pa ON true
     LEFT JOIN LATERAL (SELECT * FROM invoices iv WHERE iv.billing_period_id=bp.id AND iv.status NOT IN ('voided','rejected','corrected') ORDER BY iv.id DESC LIMIT 1) i ON true
     WHERE l.billing_start_date <= $2 AND (l.off_rent_date IS NULL OR l.off_rent_date >= $1) AND l.status <> 'closed'
       AND ($3::bigint IS NULL OR cu.id=$3) AND ($4::text IS NULL OR e.unit_number ILIKE '%'||$4||'%') AND ($5::text IS NULL OR pa.po_number ILIKE '%'||$5||'%' OR i.po_number ILIKE '%'||$5||'%')
     ORDER BY cu.name, e.unit_number`,
    [ms, me, filters.customerId || null, filters.unit || null, filters.po || null]);
  const out = rows.map((r) => {
    const flags: string[] = [];
    if (r.require_monthly_po && !r.po_number) flags.push("Missing PO");
    if (!r.invoice_id) flags.push("Unbilled");
    if (r.invoice_id && r.po_number && r.invoice_po && r.invoice_po !== r.po_number) flags.push(FINAL.includes(r.invoice_status) ? "PO changed after finalizing" : "Draft PO out of date");
    if (r.invoice_total && r.estimated_total != null) {
      const variance = dec(r.invoice_total).sub(r.estimated_total).abs();
      const tol = cents(D.max(dec(r.po_variance_tolerance_amount), dec(r.estimated_total).mul(dec(r.po_variance_tolerance_pct)).div(100)));
      if (variance.gt(tol)) flags.push("PO variance");
    }
    return { ...r, flags };
  });
  return filters.status ? out.filter((r) => (filters.status === "none" ? !r.invoice_id : r.invoice_status === filters.status)) : out;
}

export async function overview(month: string) {
  await refreshOverdue();
  const ms = monthStart(month), me = monthEnd(month);
  const rows = await machineMonthRows(month);
  const active = await one(`SELECT count(*)::int AS n FROM rental_contract_lines WHERE status IN ('active','off_rent')`);
  const byCustomer = await q(`SELECT cu.id, cu.name, count(*)::int AS n FROM rental_contract_lines l JOIN rental_contracts c ON c.id=l.contract_id JOIN customers cu ON cu.id=c.customer_id
                              WHERE l.status IN ('active','off_rent') GROUP BY cu.id, cu.name ORDER BY n DESC`);
  const inv = await one(`SELECT count(*)::int AS n,
                                count(*) FILTER (WHERE status='pending_review')::int AS pending,
                                coalesce(sum(total) FILTER (WHERE status = ANY($3)),0)::text AS billed
                         FROM invoices WHERE period_start <= $2 AND period_end >= $1 AND status NOT IN ('voided','rejected','corrected')`, [ms, me, FINAL]);
  const pendingAll = await one(`SELECT count(*)::int AS n FROM invoices WHERE status='pending_review'`);
  const overdue = await one(`SELECT count(*)::int AS n, coalesce(sum(total-amount_paid),0)::text AS amt FROM invoices WHERE status='overdue'`);
  const poAssigned = rows.filter((r) => r.po_number).length;
  const missingPo = rows.filter((r) => r.flags.includes("Missing PO"));
  const unbilled = rows.filter((r) => !r.invoice_id);
  const discrepancies = rows.filter((r) => r.flags.some((f: string) => f.startsWith("PO variance") || f.startsWith("PO changed") || f.startsWith("Draft PO")));
  const finalized = rows.filter((r) => FINAL.includes(r.invoice_status)).length;
  return {
    month: ms, rows, active: active.n, byCustomer, invoicesThisMonth: inv.n, pendingThisMonth: inv.pending, pendingAll: pendingAll.n, billed: inv.billed,
    overdue, poAssigned, missingPo, unbilled, discrepancies, billable: rows.length, finalized,
    completionPct: rows.length ? Math.round((finalized / rows.length) * 100) : 0,
  };
}

export async function customerMonthSummary(customerId: string, month: string, filters: { unit?: string; po?: string; status?: string } = {}) {
  const all = await machineMonthRows(month, { customerId });
  const imports = await q(`SELECT id, filename, status, row_count, uploaded_at, applied_at FROM import_batches WHERE customer_id=$1 AND billing_month=$2 ORDER BY id DESC`, [customerId, monthStart(month)]);
  const received = await one(`SELECT count(*)::int AS n FROM import_rows r JOIN import_batches b ON b.id=r.batch_id WHERE b.customer_id=$1 AND b.billing_month=$2 AND b.status='applied' AND r.decision='approved'`, [customerId, monthStart(month)]);
  const count = (pred: (r: any) => boolean) => all.filter(pred).length;
  const stats = {
    active: all.length,
    posReceived: received.n,
    posAssigned: count((r) => !!r.po_number),
    generated: count((r) => !!r.invoice_id),
    pending: count((r) => r.invoice_status === "pending_review"),
    approved: count((r) => FINAL.includes(r.invoice_status)),
    submitted: count((r) => ["issued", "partially_paid", "paid", "overdue"].includes(r.invoice_status)),
  };
  const rows = await machineMonthRows(month, { customerId, ...filters });
  return { stats, rows, imports };
}
