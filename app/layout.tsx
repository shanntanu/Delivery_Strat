import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Delivery Surge Scanner",
  description: "NSE/BSE delivery-surge accumulation scanner — not an advisory product, does not predict.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] antialiased">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <header className="flex items-center justify-between border-b border-[var(--color-border)] py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Delivery Surge Scanner
            </Link>
            <nav className="flex gap-4 text-sm text-[var(--color-text-muted)]">
              <Link href="/" className="hover:text-[var(--color-text)]">
                Dashboard
              </Link>
              <Link href="/admin" className="hover:text-[var(--color-text)]">
                Admin
              </Link>
            </nav>
          </header>
          <main className="py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
