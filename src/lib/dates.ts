// Pure calendar-date helpers on ISO "YYYY-MM-DD" strings, computed in UTC so there is no time-zone drift.
const DAY = 86_400_000;

export function toDate(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Invalid date: ${s}`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`Invalid date: ${s}`);
  return d;
}
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => iso(new Date(toDate(s).getTime() + n * DAY));
/** Inclusive day count between two ISO dates. */
export const daysInclusive = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY) + 1;
export const diffDays = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY);
export const minDate = (a: string, b: string) => (a <= b ? a : b);
export const maxDate = (a: string, b: string) => (a >= b ? a : b);

export function isLeapYear(y: number) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
export function daysInMonth(y: number, m1: number) { return new Date(Date.UTC(y, m1, 0)).getUTCDate(); }
export function monthStart(s: string) { return s.slice(0, 8) + "01"; }
export function monthEnd(s: string) {
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7));
  return `${s.slice(0, 8)}${String(daysInMonth(y, m)).padStart(2, "0")}`;
}
export function addMonths(monthFirst: string, n: number) {
  const y = Number(monthFirst.slice(0, 4)), m = Number(monthFirst.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
}
export function monthLabel(monthFirst: string) {
  return toDate(monthStart(monthFirst)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
export function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  const [y, m, d] = String(s).slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}
/** Today's date in Champion's business time zone (US Central). */
export function todayCentral(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function isIsoDate(s: unknown): s is string {
  try { toDate(String(s)); return true; } catch { return false; }
}
