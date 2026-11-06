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
import { Pockets } from "./pockets";
import { currency, dateLabel } from "@/lib/format";
import { pocketNames } from "@/lib/types";
import { sum } from "@/lib/calc";
import { pocketFixture } from "../../tests/fixtures/pocket-state";

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
  vi.unstubAllGlobals();
});
function mount(initialState = pocketFixture()) {
  let latest: ReturnType<typeof useFinance>;
  function Harness() {
    const finance = useFinance();
    useEffect(() => {
      latest = finance;
    }, [finance]);
    return <Pockets />;
  }
  const view = render(
    <FinanceProvider initialState={initialState}>
      <Harness />
    </FinanceProvider>,
  );
  return { ...view, read: () => latest };
}
function disclosure(title: string) {
  fireEvent.click(screen.getByText(title, { exact: true }));
}
function editor() {
  fireEvent.click(
    screen.getByRole("button", { name: "Kontostand aktualisieren" }),
  );
  return within(
    screen.getByRole("dialog", { name: "Kontostand aktualisieren" }),
  );
}

it("shows actual balances and source dates without presenting goal opening credits as bank cash", () => {
  const view = mount();
  const { state, dashboard } = view.read();
  for (const pocket of pocketNames)
    expect(screen.getByLabelText(`${pocket} Kontostand`).textContent).toBe(
      currency(dashboard.actual[pocket]),
    );
  expect(screen.getByLabelText("Notgroschen Kontostand").textContent).toBe(
    currency(5000),
  );
  expect(screen.getByLabelText("Sparkonto Kontostand").textContent).toBe(
    currency(260),
  );
  expect(screen.getByLabelText("Motorrad Kontostand").textContent).toBe(
    currency(0),
  );
  expect(dashboard.physical.mittagessen.amount).toBe(20);
  expect(dashboard.physical.lebensmittel.amount).toBe(30);
  expect(dashboard.physical.motorrad).toMatchObject({ source: "opening", amount: 2445 });
  expect(dashboard.actual.Motorrad).toBe(0);
  const total = sum(pocketNames.map((pocket) => dashboard.actual[pocket]));
  expect(screen.getByLabelText("Reserven gesamt").textContent).toContain(
    currency(total),
  );
  // P1.3: total pocket assets include everyday cash once; reserve cards still show core bank cash only.
  expect(dashboard.totalAssets).toBe(total + 2445 + 50);
  expect(screen.getByLabelText("Reserven gesamt").textContent).not.toContain(
    currency(dashboard.totalAssets),
  );
  expect(
    within(
      screen.getByRole("article", { name: "Notgroschen Pocket" }),
    ).getByText(`Stand ${dateLabel("2026-10-02")}`),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("article", { name: "Sparkonto Pocket" })).getByText(
      `Auszugbasis ${dateLabel("2026-10-03")}`,
    ),
  ).toBeTruthy();
  expect(screen.queryByText("Kein Ziel festgelegt")).toBeNull();
  expect(
    screen.getByRole("link", { name: "Sparziele" }).getAttribute("href"),
  ).toBe("/einstellungen#sparziele");
  expect(view.read().state).toBe(state);
});

it("keeps zero snapshot balances distinct from unknown everyday pockets and ignores future snapshots", () => {
  mount();
  const region = within(
    screen.getByRole("region", { name: "Revolut Alltagspockets" }),
  );
  expect(region.getByText("20,00 €")).toBeTruthy();
  expect(region.queryByText("800,00 €")).toBeNull();
  expect(region.getByText("Entertainment & Haushalt")).toBeTruthy();
  expect(region.getByText("0,00 €")).toBeTruthy();
  expect(region.getByText("Ohne Auszugssaldo: Tanken")).toBeTruthy();
  expect(region.getAllByRole("term")).toHaveLength(3);
  expect(
    screen
      .getByText("Verlauf & Prognose")
      .closest("details")
      ?.hasAttribute("open"),
  ).toBe(false);
});

it("uses one quiet empty state rather than four empty everyday cards", () => {
  const state = pocketFixture();
  state.accountSnapshots = [];
  mount(state);
  const region = within(
    screen.getByRole("region", { name: "Revolut Alltagspockets" }),
  );
  expect(region.getByText("Noch keine Auszugssalden vorhanden.")).toBeTruthy();
  expect(region.queryByRole("term")).toBeNull();
});

it("shows a negative actual reserve balance explicitly instead of hiding or clamping it", () => {
  const state = pocketFixture();
  state.pocketSnapshots![0].balance = -50;
  const view = mount(state);
  const balance = screen.getByLabelText("Sparkonto Kontostand");
  expect(balance.textContent).toBe(
    currency(view.read().dashboard.actual.Sparkonto),
  );
  expect(balance.textContent).toBe(currency(-40));
  expect(balance.className).toContain("text-destructive");
});

it("filters exact model-derived forecasts by year and pocket without changing any finance data", () => {
  const view = mount();
  const initial = view.read().state;
  disclosure("Verlauf & Prognose");
  let table = within(screen.getByRole("table", { name: "Pocket-Prognose" }));
  expect(table.getAllByRole("columnheader")).toHaveLength(5);
  expect(table.getAllByRole("row")).toHaveLength(4);
  fireEvent.change(screen.getByLabelText("Prognose-Pocket"), {
    target: { value: "Motorrad" },
  });
  fireEvent.change(screen.getByLabelText("Prognosejahr"), {
    target: { value: "2027" },
  });
  table = within(screen.getByRole("table", { name: "Pocket-Prognose" }));
  expect(table.getAllByRole("columnheader")).toHaveLength(2);
  const rows = table.getAllByRole("row").slice(1);
  expect(rows).toHaveLength(12);
  const expected = view
    .read()
    .dashboard.timeline.filter(
      (row) => row.available && row.month.startsWith("2027"),
    );
  rows.forEach((row, index) =>
    expect(within(row).getByRole("cell").textContent).toBe(
      currency(expected[index].end.Motorrad),
    ),
  );
  expect(view.read().state).toBe(initial);
});

it("defaults mobile forecasts to Sparkonto without discarding an explicit all-pocket selection", () => {
  const listeners = new Set<() => void>();
  const media = {
    matches: true,
    addEventListener: (_name: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) =>
      listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => media);
  const view = mount();
  const initial = view.read().state;
  disclosure("Verlauf & Prognose");
  expect(screen.getByLabelText("Prognose-Pocket")).toHaveProperty(
    "value",
    "Sparkonto",
  );
  expect(
    within(screen.getByRole("table", { name: "Pocket-Prognose" })).getAllByRole(
      "columnheader",
    ),
  ).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("Prognose-Pocket"), {
    target: { value: "all" },
  });
  act(() => {
    media.matches = false;
    listeners.forEach((listener) => listener());
  });
  act(() => {
    media.matches = true;
    listeners.forEach((listener) => listener());
  });
  expect(screen.getByLabelText("Prognose-Pocket")).toHaveProperty(
    "value",
    "all",
  );
  expect(view.read().state).toBe(initial);
});

it("shows only booked round-up months, counts matching credits once and offers an honest empty year", () => {
  const view = mount();
  const initial = view.read().state;
  disclosure("Round-ups");
  const table = within(screen.getByRole("table", { name: "Round-ups" }));
  expect(table.getAllByRole("row")).toHaveLength(3);
  expect(table.getByText("0,35 €")).toBeTruthy();
  expect(table.getByText("0,50 €")).toBeTruthy();
  expect(screen.getByText("2026 · 0,85 €")).toBeTruthy();
  expect(table.queryByText("0,90 €")).toBeNull();
  fireEvent.change(screen.getByLabelText("Round-up Jahr"), {
    target: { value: "2027" },
  });
  expect(screen.getByText("Keine Round-ups für 2027 gebucht.")).toBeTruthy();
  expect(screen.queryByRole("table", { name: "Round-ups" })).toBeNull();
  expect(view.read().state).toBe(initial);
});

it("defaults both detail years to the current planning year", () => {
  vi.setSystemTime(new Date("2027-01-08T12:00:00"));
  const state = pocketFixture();
  state.settings.asOf = "2027-01-08";
  mount(state);
  disclosure("Round-ups");
  disclosure("Verlauf & Prognose");
  expect(screen.getByLabelText("Round-up Jahr")).toHaveProperty(
    "value",
    "2027",
  );
  expect(screen.getByLabelText("Prognosejahr")).toHaveProperty("value", "2027");
});

it("does not write TR drafts on cancel, Escape or close", () => {
  const view = mount();
  const initial = view.read().state;
  let dialog = editor();
  fireEvent.change(dialog.getByLabelText("TR Kontostand"), {
    target: { value: "6.123,45" },
  });
  expect(view.read().state).toBe(initial);
  fireEvent.click(dialog.getByRole("button", { name: "Abbrechen" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  dialog = editor();
  fireEvent.change(dialog.getByLabelText("TR Kontostand"), {
    target: { value: "8000" },
  });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  dialog = editor();
  fireEvent.click(dialog.getByRole("button", { name: "Schließen" }));
  expect(view.read().state).toBe(initial);
});

it("confirms a German amount without a prior blur, replaces that date and survives reload", async () => {
  const view = mount();
  const initial = view.read().state;
  const dialog = editor();
  fireEvent.change(dialog.getByLabelText("TR Kontostand"), {
    target: { value: "6.123,45" },
  });
  fireEvent.change(dialog.getByLabelText("TR Standdatum"), {
    target: { value: "2026-10-02" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Kontostand speichern" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByLabelText("Notgroschen Kontostand").textContent).toBe(
    currency(6123.45),
  );
  const saved = view.read().state;
  expect(saved.trBalances).toHaveLength(2);
  expect(
    saved.trBalances?.find((row) => row.date === "2026-10-02")?.balance,
  ).toBe(6123.45);
  expect(
    saved.trBalances?.find((row) => row.date === "2026-10-09")?.balance,
  ).toBe(6200);
  expect(saved.settings).toEqual(initial.settings);
  expect(saved.transactions).toEqual(initial.transactions);
  expect(saved.financeRows).toEqual(initial.financeRows);
  expect(saved.savingsGoals).toEqual(initial.savingsGoals);
  await waitFor(() => expect(view.read().saved).toBe(true));
  view.unmount();
  const restored = mount();
  expect(restored.read().state.trBalances).toEqual(saved.trBalances);
  expect(screen.getByLabelText("Notgroschen Kontostand").textContent).toBe(
    currency(6123.45),
  );
});

it.each(["", "-1", "1,234", "12x", "1.000.000.000,01"])(
  "blocks the invalid TR amount %j rather than saving an old or zero value",
  (value) => {
    const view = mount();
    const initial = view.read().state;
    const dialog = editor();
    fireEvent.change(dialog.getByLabelText("TR Kontostand"), {
      target: { value },
    });
    expect(
      dialog.getByRole("button", { name: "Kontostand speichern" }),
    ).toHaveProperty("disabled", true);
    expect(dialog.getByRole("alert").textContent).toContain("Gültigen Betrag");
    expect(view.read().state).toBe(initial);
  },
);

it("blocks future dates and accepts a deliberate zero balance", () => {
  const view = mount();
  const initial = view.read().state;
  const dialog = editor();
  fireEvent.change(dialog.getByLabelText("TR Standdatum"), {
    target: { value: "2026-10-09" },
  });
  expect(
    dialog.getByRole("button", { name: "Kontostand speichern" }),
  ).toHaveProperty("disabled", true);
  expect(dialog.getByRole("alert").textContent).toContain("Gültiges Datum");
  expect(view.read().state).toBe(initial);
  fireEvent.change(dialog.getByLabelText("TR Standdatum"), {
    target: { value: "2026-10-08" },
  });
  fireEvent.change(dialog.getByLabelText("TR Kontostand"), {
    target: { value: "0" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Kontostand speichern" }));
  expect(screen.getByLabelText("Notgroschen Kontostand").textContent).toBe(
    currency(0),
  );
});

it("blocks a stale TR dialog without overwriting a newer balance from another update", () => {
  const view = mount();
  const dialog = editor();
  fireEvent.change(dialog.getByLabelText("TR Kontostand"), {
    target: { value: "1234" },
  });

  act(() =>
    view.read().update((state) => ({
      ...state,
      trBalances: [
        ...(state.trBalances ?? []),
        { date: "2026-10-08", balance: 7800 },
      ],
    })),
  );
  expect(dialog.getByRole("alert").textContent).toContain(
    "inzwischen geändert",
  );
  expect(
    dialog.getByRole("button", { name: "Kontostand speichern" }),
  ).toHaveProperty("disabled", true);
  expect(
    view.read().state.trBalances?.find((row) => row.date === "2026-10-08")
      ?.balance,
  ).toBe(7800);
});

it("surfaces the TR history limit but permits replacing an existing date", () => {
  const state = pocketFixture();
  state.trBalances = Array.from({ length: 10000 }, () => ({
    date: "2026-10-02",
    balance: 5000,
  }));
  const view = mount(state);
  const dialog = editor();
  expect(dialog.getByRole("alert").textContent).toContain("10.000 Kontostände");
  expect(
    dialog.getByRole("button", { name: "Kontostand speichern" }),
  ).toHaveProperty("disabled", true);
  fireEvent.change(dialog.getByLabelText("TR Standdatum"), {
    target: { value: "2026-10-02" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Kontostand speichern" }));
  expect(view.read().state.trBalances).toEqual([
    { date: "2026-10-02", balance: 5000 },
  ]);
});

it("keeps detail filters readable but blocks TR writes when browser persistence fails", async () => {
  const view = mount();
  const dialog = editor();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Full", "QuotaExceededError");
  });
  act(() =>
    view.read().update((state) => ({
      ...state,
      settings: {
        ...state.settings,
        savingsTarget: state.settings.savingsTarget + 1,
      },
    })),
  );
  await waitFor(() => expect(view.read().storageError).toBeTruthy());
  expect(
    dialog.getByRole("button", { name: "Kontostand speichern" }),
  ).toHaveProperty("disabled", true);
  expect(dialog.getByRole("alert")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Abbrechen" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("link", { name: "Sparziele" }),
    ),
  );
});
