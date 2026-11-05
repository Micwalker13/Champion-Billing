/**
 * Fleet profitability for a date range, per unit and per class.
 *
 *  Revenue     = lines on finalized invoices whose billing period starts in the range, before sales
 *                tax, leaving out regulatory taxes (HET, TERP and similar), which are passed through.
 *  Credits     = credit memos (before tax) dated in the range, against that unit's invoices.
 *  Shop cost   = parts, labor and outside repair on that unit's work orders opened in the range
 *                (cancelled work orders don't count).
 *  Re-rent cost = the supplier's bills for that machine, by their period start (or bill date).
 *
 * A rental's invoices count toward the unit on the rental now. After a mid-period exchange, that
 * period's revenue goes to the unit that came in.
 */
import { Db, pool, q } from "../db";
import { D, Dec, dec, money } from "../money";

export interface UnitProfit {
  equipment_id: string; unit_number: string; description: string; category: string | null; ownership: string; status: string;
  revenue: string; credits: string; shop_cost: string; re_rent_cost: string; profit: string; margin: number | null;
}

export async function fleetProfitability(from: string, to: string, db: Db = pool()) {
  const rows = await q(
    `WITH rev AS (
        SELECT rl.equipment_id, sum(il.amount) AS amt
        FROM invoices i JOIN invoice_lines il ON il.invoice_id=i.id JOIN rental_contract_lines rl ON rl.id=i.contract_line_id
        WHERE i.finalized_at IS NOT NULL AND i.status NOT IN ('voided','corrected') AND i.period_start BETWEEN $1 AND $2
          AND coalesce(il.fee_category,'') <> 'regulatory_tax'
        GROUP BY rl.equipment_id),
      cred AS (
        SELECT rl.equipment_id, sum(cm.subtotal) AS amt
        FROM credit_memos cm JOIN invoices i ON i.id=cm.invoice_id JOIN rental_contract_lines rl ON rl.id=i.contract_line_id
        WHERE cm.credit_date BETWEEN $1 AND $2 GROUP BY rl.equipment_id),
      shop AS (
        SELECT w.equipment_id, sum(wl.amount) AS amt
        FROM work_orders w JOIN work_order_lines wl ON wl.work_order_id=w.id
        WHERE w.status <> 'cancelled' AND w.opened_on BETWEEN $1 AND $2 GROUP BY w.equipment_id),
      rr AS (
        SELECT r.equipment_id, sum(b.amount) AS amt
        FROM re_rent_bills b JOIN re_rents r ON r.id=b.re_rent_id
        WHERE b.voided_at IS NULL AND coalesce(b.period_start, b.bill_date) BETWEEN $1 AND $2 GROUP BY r.equipment_id)
     SELECT e.id AS equipment_id, e.unit_number, e.description, e.category, e.ownership, e.status,
            coalesce(rev.amt,0) AS revenue, coalesce(cred.amt,0) AS credits, coalesce(shop.amt,0) AS shop_cost, coalesce(rr.amt,0) AS re_rent_cost
     FROM equipment e LEFT JOIN rev ON rev.equipment_id=e.id LEFT JOIN cred ON cred.equipment_id=e.id
     LEFT JOIN shop ON shop.equipment_id=e.id LEFT JOIN rr ON rr.equipment_id=e.id
     WHERE rev.amt IS NOT NULL OR cred.amt IS NOT NULL OR shop.amt IS NOT NULL OR rr.amt IS NOT NULL
        OR e.status IN ('available','in_shop')
     ORDER BY e.unit_number`, [from, to], db);

  const units: UnitProfit[] = rows.map((r: any) => {
    const net = dec(r.revenue).sub(r.credits);
    const profit = net.sub(r.shop_cost).sub(r.re_rent_cost);
    return { ...r, revenue: money(r.revenue), credits: money(r.credits), shop_cost: money(r.shop_cost), re_rent_cost: money(r.re_rent_cost),
      profit: money(profit), margin: net.gt(0) ? Number(profit.div(net).mul(100).toFixed(1)) : null };
  });

  const byClass = new Map<string, { category: string; units: number; revenue: Dec; credits: Dec; shop_cost: Dec; re_rent_cost: Dec }>();
  const totals = { revenue: new D(0), credits: new D(0), shop_cost: new D(0), re_rent_cost: new D(0) };
  for (const u of units) {
    const k = (u.category ?? "").trim().toLowerCase() || "(no class)";
    const c = byClass.get(k) ?? { category: u.category?.trim() || "(no class)", units: 0, revenue: new D(0), credits: new D(0), shop_cost: new D(0), re_rent_cost: new D(0) };
    c.units++;
    for (const f of ["revenue", "credits", "shop_cost", "re_rent_cost"] as const) { c[f] = c[f].add(u[f]); totals[f] = totals[f].add(u[f]); }
    byClass.set(k, c);
  }
  const fmt = (x: { revenue: Dec; credits: Dec; shop_cost: Dec; re_rent_cost: Dec }) => {
    const net = x.revenue.sub(x.credits), profit = net.sub(x.shop_cost).sub(x.re_rent_cost);
    return { revenue: money(x.revenue), credits: money(x.credits), shop_cost: money(x.shop_cost), re_rent_cost: money(x.re_rent_cost), profit: money(profit), margin: net.gt(0) ? Number(profit.div(net).mul(100).toFixed(1)) : null };
  };
  return {
    units,
    classes: [...byClass.values()].sort((a, b) => a.category.localeCompare(b.category)).map((c) => ({ category: c.category, units: c.units, ...fmt(c) })),
    totals: fmt(totals),
  };
}
