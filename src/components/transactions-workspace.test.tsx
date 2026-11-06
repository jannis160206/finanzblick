// @vitest-environment jsdom
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Transactions } from "@/components/transactions";
import { useFinance } from "@/components/finance-provider";
import { actualBookings, calculateDashboard } from "@/lib/calc";
import { createEmptyAccountState } from "@/lib/account-state";
import { queueLedgerReview } from "@/lib/import/review";
import * as tools from "@/lib/transaction-tools";
import type { AppState, Transaction } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/statement-import", () => ({
  StatementImport: () => null,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.settings.baselineDate = "2026-10-01";
  state.transactions = [
    {
      id: "alias",
      date: "2026-10-06",
      description: "Händler 1",
      merchantAlias: "Möbel Müller",
      amount: -200,
      bank: "Amex",
      pocket: "Amex",
      category: "Shopping",
      categoryOverride: true,
      includeInPlan: true,
      sharedWithRaphael: true,
    },
    {
      id: "other",
      date: "2026-10-05",
      description: "BILLA",
      amount: -30,
      bank: "Revolut",
      pocket: null,
      category: "Lebensmittel",
      categoryOverride: true,
      includeInPlan: true,
    },
    {
      id: "older",
      date: "2026-09-05",
      description: "Historischer Kauf",
      amount: -40,
      bank: "Revolut",
      pocket: null,
      category: "Shopping",
      categoryOverride: true,
      includeInPlan: true,
    },
  ];
  return state;
}

function mount(initial = fixture(), storageError: string | null = null) {
  let current = initial;
  let change: (updater: (state: AppState) => AppState) => void = () => {};
  const update = vi.fn();
  function Harness() {
    const [state, setState] = useState(initial);
    current = state;
    change = (updater) => act(() => setState(updater));
    update.mockImplementation((updater) =>
      setState((previous) => queueLedgerReview(updater(previous))),
    );
    vi.mocked(useFinance).mockReturnValue({
      state,
      dashboard: calculateDashboard(state),
      update,
      replace: setState,
      openReviewCount: 0,
      ready: true,
      saved: true,
      storageError,
      retrySave: vi.fn(),
      appendStatements: vi.fn(),
      statementImport: undefined,
    });
    return <Transactions />;
  }
  render(<Harness />);
  return {
    read: () => current,
    update,
    change: (updater: (state: AppState) => AppState) => change(updater),
  };
}

it.each([false, true])(
  "hides banking metadata in historical bookings and assignment dialogs (mobile: %s)",
  (mobile) => {
    vi.stubGlobal("matchMedia", () => ({
      matches: mobile,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const state = fixture();
    const original = "Testfirma IBAN Auftraggeber: AT001234567890123456 BIC Auftraggeber: TESTAT00XXX";
    state.transactions = [{
      ...state.transactions[0],
      description: original,
      merchantAlias: undefined,
      sharedWithRaphael: false,
      is_locked: true,
    }];
    const view = mount(state);
    expect(screen.getByText("Testfirma")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/IBAN Auftraggeber|BIC Auftraggeber|AT001234567890123456/);
    fireEvent.click(screen.getByRole("button", { name: "Zuordnung ändern: Testfirma" }));
    expect(screen.getByRole("dialog").textContent).not.toMatch(/IBAN Auftraggeber|BIC Auftraggeber|AT001234567890123456/);
    expect(view.read().transactions[0].description).toBe(original);
  },
);

it.each([false, true])(
  "renders the same 32px merchant cell before booking text without changing ledger order (mobile: %s)",
  (mobile) => {
    vi.stubGlobal("matchMedia", () => ({
      matches: mobile,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const initial = fixture();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    initial.transactions[0].merchantId = "muller/at";
    initial.transactions[0].merchantLogo = true;
    initial.transactions.push(
      {
        ...initial.transactions[0],
        id: "refund",
        date: "2026-10-04",
        description: "Erstattung",
        merchantAlias: "Martin Auer",
        merchantId: undefined,
        merchantLogo: undefined,
        category: "Rückerstattungen",
        amount: 20,
        sharedWithRaphael: false,
      },
      {
        ...initial.transactions[0],
        id: "transfer",
        date: "2026-10-03",
        description: "Interne Überweisung",
        merchantAlias: "Eigenes Konto",
        category: "Transfer intern",
        sharedWithRaphael: false,
      },
      {
        ...initial.transactions[1],
        id: "income",
        date: "2026-10-02",
        description: "Lohnzahlung",
        category: "Gehalt",
        amount: 4000,
      },
    );
    const view = mount(initial);
    fireEvent.click(screen.getByRole("button", { name: "Weitere Filter" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Transfers anzeigen" }));
    fireEvent.keyDown(document, { key: "Escape" });
    const ledger = mobile
      ? screen.getByRole("list", { name: "Mobile Buchungen" })
      : screen.getByRole("table", { name: "Buchungen" });
    const rows = mobile
      ? within(ledger).getAllByRole("listitem")
      : Array.from(ledger.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Möbel Müller"),
      expect.stringContaining("BILLA"),
      expect.stringContaining("Martin Auer"),
      expect.stringContaining("Eigenes Konto"),
      expect.stringContaining("Lohnzahlung"),
    ]);
    const description = within(rows[0] as HTMLElement).getByText("Möbel Müller");
    const merchantMark = description.previousElementSibling!;
    expect(merchantMark.className).toContain("size-8");
    expect(merchantMark.textContent).toBe("MM");
    expect(description.className).toContain("md:truncate");
    expect(description.className).toContain("break-words");
    const unknown = within(rows[1] as HTMLElement).getByText("BILLA");
    expect(unknown.previousElementSibling?.textContent).toBe("?");
    const refund = within(rows[2] as HTMLElement).getByText("Martin Auer");
    expect(refund.previousElementSibling?.textContent).toBe("MA");
    expect(
      within(rows[3] as HTMLElement).getByText("Eigenes Konto")
        .previousElementSibling,
    ).toBeNull();
    expect(
      within(rows[4] as HTMLElement).getByText("Lohnzahlung")
        .previousElementSibling,
    ).toBeNull();
    expect(ledger.querySelector("img")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(view.read()).toBe(initial);
    expect(view.update).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "suppresses merchant marks for bank transfer source metadata in the shared cell (mobile: %s)",
  (mobile) => {
    vi.stubGlobal("matchMedia", () => ({
      matches: mobile,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const initial = fixture();
    initial.transactions = [{
      ...initial.transactions[0],
      sourceCategory: "SEPA Überweisung",
      merchantId: "muller",
      merchantLogo: true,
    }];
    const view = mount(initial);
    const ledger = mobile
      ? screen.getByRole("list", { name: "Mobile Buchungen" })
      : screen.getByRole("table", { name: "Buchungen" });
    const description = within(ledger).getByText("Möbel Müller");
    expect(description.previousElementSibling).toBeNull();
    expect(ledger.querySelector("img")).toBeNull();
    expect(view.update).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "uses only an accessible blue Repeat icon for fixed costs (mobile: %s)",
  (mobile) => {
    vi.stubGlobal("matchMedia", () => ({
      matches: mobile,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const initial = fixture();
    initial.transactions[0].fixedCost = true;
    const view = mount(initial);
    const icon = screen.getByRole("img", {
      name: "Wiederkehrende Fixkosten",
    });
    expect(icon.className).toContain("text-blue-600");
    expect(icon.className).toContain("dark:text-blue-400");
    expect(icon.querySelector("svg.lucide-repeat")).toBeTruthy();
    expect(screen.queryByText("Fixkosten")).toBeNull();
    expect(
      screen.getAllByRole("img", { name: "Wiederkehrende Fixkosten" }),
    ).toHaveLength(1);
    expect(view.read()).toBe(initial);
    expect(view.update).not.toHaveBeenCalled();
  },
);
it("searches accent-insensitive words across alias and bank and removes only the selected filter", () => {
  const view = mount();
  fireEvent.change(screen.getByLabelText("Umsätze durchsuchen"), {
    target: { value: "Amex Muller" },
  });
  const table = screen.getByRole("table", { name: "Buchungen" });
  expect(table.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(within(table).getByText("Möbel Müller")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Kategorie filtern"), {
    target: { value: "Shopping" },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Filter entfernen: Suche: Amex Muller",
    }),
  );
  expect(
    screen.getByLabelText<HTMLSelectElement>("Kategorie filtern").value,
  ).toBe("Shopping");
  expect(
    screen.getByLabelText<HTMLInputElement>("Umsätze durchsuchen").value,
  ).toBe("");
  fireEvent.change(screen.getByLabelText("Monat filtern"), {
    target: { value: "" },
  });
  expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
  fireEvent.click(
    screen.getByRole("button", { name: "Filter entfernen: Alle Monate" }),
  );
  expect(screen.getByLabelText<HTMLSelectElement>("Monat filtern").value).toBe(
    "2026-10",
  );
  expect(view.update).not.toHaveBeenCalled();
});

it("uses the same alias-and-bank search in the existing shared-cost dialog", () => {
  const state = fixture();
  state.transactions[0].sharedWithRaphael = false;
  const view = mount(state);
  fireEvent.click(screen.getByRole("button", { name: "Geteilt" }));
  const dialog = screen.getByRole("dialog", { name: "Geteilt" });
  fireEvent.change(within(dialog).getByLabelText("Geteilte Buchungen suchen"), {
    target: { value: "amex muller" },
  });
  expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
  expect(within(dialog).getByText("Möbel Müller")).toBeTruthy();
  expect(view.update).not.toHaveBeenCalled();
});

it("exposes advanced filters as removable chips without clearing unrelated values", () => {
  const view = mount();
  fireEvent.change(screen.getByLabelText("Umsätze durchsuchen"), {
    target: { value: "Amex" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Weitere Filter" }));
  fireEvent.change(screen.getByLabelText("Planrelevanz filtern"), {
    target: { value: "yes" },
  });
  fireEvent.change(screen.getByLabelText("Datum von"), {
    target: { value: "2026-10-01" },
  });
  fireEvent.change(screen.getByLabelText("Datum bis"), {
    target: { value: "2026-10-07" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Transfers anzeigen" }));
  fireEvent.keyDown(document, { key: "Escape" });
  let chips = within(screen.getByRole("group", { name: "Aktive Filter" }));
  expect(chips.getAllByRole("button")).toHaveLength(5);
  fireEvent.click(
    chips.getByRole("button", { name: "Filter entfernen: Im Plan" }),
  );
  fireEvent.click(
    chips.getByRole("button", { name: /^Filter entfernen: Ab / }),
  );
  fireEvent.click(
    chips.getByRole("button", { name: /^Filter entfernen: Bis / }),
  );
  fireEvent.click(
    chips.getByRole("button", { name: "Filter entfernen: Transfers sichtbar" }),
  );
  chips = within(screen.getByRole("group", { name: "Aktive Filter" }));
  expect(chips.getAllByRole("button")).toHaveLength(1);
  expect(
    screen.getByLabelText<HTMLInputElement>("Umsätze durchsuchen").value,
  ).toBe("Amex");
  expect(view.update).not.toHaveBeenCalled();
});

it("previews a batch, discards drafts, then saves the confirmed category without changing bank facts", () => {
  const view = mount();
  const before = structuredClone(view.read());
  const table = screen.getByRole("table", { name: "Buchungen" });
  fireEvent.click(
    within(table).getByRole("checkbox", {
      name: "Buchungen dieser Seite auswählen",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Auswahl zuordnen" }));
  let dialog = screen.getByRole("dialog", { name: "Auswahl zuordnen" });
  fireEvent.change(within(dialog).getByLabelText("Kategorie für Auswahl"), {
    target: { value: "Möbel & Einrichtung" },
  });
  expect(
    within(dialog).getByRole("list", { name: "Zuordnungsvorschau" })
      .textContent,
  ).toContain("Möbel & Einrichtung");
  expect(view.update).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
  expect(view.read()).toEqual(before);
  fireEvent.click(screen.getByRole("button", { name: "Auswahl zuordnen" }));
  dialog = screen.getByRole("dialog", { name: "Auswahl zuordnen" });
  fireEvent.change(within(dialog).getByLabelText("Kategorie für Auswahl"), {
    target: { value: "Möbel & Einrichtung" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Zuordnungen übernehmen" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  for (const original of before.transactions.slice(0, 2)) {
    const saved = view
      .read()
      .transactions.find((row) => row.id === original.id)!;
    expect(saved).toMatchObject({
      ...original,
      category: "Möbel & Einrichtung",
      reviewed: true,
      manualCategory: true,
    });
  }
  expect(view.read().transactions[2]).toEqual(before.transactions[2]);
  expect(view.read().financeRows).toEqual(before.financeRows);
  expect(view.read().months).toEqual(before.months);
  expect(
    screen.queryByRole("group", { name: "Ausgewählte Buchungen" }),
  ).toBeNull();
});

it("clears selection on filter changes and blocks confirmation if a selected row changes", () => {
  const view = mount();
  let table = screen.getByRole("table", { name: "Buchungen" });
  fireEvent.click(
    within(table).getByRole("checkbox", { name: "Auswählen: BILLA" }),
  );
  fireEvent.change(screen.getByLabelText("Umsätze durchsuchen"), {
    target: { value: "BILLA" },
  });
  expect(
    screen.queryByRole("group", { name: "Ausgewählte Buchungen" }),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText("Umsätze durchsuchen"), {
    target: { value: "" },
  });
  expect(
    screen.queryByRole("group", { name: "Ausgewählte Buchungen" }),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText("Umsätze durchsuchen"), {
    target: { value: "BILLA" },
  });
  table = screen.getByRole("table", { name: "Buchungen" });
  fireEvent.click(
    within(table).getByRole("checkbox", { name: "Auswählen: BILLA" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Auswahl zuordnen" }));
  const dialog = screen.getByRole("dialog", { name: "Auswahl zuordnen" });
  fireEvent.change(within(dialog).getByLabelText("Kategorie für Auswahl"), {
    target: { value: "Shopping" },
  });
  view.change((state) => ({
    ...state,
    transactions: state.transactions.map((row) =>
      row.id === "other" ? { ...row, amount: -31 } : row,
    ),
  }));
  expect(within(dialog).getByRole("alert").textContent).toContain(
    "inzwischen geändert",
  );
  expect(
    within(dialog).getByRole<HTMLButtonElement>("button", {
      name: "Zuordnungen übernehmen",
    }).disabled,
  ).toBe(true);
  expect(view.update).not.toHaveBeenCalled();
});

it("blocks a single editor when another device deletes its target", () => {
  const view = mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Zuordnung ändern: BILLA" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Zuordnung ändern" });
  view.change((state) => ({
    ...state,
    transactions: state.transactions.filter((row) => row.id !== "other"),
  }));
  expect(within(dialog).getByRole("alert").textContent).toContain(
    "geändert oder gelöscht",
  );
  expect(
    within(dialog).getByRole<HTMLButtonElement>("button", {
      name: "Zuordnung übernehmen",
    }).disabled,
  ).toBe(true);
  expect(view.update).not.toHaveBeenCalled();
});

it("includes pending same-merchant imports in the normalized batch preview before saving", () => {
  const state = fixture();
  const source: Transaction = {
    ...state.transactions[1],
    description: "Quasar Möbel",
    category: "Prüfen",
    categoryOverride: false,
  };
  state.transactions = [source];
  state.reviewQueue = [
    {
      kind: "booking",
      id: "pending-quasar",
      message: "Kategorie offen",
      draft: {
        ...source,
        id: "pending-quasar",
        date: "2026-10-04",
        amount: -45,
      },
    },
  ];
  const view = mount(state);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Auswählen: Quasar Möbel" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Auswahl zuordnen" }));
  const dialog = screen.getByRole("dialog", { name: "Auswahl zuordnen" });
  fireEvent.change(within(dialog).getByLabelText("Kategorie für Auswahl"), {
    target: { value: "Möbel & Einrichtung" },
  });
  expect(within(dialog).getByRole("status").textContent).toContain(
    "außerdem 1",
  );
  expect(
    within(dialog).getByText(/Importzeile/, { selector: "span" }),
  ).toBeTruthy();
  expect(view.read().transactions).toHaveLength(1);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Zuordnungen übernehmen" }),
  );
  expect(view.read().transactions).toHaveLength(2);
  expect(
    view.read().transactions.find((row) => row.id === "pending-quasar")
      ?.category,
  ).toBe("Möbel & Einrichtung");
});

it("exports all filtered sorted rows rather than the current page and never changes state", () => {
  const state = fixture();
  state.transactions = Array.from({ length: 30 }, (_, index): Transaction => ({
    ...state.transactions[0],
    id: `row-${index}`,
    description: `Kauf ${index}`,
    merchantAlias: undefined,
    amount: -(index + 1),
  }));
  const view = mount(state);
  const csv = vi.spyOn(tools, "exportTransactionsCsv");
  const create = vi.fn(() => "blob:export");
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  fireEvent.click(
    within(screen.getByRole("table")).getByRole("button", { name: "Betrag" }),
  );
  fireEvent.click(
    within(screen.getByRole("table")).getByRole("button", { name: "Betrag" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Ansicht exportieren" }));
  expect(csv).toHaveBeenCalledOnce();
  expect(csv.mock.calls[0][0]).toHaveLength(30);
  expect(csv.mock.calls[0][0].map((row) => row.amount)).toEqual(
    Array.from({ length: 30 }, (_, index) => -(30 - index)),
  );
  expect(click).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledOnce();
  expect(view.read()).toEqual(state);
  expect(view.update).not.toHaveBeenCalled();
});

it("uses the same row model for mobile sorting, sharing and selection", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const view = mount();
  expect(screen.queryByRole("table")).toBeNull();
  const list = screen.getByRole("list", { name: "Mobile Buchungen" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getByText(/Meine Hälfte/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Buchungen sortieren"), {
    target: { value: "amount-desc" },
  });
  expect(within(list).getAllByRole("listitem")[0].textContent).toContain(
    "BILLA",
  );
  fireEvent.click(
    within(list).getByRole("checkbox", { name: "Auswählen: BILLA" }),
  );
  expect(
    screen.getByRole("group", { name: "Ausgewählte Buchungen" }).textContent,
  ).toContain("1 ausgewählt");
  expect(view.update).not.toHaveBeenCalled();
  expect(actualBookings(view.read())).toHaveLength(3);
});

it("disables all modifying actions when persistence is blocked but allows read-only export", () => {
  mount(fixture(), "Speichern fehlgeschlagen");
  const table = within(screen.getByRole("table"));
  expect(
    table.getByRole<HTMLButtonElement>("button", {
      name: "Zuordnung ändern: BILLA",
    }).disabled,
  ).toBe(true);
  expect(
    table.getByRole<HTMLInputElement>("checkbox", { name: "Auswählen: BILLA" })
      .disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Ansicht exportieren",
    }).disabled,
  ).toBe(false);
});
