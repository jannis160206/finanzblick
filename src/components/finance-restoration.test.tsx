// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance, useFinanceRestoration } from "./finance-provider";
import { ExcelActions } from "./excel-actions";
import { createEmptyAccountState } from "@/lib/account-state";
import { FINANCE_STORAGE_KEY } from "@/lib/finance-storage";
import { serializeFinanceBackup } from "@/lib/finance-backup";
import { appStateSchema, type AppState } from "@/lib/types";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));

type Finance = ReturnType<typeof useFinance>;
type Restoration = ReturnType<typeof useFinanceRestoration>;
const account = { id: "restoration-test", username: "test", role: "user" as const };
class TestEvents extends EventTarget { close() {} }

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", TestEvents);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

function backup(): AppState {
  const state = createEmptyAccountState();
  state.transactions = [{ id: "restored", date: "2026-10-01", bank: "Testbank", pocket: null,
    description: "Synthetischer Einkauf", amount: -12.34, category: "Shopping", includeInPlan: false, reviewed: true }];
  return state;
}

function mount(cloud = false, actions = false) {
  let finance: Finance | undefined;
  let restoration: Restoration | undefined;
  function Observer() {
    const value = useFinance();
    const restore = useFinanceRestoration();
    useEffect(() => { finance = value; restoration = restore; }, [value, restore]);
    return actions ? <ExcelActions compact /> : null;
  }
  const view = render(<FinanceProvider initialState={createEmptyAccountState()} account={cloud ? account : undefined}><Observer /></FinanceProvider>);
  return {
    ...view,
    read: () => { if (!finance) throw new Error("Observer not ready"); return finance; },
    restore: (state: AppState, expected: AppState) => {
      if (!restoration) throw new Error("Restoration not ready");
      return restoration(state, expected);
    },
  };
}

describe("version-safe persisted restoration", () => {
  it("resolves local restoration only after writing the validated financial state", async () => {
    const view = mount();
    let pending = Promise.resolve();
    act(() => { pending = view.restore(backup(), view.read().state); });
    await pending;
    expect(view.read().saved).toBe(true);
    expect(JSON.parse(localStorage.getItem(FINANCE_STORAGE_KEY) ?? "{}").transactions[0].id).toBe("restored");
  });

  it("checks the actual reducer transition even when an edit and confirmation are queued together", async () => {
    const view = mount();
    const expected = view.read().state;
    let failure: unknown;
    let pending = Promise.resolve();
    act(() => {
      view.read().update((state) => ({ ...state, settings: { ...state.settings, emergencyTarget: 987 } }));
      pending = view.restore(backup(), expected).catch((error: unknown) => { failure = error; });
    });
    await pending;
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("zwischenzeitlich");
    expect(view.read().state.settings.emergencyTarget).toBe(987);
    expect(view.read().state.transactions).toEqual([]);
  });

  it("rejects an already stale preview and a newer external tab without mutating the current state", () => {
    const view = mount();
    const expected = view.read().state;
    act(() => view.read().update((state) => ({ ...state, settings: { ...state.settings, emergencyTarget: 321 } })));
    expect(() => view.restore(backup(), expected)).toThrow("zwischenzeitlich");
    const current = view.read().state;
    localStorage.setItem(FINANCE_STORAGE_KEY, JSON.stringify({ ...current, settings: { ...current.settings, emergencyTarget: 555 } }));
    expect(() => view.restore(backup(), current)).toThrow("anderer Tab");
    expect(view.read().state).toBe(current);
    expect(JSON.parse(localStorage.getItem(FINANCE_STORAGE_KEY) ?? "{}").settings.emergencyTarget).toBe(555);
  });

  it("surfaces quota failure without acknowledging success or destroying the previous persistent copy", async () => {
    const view = mount();
    const original = localStorage.getItem(FINANCE_STORAGE_KEY);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("quota", "QuotaExceededError"); });
    let failure: unknown;
    let pending = Promise.resolve();
    act(() => { pending = view.restore(backup(), view.read().state).catch((error: unknown) => { failure = error; }); });
    await pending;
    expect(String(failure)).toContain("Browserspeicher");
    expect(view.read().saved).toBe(false);
    expect(localStorage.getItem(FINANCE_STORAGE_KEY)).toBe(original);
  });

  it("waits for account acknowledgement and never reports an unconfirmed server write as saved", async () => {
    let remote: AppState = createEmptyAccountState();
    let revision = 1;
    let hold = false;
    let release: (() => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      if (options.method === "PUT") {
        const body = JSON.parse(String(options.body));
        if (hold) await new Promise<void>((resolve) => { release = resolve; });
        remote = appStateSchema.parse(body.state);
        revision++;
      }
      return Response.json({ state: remote, revision });
    }));
    const view = mount(true);
    await waitFor(() => expect(view.read().saved).toBe(true));
    hold = true;
    let completed = false;
    let pending = Promise.resolve();
    act(() => { pending = view.restore(backup(), view.read().state).then(() => { completed = true; }); });
    await waitFor(() => expect(release).toBeDefined());
    expect(completed).toBe(false);
    expect(view.read().saved).toBe(false);
    expect(remote.transactions).toEqual([]);
    release?.();
    await pending;
    await waitFor(() => expect(view.read().saved).toBe(true));
    expect(remote.transactions[0].id).toBe("restored");
  });
});

function chooseJSON(raw: string) {
  const file = new File([raw], "Sicherung.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => raw });
  fireEvent.change(screen.getByLabelText("Sicherungsdatei auswählen"), { target: { files: [file] } });
}

describe("JSON restoration preview", () => {
  it("previews scope and cancels without changing data", async () => {
    const view = mount(false, true);
    const original = localStorage.getItem(FINANCE_STORAGE_KEY);
    chooseJSON(serializeFinanceBackup(backup()));
    await screen.findByRole("dialog", { name: "Sicherung wiederherstellen" });
    expect(screen.getByText("Abrechnungen")).toBeTruthy();
    expect(view.read().state.transactions).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(localStorage.getItem(FINANCE_STORAGE_KEY)).toBe(original);
  });

  it("restores legacy raw JSON after explicit confirmation and rejects an invalid file", async () => {
    const view = mount(false, true);
    chooseJSON("{");
    await screen.findByRole("alert");
    expect(view.read().state.transactions).toEqual([]);
    chooseJSON(JSON.stringify(backup()));
    await screen.findByRole("dialog", { name: "Sicherung wiederherstellen" });
    fireEvent.click(screen.getByRole("button", { name: "Sicherung wiederherstellen und aktuelle Daten ersetzen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view.read().state.transactions[0].id).toBe("restored");
    expect(view.read().saved).toBe(true);
  });

  it("requires an explicit refreshed preview after an intervening local change", async () => {
    const view = mount(false, true);
    chooseJSON(serializeFinanceBackup(backup()));
    await screen.findByRole("dialog", { name: "Sicherung wiederherstellen" });
    act(() => view.read().update((state) => ({ ...state, settings: { ...state.settings, emergencyTarget: 456 } })));
    const confirm = screen.getByRole<HTMLButtonElement>("button", { name: "Sicherung wiederherstellen und aktuelle Daten ersetzen" });
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(/Seit der Vorschau/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Vorschau auf aktuellen Stand beziehen" }));
    expect(confirm.disabled).toBe(false);
    expect(view.read().state.settings.emergencyTarget).toBe(456);
  });
});
