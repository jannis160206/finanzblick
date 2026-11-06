// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { Months } from "./months";
import { MonthPositionEditor } from "./month-position-dialogs";
import { createEmptyAccountState } from "@/lib/account-state";
import { currency, monthLabel, number } from "@/lib/format";
import { monthsForYear } from "@/lib/calc";
import type { AppState } from "@/lib/types";

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
  vi.setSystemTime(new Date("2026-10-07T12:00:00"));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(): AppState {
  const state = createEmptyAccountState();
  const values = Object.fromEntries(
    [...monthsForYear(2026), ...monthsForYear(2027)].map((month) => [
      month,
      3000,
    ]),
  );
  return {
    ...state,
    settings: {
      ...state.settings,
      asOf: "2026-10-07",
      baselineDate: "2026-10-01",
    },
    financeRows: [
      { id: "salary", label: "Gehalt", kind: "income", values },
      {
        id: "rent",
        label: "Miete",
        kind: "fixed",
        values: Object.fromEntries(
          Object.keys(values).map((month) => [month, 500]),
        ),
      },
      {
        id: "subscription",
        label: "Geräteabo Firmenkonto",
        kind: "fixed",
        values: { "2026-10": 30 },
      },
      {
        id: "budget-food",
        label: "Lebensmittel & Haushalt",
        kind: "variable",
        values: { "2026-08": 100 },
        overrides: { "2026-08": 100 },
      },
    ],
    plannedOneOffs: [
      {
        id: "cabinet",
        name: "Schrank",
        date: "2026-10-10",
        amount: 400,
        pocket: "Giro",
        installments: 1,
        sharedWithRaphael: true,
      },
      {
        id: "license",
        name: "Führerschein",
        date: "2026-10-20",
        amount: 780,
        pocket: "Sparkonto",
        installments: 1,
      },
    ],
    transactions: [
      {
        id: "amex",
        bank: "Amex",
        pocket: "Amex",
        date: "2026-10-05",
        description: "Amazon Bestellung",
        amount: -120,
        category: "Shopping",
        includeInPlan: false,
        reviewed: true,
      },
    ],
    accountSnapshots: [
      { bank: "Revolut", name: "Amex", date: "2026-09-30", balance: 30 },
    ],
  };
}

function mount(initialState = fixture(), content: ReactNode = <Months />) {
  let latest: ReturnType<typeof useFinance>;
  function Harness() {
    const finance = useFinance();
    useEffect(() => {
      latest = finance;
    }, [finance]);
    return content;
  }
  const view = render(
    <FinanceProvider initialState={initialState}>
      <Harness />
    </FinanceProvider>,
  );
  return { ...view, read: () => latest };
}
function cell(label: string, index = 0) {
  return within(
    screen.getByRole("row", { name: new RegExp(`^${label} `) }),
  ).getAllByRole("cell")[index];
}
function monthView(month?: string) {
  fireEvent.click(screen.getByRole("button", { name: "Monat" }));
  if (month)
    fireEvent.change(screen.getByLabelText("Planungsmonat"), {
      target: { value: month },
    });
}
function summary(label: string, period: string, value: number) {
  expect(
    screen.getByRole("article", { name: `${label} ${period}` }).textContent,
  ).toContain(currency(value));
}

it("keeps the complete annual comparison and reconciles one-offs, Amex and surplus without changing the plan", () => {
  const view = mount();
  const initial = view.read().state;
  expect(
    within(
      screen
        .getByRole("table", { name: "Monatsplanung" })
        .querySelector("thead")!,
    ).getAllByRole("columnheader"),
  ).toHaveLength(13);
  expect(cell("Geplante Einmalausgaben", 9).textContent).toBe(number(980));
  expect(cell("Amex noch zu überweisen", 9).textContent).toBe(number(90));
  expect(cell("Amex noch zu überweisen", 10).textContent).toBe(number(0));
  const year = view
    .read()
    .dashboard.timeline.filter((row) => row.month.startsWith("2026"));
  const income = year.reduce((total, row) => total + row.income, 0);
  const expenses = year.reduce(
    (total, row) => total + row.fixed + row.variablePlan + row.plannedOneOffs,
    0,
  );
  const surplus = year.reduce((total, row) => total + row.surplus, 0);
  summary("Einnahmen", "2026", income);
  summary("Ausgaben", "2026", expenses);
  summary("Überschuss", "2026", surplus);
  expect(income - expenses).toBeCloseTo(surplus, 2);
  fireEvent.click(screen.getByRole("button", { name: "Nächstes Jahr" }));
  expect(within(screen.getByRole("group", { name: "Planungsjahr" })).getByText("2027")).toBeTruthy();
  expect(screen.queryByText("Geplante Einmalausgaben")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Fixkosten.*Oktober/ }),
  ).toBeNull();
  expect(view.read().state).toBe(initial);
});

it("navigates a focused month across years, respects both horizon bounds and jumps back to the current month", () => {
  const view = mount();
  const initial = view.read().state;
  monthView();
  const focused = within(
    screen.getByRole("group", { name: "Monatspositionen" }),
  );
  expect(focused.getAllByRole("table")).toHaveLength(4);
  expect(
    within(
      focused.getByRole("table", { name: "Einnahmen" }).querySelector("thead")!,
    ).getAllByRole("columnheader"),
  ).toHaveLength(2);
  expect(screen.getByLabelText("Planungsmonat")).toHaveProperty(
    "value",
    "2026-10",
  );
  summary(
    "Überschuss",
    monthLabel("2026-10"),
    view.read().dashboard.current.surplus,
  );
  monthView("2027-01");
  fireEvent.click(screen.getByRole("button", { name: "Vorheriger Monat" }));
  expect(screen.getByLabelText("Planungsmonat")).toHaveProperty(
    "value",
    "2026-12",
  );
  fireEvent.click(screen.getByRole("button", { name: "Nächster Monat" }));
  expect(screen.getByLabelText("Planungsmonat")).toHaveProperty(
    "value",
    "2027-01",
  );
  monthView("2026-01");
  expect(
    screen.getByRole("button", { name: "Vorheriger Monat" }),
  ).toHaveProperty("disabled", true);
  monthView("2027-12");
  expect(screen.getByRole("button", { name: "Nächster Monat" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Aktueller Monat" }));
  expect(screen.getByLabelText("Planungsmonat")).toHaveProperty(
    "value",
    "2026-10",
  );
  expect(view.read().state).toBe(initial);
});

it("defaults to one month on mobile and keeps an explicitly chosen view across breakpoint changes", () => {
  const listeners = new Set<() => void>();
  const media = {
    matches: true,
    addEventListener: (_type: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => media);
  mount();
  expect(screen.getByRole("table").getAttribute("data-view")).toBe("month");
  fireEvent.click(screen.getByRole("button", { name: "Jahr" }));
  expect(screen.getByRole("table").getAttribute("data-view")).toBe("year");
  act(() => {
    media.matches = false;
    listeners.forEach((listener) => listener());
  });
  expect(screen.getByRole("table").getAttribute("data-view")).toBe("year");
  act(() => {
    media.matches = true;
    listeners.forEach((listener) => listener());
  });
  expect(screen.getByRole("table").getAttribute("data-view")).toBe("year");
});

it("filters positions accent-insensitively while retaining complete summary and calculated totals", () => {
  const view = mount();
  const initial = view.read().state;
  monthView();
  const surplus = view.read().dashboard.current.surplus;
  fireEvent.change(screen.getByRole("textbox", { name: "Positionen suchen" }), {
    target: { value: "gerateabo" },
  });
  expect(
    within(screen.getByRole("region", { name: "Monatsplan" })).getByText(
      "Geräteabo Firmenkonto",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Monatsplan" })).queryByText(
      "Miete",
    ),
  ).toBeNull();
  expect(cell("Überschuss").textContent).toBe(number(surplus));
  expect(cell("Geplante Einmalausgaben").textContent).toBe(number(980));
  summary("Überschuss", monthLabel("2026-10"), surplus);
  expect(screen.getByText(/Summen bleiben vollständig/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Planbereich filtern"), {
    target: { value: "income" },
  });
  expect(screen.getByText("Keine Positionen gefunden")).toBeTruthy();
  summary("Überschuss", monthLabel("2026-10"), surplus);
  fireEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
  expect(
    within(screen.getByRole("region", { name: "Monatsplan" })).getByText(
      "Miete",
    ),
  ).toBeTruthy();
  expect(screen.getByLabelText("Planbereich filtern")).toHaveProperty(
    "value",
    "all",
  );
  expect(
    screen.getByRole("textbox", { name: "Positionen suchen" }),
  ).toHaveProperty("value", "");
  expect(view.read().state).toBe(initial);
});

it("keeps a selected area in a single compact card without changing complete totals", () => {
  const view = mount();
  const initial = view.read().state;
  monthView();
  fireEvent.change(screen.getByLabelText("Planbereich filtern"), {
    target: { value: "variable" },
  });
  const focused = within(
    screen.getByRole("group", { name: "Monatspositionen" }),
  );
  expect(focused.getAllByRole("table")).toHaveLength(2);
  expect(
    focused.getByRole("table", { name: "Variable Ausgaben" }),
  ).toBeTruthy();
  expect(focused.queryByRole("table", { name: "Fixkosten" })).toBeNull();
  expect(cell("Überschuss").textContent).toBe(
    number(view.read().dashboard.current.surplus),
  );
  expect(cell("Amex noch zu überweisen").textContent).toBe(number(90));
  expect(cell("Geplante Einmalausgaben").textContent).toBe(number(980));
  expect(view.read().state).toBe(initial);
});

it("keeps current and future variable budgets read-only while historical values support manual and Auto", () => {
  const view = mount();
  const budgets = structuredClone(
    view.read().state.financeRows.filter((row) => row.kind === "variable"),
  );
  monthView();
  fireEvent.click(screen.getByRole("button", { name: "Plan bearbeiten" }));
  expect(
    screen.queryByRole("textbox", {
      name: "Lebensmittel & Haushalt Oktober 2026",
    }),
  ).toBeNull();
  monthView("2027-01");
  expect(
    screen.queryByRole("textbox", {
      name: "Lebensmittel & Haushalt Jänner 2027",
    }),
  ).toBeNull();
  monthView("2026-08");
  const input = screen.getByRole("textbox", {
    name: `Lebensmittel & Haushalt ${monthLabel("2026-08")}`,
  });
  fireEvent.change(input, { target: { value: "125,50" } });
  fireEvent.blur(input);
  expect(
    view.read().state.financeRows.find((row) => row.id === "budget-food")
      ?.overrides?.["2026-08"],
  ).toBe(125.5);
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  const food = view
    .read()
    .state.financeRows.find((row) => row.id === "budget-food")!;
  expect(food.overrides?.["2026-08"]).toBeNull();
  expect(food.values["2026-08"]).toBeNull();
  expect(food.values["2026-10"]).toBe(250);
  expect(
    view
      .read()
      .state.financeRows.filter(
        (row) => row.kind === "variable" && row.id !== food.id,
      ),
  ).toEqual(budgets.filter((row) => row.id !== food.id));
});

it("cancels metadata drafts and merges confirmed metadata into the latest monetary values", async () => {
  const view = mount();
  const initial = view.read().state;
  fireEvent.click(screen.getByRole("button", { name: "Plan bearbeiten" }));
  fireEvent.click(screen.getByRole("button", { name: "Gehalt bearbeiten" }));
  fireEvent.change(screen.getByLabelText("Bezeichnung"), {
    target: { value: "Entwurf" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
  expect(view.read().state).toBe(initial);
  fireEvent.click(screen.getByRole("button", { name: "Gehalt bearbeiten" }));
  fireEvent.change(screen.getByLabelText("Bezeichnung"), {
    target: { value: "Mein Gehalt" },
  });
  act(() =>
    view.read().update((state) => ({
      ...state,
      financeRows: state.financeRows.map((row) =>
        row.id === "salary"
          ? { ...row, values: { ...row.values, "2026-10": 3333 } }
          : row,
      ),
    })),
  );
  fireEvent.click(screen.getByRole("button", { name: "Position speichern" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const saved = view
    .read()
    .state.financeRows.find((row) => row.id === "salary")!;
  expect(saved.label).toBe("Mein Gehalt");
  expect(saved.values["2026-10"]).toBe(3333);
  expect(saved.values["2027-12"]).toBe(3000);
  expect(view.read().state.transactions).toEqual(initial.transactions);
});

it("prevents saving a position removed by another update", () => {
  const view = mount();
  fireEvent.click(screen.getByRole("button", { name: "Plan bearbeiten" }));
  fireEvent.click(screen.getByRole("button", { name: "Gehalt bearbeiten" }));
  act(() =>
    view.read().update((state) => ({
      ...state,
      financeRows: state.financeRows.filter((row) => row.id !== "salary"),
    })),
  );
  expect(
    screen.getByRole("button", { name: "Position speichern" }),
  ).toHaveProperty("disabled", true);
  expect(
    within(screen.getByRole("dialog")).getByRole("alert").textContent,
  ).toContain("inzwischen entfernt");
});

it("adds and confirms deletion of a position without touching transactions or variable budgets", async () => {
  const view = mount();
  const initial = view.read().state;
  fireEvent.click(screen.getByRole("button", { name: "Plan bearbeiten" }));
  fireEvent.click(screen.getByRole("button", { name: "Position hinzufügen" }));
  fireEvent.change(screen.getByLabelText("Bezeichnung"), {
    target: { value: "Neue Fixkosten" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Position speichern" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    view.read().state.financeRows.find((row) => row.label === "Neue Fixkosten"),
  ).toMatchObject({ kind: "fixed", values: {} });
  fireEvent.click(
    screen.getByRole("button", { name: "Neue Fixkosten löschen" }),
  );
  expect(view.read().state.financeRows).toHaveLength(
    initial.financeRows.length + 1,
  );
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Position löschen",
    }),
  );
  expect(view.read().state.financeRows).toEqual(initial.financeRows);
  expect(view.read().state.transactions).toEqual(initial.transactions);
});

it("surfaces the 200-position capacity limit without accepting an unsaved draft", async () => {
  const state = fixture();
  state.financeRows = Array.from({ length: 193 }, (_, index) => ({
    id: `fixed-${index}`,
    label: `Position ${index}`,
    kind: "fixed",
    values: {},
  }));
  const close = vi.fn();
  const view = mount(
    state,
    <MonthPositionEditor row={null} close={close} returnFocus={vi.fn()} />,
  );
  expect(view.read().state.financeRows).toHaveLength(200);
  const initial = view.read().state;
  fireEvent.change(screen.getByLabelText("Bezeichnung"), {
    target: { value: "Noch eine Position" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Position speichern" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("höchstens 200"),
  );
  expect(close).not.toHaveBeenCalled();
  expect(view.read().state).toBe(initial);
});

it("deletes the latest linked fixed-cost bookings even if another booking arrives during confirmation", () => {
  const initial = fixture();
  const booking = {
    id: "first-contract",
    bank: "Revolut",
    pocket: null,
    date: "2026-10-02",
    description: "Nordlicht Service",
    amount: -3,
    category: "Shopping" as const,
    includeInPlan: true,
    reviewed: true,
    fixedCost: true,
    manualCategory: true,
    categoryOverride: true,
  };
  initial.transactions.push(booking);
  const view = mount(initial);
  const linked = view
    .read()
    .state.financeRows.find((row) =>
      row.fixedSource?.bookingIds.includes(booking.id),
    )!;
  expect(linked).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Plan bearbeiten" }));
  fireEvent.click(
    screen.getByRole("button", { name: `${linked.label} löschen` }),
  );
  act(() =>
    view.read().update((state) => ({
      ...state,
      transactions: [
        ...state.transactions,
        { ...booking, id: "second-contract", date: "2026-10-06" },
      ],
    })),
  );
  expect(
    view.read().state.financeRows.find((row) => row.id === linked.id)
      ?.fixedSource?.bookingIds,
  ).toContain("second-contract");
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Position löschen",
    }),
  );
  expect(view.read().state.financeRows.some((row) => row.fixedSource)).toBe(
    false,
  );
  expect(
    view
      .read()
      .state.transactions.filter(
        (row) => row.description === booking.description,
      )
      .map((row) => row.fixedCost),
  ).toEqual([false, false]);
});

it("disables deletion if the position disappears during confirmation", () => {
  const view = mount();
  fireEvent.click(screen.getByRole("button", { name: "Plan bearbeiten" }));
  fireEvent.click(screen.getByRole("button", { name: "Miete löschen" }));
  act(() =>
    view.read().update((state) => ({
      ...state,
      financeRows: state.financeRows.filter((row) => row.id !== "rent"),
    })),
  );
  const dialog = within(screen.getByRole("dialog"));
  expect(
    dialog.getByRole("button", { name: "Position löschen" }),
  ).toHaveProperty("disabled", true);
  expect(dialog.getByRole("alert").textContent).toContain(
    "inzwischen entfernt",
  );
});
