// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContractsPage } from "./contracts-page";
import { ContractsCard } from "@/components/dashboard/contracts-card";
import { useFinance } from "@/components/finance-provider";
import { askAssistant } from "@/lib/assistant-bus";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false }) }));
vi.mock("@/components/merchant-marks-provider", () => ({
  MerchantMarksProvider: ({ children }: { children: ReactNode }) => children,
  useMerchantMarks: () => null,
  useMerchantLogoFailure: () => null,
}));
vi.mock("@/lib/assistant-bus", () => ({ askAssistant: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const charge = (id: string, date: string, description: string, amount: number, category: Transaction["category"]): Transaction => ({
  id, date, bank: "Raiffeisen", pocket: "Girokonto", description, amount, category, includeInPlan: true,
});

function stateWith(extra: Partial<AppState> = {}): AppState {
  const base = createEmptyAccountState();
  return appStateSchema.parse({
    ...base,
    settings: { ...base.settings, asOf: "2026-09-12", baselineDate: "2026-09-01" },
    transactions: ["05", "06", "07", "08", "09"].map((month) => charge(`flix-${month}`, `2026-${month}-03`, "Streamflix Abo", -12.99, "Abonnements")),
    ...extra,
  });
}

function mount(initial: AppState) {
  let state = initial;
  const update = vi.fn((updater: (current: AppState) => AppState) => { state = updater(state); });
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), update, replace: vi.fn(), ready: true, saved: true,
    storageError: null, openReviewCount: 0, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  return { update, current: () => state };
}

it("lists newly detected subscriptions for review and stores the confirmation", () => {
  const { update, current } = mount(stateWith());
  render(<ContractsPage />);
  expect(screen.getByRole("heading", { level: 1, name: "Verträge" })).toBeTruthy();
  const review = screen.getByRole("region", { name: "Neu erkannt" });
  expect(within(review).getByText("Streamflix Abo")).toBeTruthy();
  fireEvent.click(within(review).getByRole("button", { name: "Streamflix Abo als Vertrag bestätigen" }));
  expect(update).toHaveBeenCalledTimes(1);
  expect(current().contracts).toEqual([expect.objectContaining({ status: "confirmed" })]);
});

it("hides a detection the user marks as no contract", () => {
  const { current } = mount(stateWith());
  render(<ContractsPage />);
  fireEvent.click(screen.getByRole("button", { name: "Streamflix Abo ist kein Vertrag" }));
  expect(current().contracts).toEqual([expect.objectContaining({ status: "ignored" })]);
});

it("shows manual contracts with their cancellation deadline and prepares a cancellation in the assistant", () => {
  mount(stateWith({
    transactions: [],
    contracts: [{ id: "manual:kfz", manual: true, status: "confirmed", name: "Kfz-Versicherung", amount: 412.6, interval: "yearly",
      nextDate: "2026-11-01", category: "Versicherungen", notice: { value: 1, unit: "months" }, updatedAt: 1 }],
  }));
  render(<ContractsPage />);
  const reminders = screen.getByRole("region", { name: "Hinweise" });
  expect(within(reminders).getByText("Kündigungsfrist: Kfz-Versicherung")).toBeTruthy();
  fireEvent.click(within(reminders).getByRole("button", { name: "Kündigung vorbereiten" }));
  expect(askAssistant).toHaveBeenCalledWith("Kündige Kfz-Versicherung");
  const list = screen.getByRole("region", { name: "Alle Verträge" });
  expect(within(list).getByText("Kfz-Versicherung")).toBeTruthy();
});

it("explains the empty folder and offers to add a contract", () => {
  mount(stateWith({ transactions: [] }));
  render(<ContractsPage />);
  expect(screen.getByText("Noch keine Verträge erkannt")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Vertrag selbst anlegen" })).toBeTruthy();
});

it("summarizes contracts on the dashboard", async () => {
  mount(stateWith());
  render(<ContractsCard />);
  const card = await screen.findByRole("region", { name: "Verträge & Abos" });
  expect(within(card).getByText("1 neu erkannt")).toBeTruthy();
  expect(within(card).getByRole("link", { name: /Alle/ }).getAttribute("href")).toBe("/vertraege");
});
