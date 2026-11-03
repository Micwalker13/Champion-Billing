import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = { title: "Champion Billing", description: "Champion Equipment rental billing and monthly PO management", robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
