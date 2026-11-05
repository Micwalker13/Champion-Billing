import { requireUser } from "@/lib/session";
import { Empty } from "@/components/ui";
import { addDays, isIsoDate, todayCentral } from "@/lib/dates";
import { availabilityGrid } from "@/lib/services/availability";

const DAYS = 14;
const short = (d: string) => { const [, m, day] = d.split("-"); return `${Number(m)}/${Number(day)}`; };
const weekday = (d: string) => ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][new Date(`${d}T12:00:00`).getDay()];

export default async function Availability({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireUser();
  const sp = await searchParams;
  const today = todayCentral();
  const from = sp.from && isIsoDate(sp.from) ? sp.from : today;
  const grid = await availabilityGrid(from, DAYS);
  const days = grid[0]?.days.map((d) => d.day) ?? [];
  const short_ = grid.filter((c) => c.minFree < 0);
  return (
    <>
      <div className="topbar"><div><h1>Availability</h1><div className="muted">Free units in each class for the next two weeks. Free = units in the fleet, minus units on rent, minus held units, minus class reservations without a unit yet.</div></div>
        <div className="row">
          <a className="btn" href={`/availability?from=${addDays(from, -DAYS)}`}>← Earlier</a>
          {from !== today && <a className="btn" href="/availability">Today</a>}
          <a className="btn" href={`/availability?from=${addDays(from, DAYS)}`}>Later →</a>
        </div></div>
      {short_.length > 0 && <div className="alert alert-bad">Overbooked: {short_.map((c) => c.category).join(", ")}. More reservations than free units on some days. Re-rent a machine or move a reservation.</div>}
      {!grid.length ? <Empty>No equipment has a class yet. Set the category on each unit under Equipment.</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Class</th><th className="num">Fleet</th>{days.map((d) => <th key={d} className="num nowrap"><div className="small muted">{weekday(d)}</div>{short(d)}</th>)}</tr></thead>
          <tbody>{grid.map((c) => <tr key={c.key}>
            <td>{c.category}{c.days[0].in_shop > 0 && <div className="small muted">{c.days[0].in_shop} in shop</div>}</td>
            <td className="num">{c.days[0].fleet}</td>
            {c.days.map((d) => <td key={d.day} className="num" title={`${d.on_rent} on rent, ${d.reserved_unit} unit held, ${d.held} class reservations`}>
              <span className={`badge ${d.free < 0 ? "b-bad" : d.free === 0 ? "b-warn" : "b-ok"}`}>{d.free}</span></td>)}
          </tr>)}</tbody>
        </table></div>)}
      <p className="small muted">Units in the shop count as available because they may be ready in time. Hover a number to see what&rsquo;s using the class that day.</p>
    </>
  );
}
