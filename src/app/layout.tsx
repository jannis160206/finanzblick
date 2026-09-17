import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { FinanceProvider } from "@/components/finance-provider";
import { AppShell } from "@/components/app-shell";
import { SeasonalThemeProvider } from "@/components/seasonal-theme-provider";
import { seasonalThemeBootstrap } from "@/lib/seasonal-theme";
import { getInitialData } from "@/lib/bootstrap";
import { SecurityModeProvider } from "@/components/security-mode-provider";
import { InteractionSoundsProvider } from "@/components/interaction-sounds";
import { securityModeBootstrap } from "@/lib/security-mode";
import "./globals.css";
import "./security-mode.css";

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
      data-theme="default"
      data-security-mode="locked"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <head>
        <meta name="darkreader-lock" content="true" />
        <script dangerouslySetInnerHTML={{ __html: seasonalThemeBootstrap }} />
        <script dangerouslySetInnerHTML={{ __html: securityModeBootstrap }} />
      </head>
      <body className="min-h-full">
        <SecurityModeProvider>
        <FinanceProvider initialState={initial.state}>
          <SeasonalThemeProvider>
            <InteractionSoundsProvider>
              <AppShell initialWarning={initial.warning}>{children}</AppShell>
            </InteractionSoundsProvider>
          </SeasonalThemeProvider>
        </FinanceProvider>
        </SecurityModeProvider>
      </body>
    </html>
  );
}
