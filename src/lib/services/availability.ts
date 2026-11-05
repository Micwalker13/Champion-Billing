/**
 * Availability by equipment category ("class"): how many units of each kind are free on each day,
 * counting rentals, unit reservations and reservations that don't have a unit picked yet.
 *
 * A unit is busy on a day when it is on an open rental that started on or before that day and isn't
 * off rent before it, or when a reservation for that exact unit covers the day. A reservation for a
 * category with no unit yet takes one unit of that category for each day it covers.
 */
import { Db, pool, q } from "../db";
import { addDays } from "../dates";

const catKey = (c: string | null | undefined) => String(c ?? "").trim().toLowerCase();

export interface DayAvailability { day: string; fleet: number; on_rent: number; reserved_unit: number; held: number; in_shop: number; free: number }
export interface CategoryAvailability { category: string; key: string; days: DayAvailability[]; minFree: number }

/**
 * Per-category, per-day counts from `from` for `days` days. Units marked sold or retired don't count.
 * Units in the shop count as fleet (they may be ready in time) but are shown separately.
 */
export async function availabilityGrid(from: string, days: number, opts: { category?: string | null; ignoreReservation?: string | null } = {}, db: Db = pool()): Promise<CategoryAvailability[]> {
  const rows = await q(
    `WITH d AS (SELECT gs::date AS day FROM generate_series($1::date, $1::date + ($2::int - 1), interval '1 day') gs),
          fleet AS (SELECT e.id, lower(btrim(e.category)) AS key, min(btrim(e.category)) OVER (PARTITION BY lower(btrim(e.category))) AS label, e.status
                    FROM equipment e WHERE e.category IS NOT NULL AND btrim(e.category) <> '' AND e.status IN ('available','in_shop')),
          cats AS (SELECT DISTINCT key, label FROM fleet
                   UNION SELECT DISTINCT lower(btrim(r.category)), btrim(r.category) FROM reservations r
                         WHERE r.status='reserved' AND r.equipment_id IS NULL AND r.category IS NOT NULL AND btrim(r.category) <> ''
                           AND NOT EXISTS (SELECT 1 FROM fleet f WHERE f.key = lower(btrim(r.category))))
     SELECT c.key, c.label, d.day::text AS day,
            (SELECT count(*) FROM fleet f WHERE f.key=c.key)::int AS fleet,
            (SELECT count(*) FROM fleet f WHERE f.key=c.key AND f.status='in_shop')::int AS in_shop,
            (SELECT count(*) FROM fleet f WHERE f.key=c.key AND EXISTS (
               SELECT 1 FROM rental_contract_lines l WHERE l.equipment_id=f.id AND l.status IN ('active','off_rent')
                 AND l.on_rent_date <= d.day AND (l.off_rent_date IS NULL OR l.off_rent_date >= d.day)))::int AS on_rent,
            (SELECT count(*) FROM fleet f WHERE f.key=c.key
               AND NOT EXISTS (SELECT 1 FROM rental_contract_lines l WHERE l.equipment_id=f.id AND l.status IN ('active','off_rent')
                                 AND l.on_rent_date <= d.day AND (l.off_rent_date IS NULL OR l.off_rent_date >= d.day))
               AND EXISTS (SELECT 1 FROM reservations r WHERE r.equipment_id=f.id AND r.status='reserved' AND ($4::bigint IS NULL OR r.id <> $4)
                             AND r.start_date <= d.day AND (r.end_date IS NULL OR r.end_date >= d.day)))::int AS reserved_unit,
            (SELECT count(*) FROM reservations r WHERE r.status='reserved' AND r.equipment_id IS NULL AND lower(btrim(r.category))=c.key
               AND ($4::bigint IS NULL OR r.id <> $4) AND r.start_date <= d.day AND (r.end_date IS NULL OR r.end_date >= d.day))::int AS held
     FROM cats c CROSS JOIN d
     WHERE ($3::text IS NULL OR c.key = $3)
     ORDER BY c.label, d.day`,
    [from, days, opts.category ? catKey(opts.category) : null, opts.ignoreReservation ?? null], db);
  const out = new Map<string, CategoryAvailability>();
  for (const r of rows) {
    const free = r.fleet - r.on_rent - r.reserved_unit - r.held;
    let c = out.get(r.key);
    if (!c) { c = { category: r.label, key: r.key, days: [], minFree: Infinity }; out.set(r.key, c); }
    c.days.push({ day: r.day, fleet: r.fleet, on_rent: r.on_rent, reserved_unit: r.reserved_unit, held: r.held, in_shop: r.in_shop, free });
    c.minFree = Math.min(c.minFree, free);
  }
  return [...out.values()];
}

/** Open-ended dates are checked this far ahead. */
export const OPEN_ENDED_DAYS = 60;

/** The fewest free units of a category on any day of a date range (open-ended: the next 60 days). */
export async function freeForCategory(category: string, start: string, end: string | null, opts: { ignoreReservation?: string | null } = {}, db: Db = pool()) {
  const last = end ?? addDays(start, OPEN_ENDED_DAYS - 1);
  const days = Math.max(1, Math.round((Date.parse(last) - Date.parse(start)) / 86_400_000) + 1);
  const [c] = await availabilityGrid(start, Math.min(days, 366), { category, ignoreReservation: opts.ignoreReservation }, db);
  if (!c) return { fleet: 0, minFree: 0, shortDay: start };
  const short = c.days.find((d) => d.free === c.minFree)!;
  return { fleet: c.days[0].fleet, minFree: c.minFree, shortDay: short.day };
}

/** Categories in the fleet, for pick lists. */
export async function equipmentCategories(db: Db = pool()): Promise<string[]> {
  const rows = await q(`SELECT min(btrim(category)) AS c FROM equipment WHERE category IS NOT NULL AND btrim(category) <> '' AND status IN ('available','in_shop')
                        GROUP BY lower(btrim(category)) ORDER BY 1`, [], db);
  return rows.map((r: any) => r.c);
}

/** Free units for a reservation, units of its own category first. */
export async function unitsForReservation(r: { category?: string | null; start_date: string; end_date: string | null }, db: Db = pool()) {
  const rows = await q(
    `SELECT e.id, e.unit_number, e.description, e.category, e.status, y.name AS yard_name,
            (lower(btrim(coalesce(e.category,''))) = $3) AS same_category
     FROM equipment e LEFT JOIN yards y ON y.id=e.yard_id
     WHERE e.status IN ('available','in_shop')
       AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.equipment_id=e.id AND r.status='reserved'
                       AND daterange(r.start_date, COALESCE(r.end_date,'infinity'::date), '[]') && daterange($1::date, COALESCE($2::date,'infinity'::date), '[]'))
       AND NOT EXISTS (SELECT 1 FROM rental_contract_lines l WHERE l.equipment_id=e.id AND l.status IN ('active','off_rent')
                       AND (l.off_rent_date IS NULL OR l.off_rent_date >= $1::date))
     ORDER BY same_category DESC, e.status, e.unit_number`, [r.start_date, r.end_date, catKey(r.category)], db);
  return rows;
}
