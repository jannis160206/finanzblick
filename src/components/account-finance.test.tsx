// @vitest-environment jsdom
import { StrictMode, useEffect, type ReactNode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { createEmptyAccountState } from "@/lib/account-state";
import { accountStorageKey } from "@/lib/account-finance-storage";
import { appStateSchema, type AppState } from "@/lib/types";
import { useAutomation } from "./automation-context";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));
type Finance = ReturnType<typeof useFinance>;
const account = { id: "admin-test", username: "admin", role: "admin" as const };
let remote: AppState | null;
let revision: number;
let request: ReturnType<typeof vi.fn>;
const sources: EventTarget[] = [];
class TestEventSource extends EventTarget {
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { super(); sources.push(this); }
  close = vi.fn();
}
beforeEach(() => {
  vi.stubGlobal("EventSource", TestEventSource);
  sources.length = 0;
  localStorage.clear();
  remote = null;
  revision = 0;
  request = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === "PUT") {
      const body = JSON.parse(String(options.body));
      if (body.revision !== revision) return Response.json({ error: "conflict" }, { status: 409 });
      remote = appStateSchema.parse(body.state);
      revision++;
    }
    return Response.json({ state: remote, revision });
  });
  vi.stubGlobal("fetch", request);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

function mount(strict = false) {
  let finance!: Finance;
  let automation!: ReturnType<typeof useAutomation>;
  function Observer() {
    const value = useFinance();
    const status = useAutomation();
    useEffect(() => { finance = value; automation = status; }, [value, status]);
    return null;
  }
  const node = <FinanceProvider initialState={createEmptyAccountState()} account={account}><Observer /></FinanceProvider>;
  const view = render(strict ? <StrictMode>{node}</StrictMode> : node);
  return { ...view, read: () => finance, status: () => automation };
}

it("hydrates and saves an empty account in StrictMode without adding personal seed purchases", async () => {
  const view = mount(true);
  await waitFor(() => expect(view.read().saved).toBe(true));
  expect(view.read().storageError).toBeNull();
  expect(view.read().state.plannedOneOffs).toEqual([]);
  expect(view.read().state.savingsGoals).toEqual([]);
  expect(view.read().state.settings.balances).toEqual({ Sparkonto: 0, Urlaub: 0, Motorrad: 0, Notgroschen: 0 });
  expect(request.mock.calls.filter((call) => call[1].method === "GET")).toHaveLength(1);
});

it("persists complete confirmed imports immediately on the device then synchronizes the account", async () => {
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  act(() => view.read().update((state) => ({
    ...state,
    transactions: [{ id: "purchase", bank: "Amex", pocket: "Amex", date: "2026-10-06",
      description: "BILLA", amount: -42, category: "Lebensmittel", includeInPlan: true }],
    holidayRanges: [{ from: "2026-10-10", to: "2026-10-12" }],
  })));
  expect(JSON.parse(localStorage.getItem(accountStorageKey(account.id))!).state.transactions[0].id).toBe("purchase");
  await waitFor(() => expect(view.read().saved).toBe(true));
  expect(remote?.transactions[0].id).toBe("purchase");
  expect(remote?.holidayRanges).toEqual([{ from: "2026-10-10", to: "2026-10-12" }]);
  expect(localStorage.getItem("finanzdashboard.v1")).toBeNull();
});

it("loads a second device from the server instead of a shared browser's legacy ledger", async () => {
  remote = { ...createEmptyAccountState(), holidayRanges: [{ from: "2026-11-01", to: "2026-11-03" }] };
  revision = 7;
  localStorage.setItem("finanzdashboard.v1", JSON.stringify({
    ...createEmptyAccountState(), holidayRanges: [{ from: "2026-12-01", to: "2026-12-03" }],
  }));
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  expect(view.read().state.holidayRanges).toEqual(remote.holidayRanges);
});

it("keeps a conflicted device's edits visible and never overwrites the newer server", async () => {
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  revision++;
  act(() => view.read().update((state) => ({ ...state, holidayRanges: [{ from: "2026-10-20", to: "2026-10-22" }] })));
  await waitFor(() => expect(view.read().storageError).toContain("anderen Gerät"));
  expect(view.read().saved).toBe(false);
  expect(view.read().state.holidayRanges).toEqual([{ from: "2026-10-20", to: "2026-10-22" }]);
  expect(remote?.holidayRanges).toEqual([]);
});

it("does not show a successful earlier write while a newer change is still unsynchronized", async () => {
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  let release!: (response: Response) => void;
  request.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  act(() => view.read().update((state) => ({ ...state, holidayRanges: [{ from: "2026-10-10", to: "2026-10-12" }] })));
  const earlier = view.read().state;
  act(() => view.read().update((state) => ({ ...state, holidayRanges: [{ from: "2026-10-20", to: "2026-10-22" }] })));
  request.mockResolvedValueOnce(Response.json({ error: "conflict" }, { status: 409 }));
  await act(async () => { release(Response.json({ state: earlier, revision: revision + 1 })); });
  await waitFor(() => expect(view.read().storageError).toBeTruthy());
  expect(view.read().saved).toBe(false);
  expect(view.read().state.holidayRanges).toEqual([{ from: "2026-10-20", to: "2026-10-22" }]);
});

it("keeps background-read errors and a working retry visible until synchronization recovers", async () => {
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  request.mockRejectedValueOnce(new TypeError("offline"));
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(view.read().storageError).toContain("Server nicht erreichbar"));
  expect(view.read().saved).toBe(false);
  act(() => view.read().update((state) => ({ ...state, holidayRanges: [{ from: "2026-10-20", to: "2026-10-22" }] })));
  expect(view.read().storageError).toBeTruthy();
  act(() => view.read().retrySave());
  await waitFor(() => expect(view.read().saved).toBe(true));
  expect(remote?.holidayRanges).toEqual([{ from: "2026-10-20", to: "2026-10-22" }]);
});

it("retries the current working state after a cache-quota failure, never the older cached server data", async () => {
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });

  act(() => view.read().update((state) => ({ ...state, holidayRanges: [{ from: "2026-10-20", to: "2026-10-22" }] })));
  await waitFor(() => expect(view.read().storageError).toBeTruthy());
  write.mockRestore();
  act(() => view.read().retrySave());
  await waitFor(() => expect(view.read().saved).toBe(true));
  expect(view.read().state.holidayRanges).toEqual([{ from: "2026-10-20", to: "2026-10-22" }]);
  expect(remote?.holidayRanges).toEqual(view.read().state.holidayRanges);
});

it("loads worker changes through SSE without a cyclic HTTP polling timer", async () => {
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  const before = request.mock.calls.filter((call) => call[1].method === "GET").length;
  remote = { ...remote!, holidayRanges: [{ from: "2026-11-01", to: "2026-11-03" }] };
  revision++;
  act(() => sources.at(-1)!.dispatchEvent(new MessageEvent("progress", {
    data: JSON.stringify({ revision, jobs: [] }),
  })));
  await waitFor(() => expect(view.read().state.holidayRanges).toEqual(remote?.holidayRanges));
  expect(request.mock.calls.filter((call) => call[1].method === "GET")).toHaveLength(before + 1);
});

it("coalesces overlapping SSE revisions without advancing the cache ahead of the displayed ledger", async () => {
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  let release!: (response: Response) => void;
  request.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  act(() => sources.at(-1)!.dispatchEvent(new MessageEvent("progress", {
    data: JSON.stringify({ revision: revision + 1, jobs: [] }),
  })));
  await waitFor(() => expect(release).toBeDefined());
  remote = { ...remote!, holidayRanges: [{ from: "2026-11-01", to: "2026-11-03" }] };
  revision += 2;
  act(() => sources.at(-1)!.dispatchEvent(new MessageEvent("progress", {
    data: JSON.stringify({ revision, jobs: [] }),
  })));
  await act(async () => release(Response.json({ state: remote, revision })));
  await waitFor(() => expect(view.read().state.holidayRanges).toEqual(remote?.holidayRanges));
  await waitFor(() => expect(view.read().saved).toBe(true));
  act(() => view.read().update((state) => ({ ...state, seasonalTheme: { reduceMotion: true } })));
  await waitFor(() => expect(view.read().saved).toBe(true));
  expect(remote?.holidayRanges).toEqual([{ from: "2026-11-01", to: "2026-11-03" }]);
});

it("recovers unavailable/error SSE on the existing EventSource and clears its warning on fresh progress without polling or resubmission", async () => {
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  const source = sources.at(-1) as TestEventSource;
  const before = request.mock.calls.length;
  act(() => source.dispatchEvent(new MessageEvent("unavailable", { data: "{}" })));
  expect(view.status().error).toContain("Verbindung wird wiederhergestellt");
  act(() => source.onerror?.());
  expect(view.status().error).toContain("Wiederverbindung erfolgt automatisch");
  expect(source.close).not.toHaveBeenCalled();
  expect(sources).toHaveLength(1);
  expect(request).toHaveBeenCalledTimes(before);
  act(() => source.dispatchEvent(new MessageEvent("progress", {
    data: JSON.stringify({ revision, jobs: [] }),
  })));
  expect(view.status().error).toBeNull();
  expect(view.read().saved).toBe(true);
  expect(request).toHaveBeenCalledTimes(before);
});
