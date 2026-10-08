// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { Plan } from "./plan";
import { currency, dateLabel } from "@/lib/format";
import { monthlyVariableBudget } from "@/lib/variable-budgets";
import {
  budgetBooking,
  budgetFixture,
} from "../../tests/fixtures/budget-state";

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("sonner", () => ({
  Toaster: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
}));
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T12:00:00"));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function mount(initialState = budgetFixture()) {
  let latest: ReturnType<typeof useFinance>;
  function Harness() {
    const finance = useFinance();
    useEffect(() => {
      latest = finance;
    }, [finance]);
    return <Plan />;
  }
  const view = render(
    <FinanceProvider initialState={initialState}>
      <Harness />
    </FinanceProvider>,
  );
  return { ...view, read: () => latest };
}
function figure(label: string, expected: number) {
  expect(screen.getByLabelText(label).textContent).toBe(currency(expected));
}
function openCalculation() {
  fireEvent.click(screen.getByText("Budgetberechnung", { exact: true }));
}
function holidays() {
  openCalculation();
  fireEvent.click(screen.getByRole("button", { name: "Urlaub" }));
  return within(screen.getByRole("dialog", { name: "Urlaubs-Zeiträume" }));
}

it("shows the model's seven budgets once and the complete net summary through the as-of date", () => {
  const view = mount();
  const plan = view.read().dashboard.plan;
  expect(screen.getAllByRole("article")).toHaveLength(7);
  expect(screen.queryByRole("table")).toBeNull();
  expect(
    screen.getByText(`Oktober 2026 · Ist bis ${dateLabel("2026-10-08")}`),
  ).toBeTruthy();
  expect(plan.total).toBe(911.5);
  figure("Monatsbudget", plan.total);
  figure("Ist-Ausgaben", 393);
  figure("Budgetrest", 518.5);
  for (const row of plan.rows) {
    expect(
      within(screen.getByRole("article", { name: row.label })).getAllByRole(
        "heading",
        { name: row.label },
      ),
    ).toHaveLength(1);
    figure(`${row.label} Plan`, row.total);
    figure(`${row.label} Ist`, row.actual);
  }
  expect(
    screen.getByRole("link", { name: "Umsätze ansehen" }).getAttribute("href"),
  ).toBe("/umsaetze");
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("uses shared own portions, net refunds, exclusions and source dates without counting transfers or income", () => {
  mount();
  figure("Lebensmittel & Haushalt Ist", 270);
  figure("Lebensmittel & Haushalt Überschreitung", 20);
  figure("Tanken Ist", 100);
  figure("Tanken Restbudget", 80);
  figure("Giro Puffer Ist", 25);
  figure("Freizeit Ist", -30);
  figure("Freizeit Restbudget", 50);
});

it("handles zero planned gifts as a real overrun without infinite progress", () => {
  mount();
  figure("Geschenke & Spenden Plan", 0);
  figure("Geschenke & Spenden Überschreitung", 13);
  const bar = screen.getByRole("progressbar", {
    name: "Geschenke & Spenden Budgetverbrauch",
  });
  expect(bar.getAttribute("aria-valuenow")).toBe("100");
  expect(bar.getAttribute("aria-valuetext")).toBe(
    `${currency(13)} von ${currency(0)}`,
  );
  expect(bar.firstElementChild?.getAttribute("style")).toContain("width: 100%");
});

it("clamps consumption at both ends without hiding actual amounts", () => {
  mount();
  expect(
    screen
      .getByRole("progressbar", {
        name: "Lebensmittel & Haushalt Budgetverbrauch",
      })
      .getAttribute("aria-valuenow"),
  ).toBe("100");
  expect(
    screen
      .getByRole("progressbar", { name: "Freizeit Budgetverbrauch" })
      .getAttribute("aria-valuenow"),
  ).toBe("0");
  for (const bar of screen.getAllByRole("progressbar"))
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(0);
});

it("filters only overrun cards, preserves summary totals and does not persist viewing choices", () => {
  const view = mount();
  const state = view.read().state;
  const saved = localStorage.getItem("finanzdashboard.v1");
  fireEvent.click(screen.getByRole("button", { name: "Über Budget (2)" }));
  expect(
    screen
      .getByRole("button", { name: "Über Budget (2)" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen
      .getAllByRole("article")
      .map((card) => card.getAttribute("aria-label")),
  ).toEqual(["Lebensmittel & Haushalt", "Geschenke & Spenden"]);
  figure("Budgetrest", 518.5);
  figure("Ist-Ausgaben", 393);
  fireEvent.click(screen.getByRole("button", { name: "Alle (7)" }));
  expect(screen.getAllByRole("article")).toHaveLength(7);
  expect(view.read().state).toBe(state);
  expect(localStorage.getItem("finanzdashboard.v1")).toBe(saved);
});

it("offers an honest empty overrun view and returning to all seven positions", () => {
  const state = budgetFixture();
  state.transactions = [];
  mount(state);
  fireEvent.click(screen.getByRole("button", { name: "Über Budget (0)" }));
  expect(
    screen.getByText("Keine Budgetüberschreitungen bis zum angezeigten Stand."),
  ).toBeTruthy();
  expect(screen.queryByRole("article")).toBeNull();
  figure("Ist-Ausgaben", 0);
  figure("Budgetrest", 911.5);
  fireEvent.click(screen.getByRole("button", { name: "Alle (7)" }));
  figure("Geschenke & Spenden Restbudget", 0);
  expect(
    screen
      .getByRole("progressbar", { name: "Geschenke & Spenden Budgetverbrauch" })
      .getAttribute("aria-valuenow"),
  ).toBe("0");
});

it("keeps a negative total rest visible instead of clamping it to zero", () => {
  const state = budgetFixture();
  state.transactions = [budgetBooking("overrun", "Lebensmittel", -1000)];
  mount(state);
  figure("Budgetrest", -88.5);
  expect(screen.getByLabelText("Budgetrest").className).toContain(
    "text-destructive",
  );
});

it("does not turn net credits into spending or a false overrun", () => {
  const state = budgetFixture();
  state.transactions = [budgetBooking("credit", "Freizeit", 30)];
  mount(state);
  figure("Ist-Ausgaben", -30);
  figure("Budgetrest", 941.5);
  expect(screen.getByRole("button", { name: "Über Budget (0)" })).toBeTruthy();
});

it("follows the current model month and calendar gifts rather than hardcoded October budgets", () => {
  vi.setSystemTime(new Date("2026-11-08T12:00:00"));
  const state = budgetFixture();
  state.settings.asOf = "2026-11-08";
  const view = mount(state);
  expect(
    screen.getByText(`November 2026 · Ist bis ${dateLabel("2026-11-08")}`),
  ).toBeTruthy();
  figure("Geschenke & Spenden Plan", 100);
  figure("Ist-Ausgaben", 0);
  figure("Monatsbudget", monthlyVariableBudget("2026-11").total);
  expect(view.read().dashboard.plan.currentMonth).toBe("2026-11");
});

it("keeps calculation secondary and opening or dismissing holiday management read-only", () => {
  const view = mount();
  const state = view.read().state;
  const details = screen.getByText("Budgetberechnung").closest("details");
  expect(details?.hasAttribute("open")).toBe(false);
  const dialog = holidays();
  expect(dialog.getByLabelText("Von", { exact: true })).toBeTruthy();
  fireEvent.keyDown(dialog.getByRole("button", { name: "Fertig" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(view.read().state).toBe(state);
});

it("reuses confirmed holiday updates for lunch while preserving transactions, goals and other budget amounts", () => {
  const view = mount();
  const before = view.read().state;
  const beforePlan = view.read().dashboard.plan;
  const dialog = holidays();
  fireEvent.change(dialog.getByLabelText("Von", { exact: true }), {
    target: { value: "2026-10-05" },
  });
  fireEvent.change(dialog.getByLabelText("Bis", { exact: true }), {
    target: { value: "2026-10-09" },
  });
  expect(view.read().state).toBe(before);
  fireEvent.click(dialog.getByRole("button", { name: "Zeitraum speichern" }));
  expect(view.read().state.holidayRanges).toEqual([
    { from: "2026-10-05", to: "2026-10-09" },
  ]);
  const afterPlan = view.read().dashboard.plan;
  figure("Mittagessen Plan", 85);
  figure("Monatsbudget", beforePlan.total - 26.5);
  expect(
    afterPlan.rows
      .filter((row) => row.id !== "lunch")
      .map((row) => ({ id: row.id, total: row.total })),
  ).toEqual(
    beforePlan.rows
      .filter((row) => row.id !== "lunch")
      .map((row) => ({ id: row.id, total: row.total })),
  );
  expect(view.read().state.transactions).toEqual(before.transactions);
  expect(view.read().state.savingsGoals).toEqual(before.savingsGoals);
  expect(view.read().state.trBalances).toEqual(before.trBalances);
  fireEvent.click(dialog.getByRole("button", { name: "Fertig" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  cleanup();
  mount();
  figure("Mittagessen Plan", 85);
});

it("blocks an incomplete holiday draft without changing the budget", () => {
  const view = mount();
  const state = view.read().state;
  const dialog = holidays();
  fireEvent.click(dialog.getByRole("button", { name: "Zeitraum speichern" }));
  expect(dialog.getByRole("alert").textContent).toContain(
    "Bitte Anfang und Ende",
  );
  expect(view.read().state).toBe(state);
  figure("Monatsbudget", 911.5);
});
