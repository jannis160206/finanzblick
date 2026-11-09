// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GlobalSearch } from "./global-search";
import { useFinance } from "@/components/finance-provider";
import { createSeed } from "@/lib/seed";
import { calculateDashboard } from "@/lib/calc";
import { takeLedgerSearch } from "@/lib/ledger-search-bus";
import { ASK_ASSISTANT_EVENT } from "@/lib/assistant-bus";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const security = vi.hoisted(() => ({ locked: false }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => router }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => <a {...props} /> }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "dark", resolvedTheme: "dark", setTheme: vi.fn() }) }));
vi.mock("@/components/security-mode-provider", () => ({
  useSecurityMode: () => ({ ready: true, locked: security.locked, preference: "manual", error: null, toggle: vi.fn(), retry: vi.fn() }),
}));
vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));

function finance() {
  const state = createSeed();
  state.transactions = [{
    id: "grocery", date: "2026-09-02", description: "BILLA DANKT 1234", amount: -46.8, bank: "Girokonto", pocket: null,
    category: "Lebensmittel", categoryOverride: true, manualCategory: true, reviewed: true, includeInPlan: true,
  }];
  state.savingsGoals = [{ id: "goal", name: "Motorrad", pocket: "Motorrad", target: 5000, date: "2027-06-01" }];
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), ready: true, saved: true, storageError: null, openReviewCount: 0,
    update: vi.fn(), replace: vi.fn(), retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  } as unknown as ReturnType<typeof useFinance>);
}

function Harness() {
  const [open, setOpen] = useState(false);
  return <GlobalSearch open={open} onOpenChange={setOpen} />;
}
const mount = () => render(<Harness />);

beforeEach(() => { security.locked = false; finance(); takeLedgerSearch(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("opens with Ctrl+K and offers pages before anything is typed", () => {
  mount();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const input = screen.getByRole("combobox", { name: "Suchbegriff" });
  expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  const pages = screen.getByRole("group", { name: "Seiten" });
  expect(within(pages).getByRole("option", { name: /Umsätze/ })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Buchungen" })).toBeNull();
});

it("finds bookings and hands the search to the ledger without putting it into the URL", () => {
  mount();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "billa" } });
  const bookings = screen.getByRole("group", { name: "Buchungen" });
  fireEvent.click(within(bookings).getAllByRole("option")[0]);
  expect(takeLedgerSearch()).toEqual({ query: "billa" });
  expect(router.push).toHaveBeenCalledWith("/umsaetze?month=all");
  expect(String(router.push.mock.calls[0][0])).not.toContain("billa");
});

it("supports arrow keys and Enter, including asking the assistant", () => {
  const asked = vi.fn();
  window.addEventListener(ASK_ASSISTANT_EVENT, asked);
  mount();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "wie viel lebensmittel" } });
  const first = screen.getAllByRole("option")[0];
  expect(first.getAttribute("aria-selected")).toBe("true");
  expect(input.getAttribute("aria-activedescendant")).toBe(first.id);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(asked).toHaveBeenCalledOnce();
  window.removeEventListener(ASK_ASSISTANT_EVENT, asked);
});

it("never shows financial results while privacy mode is locked", () => {
  security.locked = true;
  mount();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "motorrad" } });
  expect(screen.queryByRole("group", { name: "Sparziele" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "billa" } });
  expect(screen.queryByRole("group", { name: "Buchungen" })).toBeNull();
  expect(screen.queryByRole("option", { name: /Assistent fragen/ })).toBeNull();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "sparen" } });
  expect(within(screen.getByRole("group", { name: "Seiten" })).getByRole("option", { name: /Sparen/ })).toBeTruthy();
});
