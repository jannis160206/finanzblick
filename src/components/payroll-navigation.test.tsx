// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";
import FinancePage from "@/app/(dashboard)/[view]/page";
import { PayrollTaxes } from "@/components/payroll-taxes";
import { FinancialWorkspace } from "@/components/financial-data";
import { Overview } from "@/components/overview";
import { useFinance } from "@/components/finance-provider";
import { createSeed } from "@/lib/seed";
import { calculateDashboard } from "@/lib/calc";

vi.mock("next/navigation", () => ({
  usePathname: () => "/gehalt-steuern", useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error("Not found"); },
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "dark", setTheme: vi.fn() }) }));
vi.mock("@/components/seasonal-theme-provider", () => ({ useSeasonalTheme: () => ({ theme: "default" }) }));
vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/annual-sixth", () => ({ AnnualSixthCard: () => <div>Manual sixth card sentinel</div> }));
afterEach(cleanup);

function finance() {
  const state = createSeed();
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), update: vi.fn(), replace: vi.fn(),
    openReviewCount: 0, ready: true, saved: true, storageError: null,
    retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
}

it("routes Gehalt & Steuern to its dedicated page", async () => {
  const page = await FinancePage({ params: Promise.resolve({ view: "gehalt-steuern" }) });
  expect(page.props.children.type).toBe(FinancialWorkspace);
  expect(page.props.children.props.children.type).toBe(PayrollTaxes);
});

it("exposes the new navigation link and keeps settings last", () => {
  finance();
  render(<AppShell><p>Payroll page</p></AppShell>);
  const link = screen.getByRole("link", { name: "Gehalt & Steuern" });
  expect(link.getAttribute("href")).toBe("/gehalt-steuern");
  expect(link.getAttribute("aria-current")).toBe("page");
  const settings = screen.getByRole("link", { name: "Einstellungen" });
  expect(settings.parentElement?.className).toContain("mt-auto");
});

it("no longer shows Jahressechstel on the overview", () => {
  finance();
  render(<Overview />);
  expect(screen.queryByText("Manual sixth card sentinel")).toBeNull();
  expect(screen.queryByText(/Jahressechstel/)).toBeNull();
});
