import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { FinanceProvider } from "@/components/finance-provider";
import { AppShell } from "@/components/app-shell";
import { getInitialData } from "@/lib/bootstrap";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Finanzblick · Persönliche Finanzen",
  description:
    "Umsätze, Monatsplanung und Sparziele in deinem privaten Finanzdashboard.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const initial = await getInitialData();
  return (
    <html
      lang="de"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <head>
        <meta name="darkreader-lock" content="true" />
      </head>
      <body className="min-h-full">
        <FinanceProvider initialState={initial.state}>
          <AppShell initialWarning={initial.warning}>{children}</AppShell>
        </FinanceProvider>
      </body>
    </html>
  );
}
