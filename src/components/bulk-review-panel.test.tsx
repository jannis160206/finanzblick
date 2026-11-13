// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkReviewPanel } from "./bulk-review-panel";
import { useFinance } from "@/components/finance-provider";
import { calculateDashboard } from "@/lib/calc";
import { queueLedgerReview } from "@/lib/import/review";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";

vi.mock("@/components/security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false }) }));
vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const booking = (id: string, overrides: Partial<Transaction> = {}): Transaction => ({
  id, date: "2026-09-03", bank: "Raiffeisen", pocket: "Testkonto",
  description: "NORDLICHT LADEN 4711 WIEN", amount: -24, category: "Prüfen", includeInPlan: true, ...overrides,
});
const open = [
  booking("a", { date: "2026-09-01" }),
  booking("b", { amount: -12.35, date: "2026-09-10", description: "Nordlicht Laden 0815 Graz" }),
  booking("c", { amount: -6, date: "2026-09-11", description: "NORDLICHT LADEN 99" }),
];

function fixture(): AppState {
  const state = queueLedgerReview(appStateSchema.parse({
    ...createSeed(), transactions: [], merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
    ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [],
  }));
  return {
    ...state,
    reviewQueue: open.map((draft) => ({ kind: "booking" as const, id: draft.id, draft, message: "Händlerzuordnung unsicher – bitte prüfen." })),
  };
}

function renderPanel() {
  let current = fixture();
  function Harness() {
    const [state, setState] = useState(current);
    current = state;
    vi.mocked(useFinance).mockReturnValue({
      state, dashboard: calculateDashboard(state), update: setState, replace: setState,
      openReviewCount: 0, ready: true, saved: true, storageError: null,
      retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
    });
    return <BulkReviewPanel disabled={false} />;
  }
  render(<Harness />);
  return { read: () => current };
}

const toggle = () => screen.getByRole("button", { name: /^Nordlicht Laden(?!:)/ });
const apply = () => screen.getByRole("button", { name: /übernehmen$/i });
const expectApply = (name: string) => expect(screen.getByRole("button", { name })).toBe(apply());

describe("Sammel-Korrekturen", () => {
  it("shows a compact header per merchant and keeps the single bookings folded away", () => {
    renderPanel();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toMatch(/3 ×/);
    expect(toggle().textContent).toMatch(/-42,35\s€/);
    expect(screen.getByRole("combobox", { name: "Kategorie für Nordlicht Laden" })).toBeTruthy();
    expectApply("Alle 3 übernehmen");
    expect(apply().querySelector("[aria-hidden='true']")?.textContent).toBe("Übernehmen");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("lists every booking with date, amount, account and text, all ticked by default", () => {
    renderPanel();
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const region = within(screen.getByRole("region", { name: "Buchungen von Nordlicht Laden" }));
    const boxes = region.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, true, true]);
    expect(boxes[0].getAttribute("aria-label")).toMatch(/^11\.9\.2026, -6,00\s€, NORDLICHT LADEN 99$/);
    expect(region.getByText("Nordlicht Laden 0815 Graz")).toBeTruthy();
    expect(region.getAllByText(/Raiffeisen · Testkonto/)).toHaveLength(3);
    expect(region.getByText("3 von 3 ausgewählt")).toBeTruthy();
  });

  it("updates sum and button live and offers select all / none", () => {
    renderPanel();
    fireEvent.click(toggle());
    const region = within(screen.getByRole("region", { name: "Buchungen von Nordlicht Laden" }));
    fireEvent.click(region.getByRole("checkbox", { name: /NORDLICHT LADEN 99$/ }));
    expectApply("2 von 3 übernehmen");
    expect(apply().querySelector("[aria-hidden='true']")?.textContent).toBe("2/3 übernehmen");
    expect(toggle().textContent).toMatch(/2 von 3/);
    expect(toggle().textContent).toMatch(/-36,35\s€/);
    expect(region.getByText("2 von 3 ausgewählt")).toBeTruthy();
    fireEvent.click(region.getByRole("button", { name: "Nordlicht Laden: alle auswählen" }));
    expectApply("Alle 3 übernehmen");
    fireEvent.click(region.getByRole("button", { name: "Nordlicht Laden: alle abwählen" }));
    expectApply("Übernehmen");
    expect((apply() as HTMLButtonElement).disabled).toBe(true);
    expect(toggle().textContent).toMatch(/0,00\s€/);
  });

  it("categorizes only the ticked bookings and leaves the others open", () => {
    const { read } = renderPanel();
    fireEvent.change(screen.getByRole("combobox", { name: "Kategorie für Nordlicht Laden" }), { target: { value: "Shopping" } });
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("checkbox", { name: /NORDLICHT LADEN 99$/ }));
    fireEvent.click(apply());
    const saved = read().transactions.filter((row) => ["a", "b", "c"].includes(row.id));
    expect(saved.map((row) => row.id).sort()).toEqual(["a", "b"]);
    for (const row of saved) expect(row).toMatchObject({ category: "Shopping", manualCategory: true, reviewed: true });
    expect(read().reviewQueue?.map((item) => item.id)).toEqual(["c"]);
    expect(screen.queryByRole("button", { name: /^Nordlicht Laden(?!:)/ })).toBeNull();
  });

  it("needs a category before anything can be applied", () => {
    renderPanel();
    expect((apply() as HTMLButtonElement).disabled).toBe(true);
  });
});
