// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TradeRepublicCard } from "./trade-republic-card";
import { useFinance } from "@/components/finance-provider";
import { calculateDashboard } from "@/lib/calc";
import { currency, dateLabel, percent } from "@/lib/format";
import { createSeed } from "@/lib/seed";
import type { AppState, Transaction } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// Formatted amounts use non-breaking spaces; the DOM matcher compares collapsed whitespace.
const shown = (value: string) => value.replace(/\s+/g, " ");

const credit = (date: string): Transaction => ({
  id: `zins-${date}`, date, bank: "Trade Republic", pocket: "Verrechnungskonto", description: "Zinsgutschrift Trade Republic",
  amount: 13.59, category: "Einkommen", includeInPlan: false,
});

function mount(extra: Partial<AppState>) {
  const seed = createSeed();
  const state: AppState = { ...seed, transactions: [], settings: { ...seed.settings, asOf: "2026-11-05" }, ...extra };
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), update: vi.fn(), replace: vi.fn(), ready: true, saved: true,
    storageError: null, openReviewCount: 0, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  render(<TradeRepublicCard />);
  return within(screen.getByRole("region", { name: "Trade Republic" }));
}

it("shows the bank balance and the rate from the interest credits read-only", () => {
  const card = mount({
    trBalances: [{ date: "2026-08-01", balance: 9_800 }, { date: "2026-11-04", balance: 10_000 }],
    transactions: ["2026-09-01", "2026-10-01", "2026-11-01"].map(credit),
  });
  expect(card.getByText(shown(currency(10_000)))).toBeTruthy();
  expect(card.getByText(shown(dateLabel("2026-11-04")))).toBeTruthy();
  expect(card.getByText(shown(percent(0.023)))).toBeTruthy();
  expect(card.getByText(/^aus Zinsgutschriften/)).toBeTruthy();
  expect(card.queryByRole("textbox")).toBeNull();
  expect(card.queryByRole("spinbutton")).toBeNull();
  expect(card.queryByRole("button")).toBeNull();
  expect(card.queryByRole("link")).toBeNull();
});

it("asks to connect Trade Republic when the bank has not delivered a balance yet", () => {
  const card = mount({});
  expect(card.getAllByText("–")).toHaveLength(2);
  expect(card.getByText(shown(percent(0.025)))).toBeTruthy();
  expect(card.getByText(shown(`zuletzt gespeichert (${dateLabel("2026-09-17")})`))).toBeTruthy();
  const link = card.getByRole("link", { name: "Trade Republic unter Banken & Verbindungen verbinden" });
  expect(link.getAttribute("href")).toBe("/einstellungen#bankverbindung");
});
