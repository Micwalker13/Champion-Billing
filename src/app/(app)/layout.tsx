import { requireUser } from "@/lib/session";
import { ROLE_LABELS, can } from "@/lib/permissions";
import { logoutAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const links: Array<[string, string, boolean?]> = [
    ["/", "Dashboard"], ["/rpm", "RPM billing"], ["/invoices", "Invoices"], ["/imports", "PO imports"], ["/reports", "Reports"], ["/sales", "Sales"],
    ["/rentals", "Rentals"], ["/customers", "Customers"], ["/equipment", "Equipment"], ["/shop", "Shop"], ["/exports", "Exports"], ["/audit", "Audit log"],
    ["/settings", "Settings", can(user, "configure_billing")],
  ];
  const visible = links.filter(([, , show]) => show !== false);
  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="brand">Champion <span>Billing</span></div>
        <div className="sect">Billing</div>
        {visible.slice(0, 6).map(([href, label]) => <a key={href} href={href}>{label}</a>)}
        <div className="sect">Records</div>
        {visible.slice(6).map(([href, label]) => <a key={href} href={href}>{label}</a>)}
        <div className="who">
          <div style={{ color: "#fff" }}>{user.name}</div>
          <div>{ROLE_LABELS[user.role]}</div>
          <form action={logoutAction} style={{ marginTop: 8 }}><button className="btn-sm" type="submit">Sign out</button></form>
        </div>
      </nav>
      <div>
        <nav className="mobile-nav" aria-label="Main mobile">
          {visible.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
          <form action={logoutAction} className="inline"><button className="btn-sm" type="submit">Sign out</button></form>
        </nav>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
