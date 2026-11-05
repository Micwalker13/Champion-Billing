import type { Metadata } from "next";

// Sign-in links carry a token in the address, so pages here never send a Referer to other sites.
export const metadata: Metadata = { title: "Customer portal", referrer: "no-referrer", robots: { index: false, follow: false } };

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <div className="portal">{children}</div>;
}
