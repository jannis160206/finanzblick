import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { appViewport } from "@/lib/viewport";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";
import "./security-mode.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Finanzblick · Persönliche Finanzen",
  description:
    "Umsätze, Monatsplanung und Sparziele in deinem privaten Finanzdashboard.",
  robots: { index: false, follow: false },
  applicationName: "Finanzblick",
  appleWebApp: { capable: true, title: "Finanzblick", statusBarStyle: "black-translucent" },
  icons: { apple: "/icon.svg" },
};

export const viewport = appViewport;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="de"
      data-theme="default"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <head>
        <meta name="darkreader-lock" content="true" />
      </head>
      <body className="min-h-full">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
