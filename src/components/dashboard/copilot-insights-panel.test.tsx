// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CopilotInsightsPanel } from "./copilot-insights-panel";
import { useDashboardExtras } from "./use-dashboard-extras";
import { useFinance } from "@/components/finance-provider";
import { AssistantLauncher } from "@/components/assistant-launcher";
import { askAssistant, assistantRequest } from "@/lib/assistant-bus";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import type { CopilotInsight } from "@/lib/copilot-insights";
import type { DashboardExtras } from "@/lib/dashboard-extras";
import type { AppState } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("./use-dashboard-extras", () => ({ useDashboardExtras: vi.fn() }));
vi.mock("@/components/dashboard/use-dashboard-extras", () => ({ useDashboardExtras: vi.fn() }));
vi.mock("@/components/security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false, ready: true }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("next/dynamic", () => ({ default: () => ({ prompt }: { prompt?: { text: string; send?: boolean } }) => <p>Assistent: {prompt?.text ?? "leer"}{prompt?.send ? " (gesendet)" : ""}</p> }));
vi.mock("@/lib/assistant-bus", async (original) => ({ ...await original<typeof import("@/lib/assistant-bus")>(), askAssistant: vi.fn((await original<typeof import("@/lib/assistant-bus")>()).askAssistant) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const insight = (id: string, severity: CopilotInsight["severity"], title: string): CopilotInsight => ({
  id, kind: "budget", severity, title, text: `${title} – Details`, amount: 40, href: "/umsaetze", prompt: `Frage zu ${title}`,
});
const insights = [insight("a", "high", "Monatsende wird knapp"), insight("b", "medium", "Netflix ist teurer geworden"), insight("c", "low", "3 Buchungen ohne Kategorie"), insight("d", "low", "Restaurants: mehr als sonst")];

function mount(list: CopilotInsight[] | null) {
  let state: AppState = createEmptyAccountState();
  const update = vi.fn((updater: (current: AppState) => AppState) => { state = updater(state); });
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), update, replace: vi.fn(), ready: true, saved: true,
    storageError: null, openReviewCount: 0, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  vi.mocked(useDashboardExtras).mockReturnValue(list ? { copilot: list } as unknown as DashboardExtras : null);
  return { update, current: () => state };
}

it("shows the most important hints first and the rest on demand", () => {
  mount(insights);
  render(<CopilotInsightsPanel />);
  const panel = screen.getByRole("region", { name: "Hinweise" });
  expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
  fireEvent.click(within(panel).getByRole("button", { name: "Alle 4 Hinweise anzeigen" }));
  expect(within(panel).getAllByRole("listitem")).toHaveLength(4);
  expect(within(panel).getByRole("link", { name: "Monatsende wird knapp" }).getAttribute("href")).toBe("/umsaetze");
});

it("asks the assistant right away with the prepared question", () => {
  mount(insights);
  render(<CopilotInsightsPanel />);
  fireEvent.click(screen.getAllByRole("button", { name: "Mehr dazu" })[0]);
  expect(askAssistant).toHaveBeenCalledWith({ text: "Frage zu Monatsende wird knapp", send: true, insightId: "a" });
});

it("remembers dismissed hints in the synced state", () => {
  const { current } = mount(insights);
  render(<CopilotInsightsPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Hinweis ausblenden: Netflix ist teurer geworden" }));
  expect(current().dismissedInsights).toEqual([expect.objectContaining({ id: "b" })]);
});

it("renders nothing without hints", () => {
  mount([]);
  const { container } = render(<CopilotInsightsPanel />);
  expect(container.innerHTML).toBe("");
});

it("parses assistant requests in the old string form and the new object form", () => {
  expect(assistantRequest("Wie viel?")).toEqual({ text: "Wie viel?" });
  expect(assistantRequest({ text: "Was fällt dir auf?", send: true, insightId: "x" })).toEqual({ text: "Was fällt dir auf?", send: true, insightId: "x" });
  expect(assistantRequest({ nope: 1 })).toEqual({ text: "" });
});

it("shows the number of important hints on the assistant button and opens with a sent question", () => {
  mount(insights);
  render(<AssistantLauncher />);
  const button = screen.getByRole("button", { name: "Finanz-Assistent öffnen, 2 wichtige Hinweise" });
  expect(within(button).getByTestId("assistant-hint-badge").textContent).toBe("2");
  fireEvent(window, new CustomEvent("finanzblick:ask-assistant", { detail: { text: "Was fällt dir auf?", send: true } }));
  expect(screen.getByText("Assistent: Was fällt dir auf? (gesendet)")).toBeTruthy();
});

it("keeps the plain button without important hints", () => {
  mount([insight("c", "low", "3 Buchungen ohne Kategorie")]);
  render(<AssistantLauncher />);
  expect(screen.getByRole("button", { name: "Finanz-Assistent öffnen" })).toBeTruthy();
  expect(screen.queryByTestId("assistant-hint-badge")).toBeNull();
});
