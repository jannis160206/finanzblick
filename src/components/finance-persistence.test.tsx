// @vitest-environment jsdom
import { StrictMode, useEffect, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState } from "@/lib/types";
import { FINANCE_BACKUP_KEY, FINANCE_RECOVERY_KEY } from "@/lib/finance-storage";

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("sonner", () => ({
  Toaster: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
}));

const key = "finanzdashboard.v1";
type Finance = ReturnType<typeof useFinance>;

function fixture(): AppState {
  return { ...createSeed(), transactions: [], financeRows: [] };
}

function imported(state: AppState): AppState {
  return {
    ...state,
    transactions: [{
      id: "saved-statement", date: "2026-10-01", bank: "Amex", pocket: "Amex",
      description: "Original merchant", rawDescription: "Original merchant",
      amount: -42, category: "Shopping", includeInPlan: true,
      merchantAlias: "Mein Einkauf", categoryOverride: true, manualCategory: true,
      reviewed: true, fixedCost: false, sharedWithRaphael: true,
    }],
    holidayRanges: [{ from: "2026-09-24", to: "2026-10-01" }],
    merchantRules: [{ key: "amex|original merchant", category: "Shopping", fixedCost: false, merchantAlias: "Mein Einkauf" }],
    ignoredStatementKeys: ["ignored-statement"],
    importStatus: { imported: 1, issues: [] },
  };
}

function mount(initial = fixture()) {
  let latest: Finance;
  function Observer() {
    const finance = useFinance();
    useEffect(() => { latest = finance; }, [finance]);
    return null;
  }
  const tree = (state: AppState) => (
    <StrictMode><FinanceProvider initialState={state}><Observer /></FinanceProvider></StrictMode>
  );
  const view = render(tree(initial));
  return { ...view, read: () => latest, refresh: (state: AppState) => view.rerender(tree(state)) };
}

const stored = () => appStateSchema.parse(JSON.parse(localStorage.getItem(key)!));

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("durable finance storage", () => {
  it("saves confirmed imports and assignments immediately, before a refresh can cancel a timer", () => {
    const view = mount();
    act(() => view.read().update(imported));
    expect(stored().transactions).toEqual(view.read().state.transactions);
    expect(stored().holidayRanges).toEqual(view.read().state.holidayRanges);
    expect(stored().importStatus).toEqual({ imported: 1, issues: [] });
    expect(stored().merchantRules).toEqual(view.read().state.merchantRules);
    expect(stored().ignoredStatementKeys).toEqual(["ignored-statement"]);
    expect(stored()).toEqual(view.read().state);
    expect(localStorage.getItem(FINANCE_BACKUP_KEY)).toBe(localStorage.getItem(key));
    expect(view.read().saved).toBe(true);
  });

  it("retains the complete ledger on immediate unmount, remount and new server props", () => {
    const view = mount();
    act(() => view.read().update(imported));
    const expected = view.read().state;
    view.refresh(fixture());
    expect(view.read().state.transactions).toEqual(expected.transactions);
    view.unmount();
    const reloaded = mount();
    expect(reloaded.read().state.transactions).toEqual(expected.transactions);
    expect(reloaded.read().state.holidayRanges).toEqual(expected.holidayRanges);
    expect(reloaded.read().state.importStatus).toEqual(expected.importStatus);
    expect(reloaded.read().state.merchantRules).toEqual(expected.merchantRules);
  });

  it("never writes an old tab snapshot over a newer import when the old tab closes", () => {
    const view = mount();
    act(() => vi.advanceTimersByTime(200));
    const newer = imported(view.read().state);
    localStorage.setItem(key, JSON.stringify(newer));
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(stored().transactions).toEqual(newer.transactions);
  });

  it.each([
    '{"transactions": [{"id": "unreadable-but-not-disposable"}]',
    '{"version":2,"transactions":[{"id":"incompatible-but-not-disposable"}]}',
  ])("does not overwrite unreadable data when retrying storage: %s", (original) => {
    localStorage.setItem(key, original);
    const view = mount();
    expect(view.read().storageError).toBeTruthy();
    act(() => view.read().retrySave());
    act(() => vi.advanceTimersByTime(200));
    expect(localStorage.getItem(key)).toBe(original);
    expect(view.read().storageError).toBeTruthy();
    expect(view.read().saved).toBe(false);
  });

  it("persists every booking even when automatic plan rows cannot fit in a full table", () => {
    const initial = imported(fixture());
    initial.financeRows = Array.from({ length: 200 }, (_, index) => ({
      id: `full-${index}`, kind: "fixed", label: `Vertrag ${index}`, values: {},
    }));
    const view = mount(initial);
    expect(stored().transactions).toEqual(initial.transactions);
    expect(localStorage.getItem(FINANCE_BACKUP_KEY)).toBe(localStorage.getItem(key));
    expect(view.read().saved).toBe(true);
  });

  it.each(["missing", "corrupt"] as const)("recovers every saved assignment from the local copy when the primary entry is %s", (failure) => {
    const view = mount();
    act(() => view.read().update(imported));
    const expected = view.read().state;
    view.unmount();
    if (failure === "missing") localStorage.removeItem(key);
    else localStorage.setItem(key, "{unreadable");
    const recovered = mount();
    expect(recovered.read().state.transactions).toEqual(expected.transactions);
    expect(recovered.read().state.merchantRules).toEqual(expected.merchantRules);
    expect(recovered.read().state.holidayRanges).toEqual(expected.holidayRanges);
    expect(stored().transactions).toEqual(expected.transactions);
    expect(recovered.read().saved).toBe(true);
    if (failure === "corrupt") expect(localStorage.getItem(FINANCE_RECOVERY_KEY)).toBe("{unreadable");
  });

  it("retains deliberate deletions instead of bringing old transactions back", () => {
    const view = mount();
    act(() => view.read().update(imported));
    act(() => view.read().update((state) => ({ ...state, transactions: [] })));
    view.unmount();
    localStorage.removeItem(key);
    expect(mount().read().state.transactions).toEqual([]);
  });

  it("keeps both unreadable originals if another recovery would overwrite an earlier one", () => {
    localStorage.setItem(FINANCE_BACKUP_KEY, JSON.stringify(imported(fixture())));
    localStorage.setItem(FINANCE_RECOVERY_KEY, "{older-unreadable");
    localStorage.setItem(key, "{newer-unreadable");
    const view = mount();
    expect(view.read().state.transactions).toHaveLength(1);
    expect(view.read().storageError).toContain("nicht überschrieben");
    expect(localStorage.getItem(key)).toBe("{newer-unreadable");
    expect(localStorage.getItem(FINANCE_RECOVERY_KEY)).toBe("{older-unreadable");
  });

  it("keeps unsaved working data and the prior saved copy when a write fails, including on Fast Refresh", () => {
    const view = mount();
    const prior = localStorage.getItem(key);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    act(() => view.read().update(imported));
    expect(view.read().saved).toBe(false);
    expect(view.read().storageError).toContain("nicht vollständig gesichert");
    expect(localStorage.getItem(key)).toBe(prior);
    view.refresh(fixture());
    expect(view.read().state.transactions).toHaveLength(1);
    write.mockRestore();
    act(() => view.read().retrySave());
    expect(view.read().saved).toBe(true);
    expect(stored().transactions[0].merchantAlias).toBe("Mein Einkauf");
  });

  it("reports a failed backup write and retries it without losing the already saved import", () => {
    const view = mount();
    const setItem = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name, value) {
      if (name === FINANCE_BACKUP_KEY) throw new DOMException("Storage full", "QuotaExceededError");
      setItem.call(this, name, value);
    });
    act(() => view.read().update(imported));
    expect(stored().transactions).toHaveLength(1);
    expect(view.read().saved).toBe(false);
    expect(view.read().storageError).toBeTruthy();
    write.mockRestore();
    act(() => view.read().retrySave());
    expect(localStorage.getItem(FINANCE_BACKUP_KEY)).toBe(localStorage.getItem(key));
    expect(view.read().saved).toBe(true);
  });

  it("rejects stale-tab updates and retries without replacing newer imports or losing the working edit", () => {
    const view = mount();
    const newer = imported(view.read().state);
    localStorage.setItem(key, JSON.stringify(newer));
    act(() => view.read().update((state) => ({ ...state, settings: { ...state.settings, savingsTarget: 12345 } })));
    expect(stored().transactions).toEqual(newer.transactions);
    expect(view.read().state.settings.savingsTarget).toBe(12345);
    expect(view.read().storageError).toContain("anderer Tab");
    act(() => view.read().retrySave());
    expect(stored().transactions).toEqual(newer.transactions);
    expect(view.read().saved).toBe(false);
  });

  it("loads the latest saved cross-tab state, ignores queued older events and does not echo writes", () => {
    const view = mount();
    const newer = imported(view.read().state);
    act(() => view.read().replace(newer));
    const settled = localStorage.getItem(key)!;
    const write = vi.spyOn(Storage.prototype, "setItem");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(fixture()) })));
    expect(localStorage.getItem(key)).toBe(settled);
    expect(view.read().state.transactions).toEqual(newer.transactions);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not hydrate over unsaved edits when a cross-tab notification arrives", () => {
    const view = mount();
    const setItem = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    act(() => view.read().update(imported));
    const working = view.read().state;
    const other = JSON.stringify(fixture());
    setItem.call(localStorage, key, other);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: other })));
    expect(view.read().state.transactions).toEqual(working.transactions);
    expect(view.read().storageError).toContain("Ungesicherte Änderungen");
    write.mockRestore();
    act(() => view.read().retrySave());
    expect(localStorage.getItem(key)).toBe(other);
  });

  it("restores the working ledger, not the seed, after an external storage clear", () => {
    const view = mount();
    act(() => view.read().update(imported));
    const expected = view.read().state;
    localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(stored().transactions).toEqual(expected.transactions);
    expect(stored().merchantRules).toEqual(expected.merchantRules);
  });

  it("can explicitly restore Excel data without destroying an unreadable original", () => {
    localStorage.setItem(key, "{unreadable");
    const view = mount();
    const restored = imported(fixture());
    act(() => view.read().replace(restored));
    expect(stored().transactions).toEqual(restored.transactions);
    expect(localStorage.getItem(FINANCE_RECOVERY_KEY)).toBe("{unreadable");
    expect(view.read().saved).toBe(true);
  });

  it("reports an unsuccessful explicit replacement instead of acknowledging an import that never happened", () => {
    const view = mount();
    const previous = view.read().state;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Denied", "SecurityError");
    });
    act(() => {
      expect(() => view.read().replace(imported(fixture()))).toThrow("Browserspeicher");
    });
    expect(view.read().state).toBe(previous);
    expect(view.read().storageError).toContain("Browserspeicher");
  });

  it("does not replace a valid ledger with seed data while browser reads are blocked", () => {
    const original = JSON.stringify(imported(fixture()));
    localStorage.setItem(key, original);
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Denied", "SecurityError");
    });
    const view = mount();
    expect(view.read().saved).toBe(false);
    act(() => view.read().retrySave());
    expect(view.read().storageError).toBeTruthy();
    read.mockRestore();
    expect(localStorage.getItem(key)).toBe(original);
    act(() => view.read().retrySave());
    expect(view.read().state.transactions).toHaveLength(1);
    expect(view.read().saved).toBe(true);
  });
});
