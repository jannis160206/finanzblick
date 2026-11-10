// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FreeToSpendCard } from "./free-to-spend-card";
import { useFinance } from "@/components/finance-provider";
import { askAssistant } from "@/lib/assistant-bus";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import { currency } from "@/lib/format";
import { monthEndForecast } from "@/lib/month-forecast";
import { appStateSchema, type AppState } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false }) }));
vi.mock("@/lib/assistant-bus", () => ({ askAssistant: vi.fn() }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const text = (value: number) => currency(value).replace(/\u00a0/g, " ");

function mount(extra: Partial<AppState> = {}) {
  const base = createEmptyAccountState();
  const state = appStateSchema.parse({ ...base, settings: { ...base.settings, asOf: "2026-09-12", baselineDate: "2026-09-01" }, ...extra });
  const dashboard = calculateDashboard(state);
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard, update: vi.fn(), replace: vi.fn(), ready: true, saved: true,
    storageError: null, openReviewCount: 0, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  return { state, dashboard };
}

it("shows what is freely available until month end with a per-day amount and the calculation", async () => {
  const { state, dashboard } = mount({
    accountSnapshots: [{ bank: "Raiffeisen", name: "Girokonto", date: "2026-09-12", balance: 1900 }],
    contracts: [{ id: "manual:gym", manual: true, status: "confirmed", name: "Fitbox", amount: 40, interval: "monthly", nextDate: "2026-09-20", category: "Sport & Fitness", updatedAt: 1 }],
  });
  const forecast = monthEndForecast(state, dashboard, "2026-09-12");
  if (forecast.status !== "ok") throw new Error("expected a forecast");
  render(<FreeToSpendCard />);
  const card = await screen.findByRole("region", { name: "Frei verfügbar bis 30. September" });
  expect(within(card).getAllByText(text(forecast.free)).length).toBeGreaterThan(0);
  expect(within(card).getByText(text(forecast.perDay))).toBeTruthy();
  expect(within(card).getByText("Fitbox")).toBeTruthy();
  fireEvent.click(within(card).getByText("So wird gerechnet"));
  expect(within(card).getByText("Verträge & Abos")).toBeTruthy();
});

it("asks for a balance instead of inventing one", async () => {
  mount();
  render(<FreeToSpendCard />);
  const card = await screen.findByRole("region", { name: "Frei verfügbar bis Ende September" });
  expect(within(card).getByText(/fehlt ein aktueller Girokonto-Stand/)).toBeTruthy();
  fireEvent.click(within(card).getByRole("button", { name: "Assistent öffnen" }));
  expect(askAssistant).toHaveBeenCalled();
});
