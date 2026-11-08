// @vitest-environment jsdom
import { StrictMode, useEffect, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { createEmptyAccountState } from "@/lib/account-state";
import { accountStorageKey, accountConflictKey } from "@/lib/account-finance-storage";
import { appStateSchema, type AppState } from "@/lib/types";
import { useAutomation } from "./automation-context";
import { AccountSyncTools } from "./account-tools";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));
type Finance = ReturnType<typeof useFinance>;
const account = { id: "admin-test", username: "admin", role: "admin" as const };
let remote: AppState | null;
let revision: number;
let request: ReturnType<typeof vi.fn<(url: string, options: RequestInit) => Promise<Response>>>;
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

function mount(strict = false, tools = false) {
  let finance!: Finance;
  let automation!: ReturnType<typeof useAutomation>;
  function Observer() {
    const value = useFinance();
    const status = useAutomation();
    useEffect(() => { finance = value; automation = status; }, [value, status]);
    return null;
  }
  const node = <FinanceProvider initialState={createEmptyAccountState()} account={account}><Observer />{tools && <AccountSyncTools />}</FinanceProvider>;
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

it("automatically retries an unavailable first load without submitting placeholder finance data", async () => {
  remote = { ...createEmptyAccountState(), transactions: [{ id: "existing", bank: "Amex", pocket: "Amex",
    date: "2026-10-06", description: "Existing", amount: -42, category: "Shopping", includeInPlan: true }] };
  revision = 3;
  const normal = request.getMockImplementation()!;
  request.mockRejectedValueOnce(new TypeError("First load unavailable")).mockImplementation(normal);
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  expect(view.read().state.transactions.map((row) => row.id)).toEqual(["existing"]);
  for (const call of request.mock.calls.filter((call) => call[1].method === "PUT"))
    expect(JSON.parse(String(call[1].body)).state.transactions.map((row: { id: string }) => row.id)).toEqual(["existing"]);
});

it("bounds automatic transport retries and resumes on online without a request loop", async () => {
  vi.useFakeTimers();
  try {
    const view = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(view.read().saved).toBe(true);
    const normal = request.getMockImplementation()!;
    request.mockRejectedValue(new TypeError("Offline"));
    act(() => view.read().update((state) => ({ ...state, holidayRanges: [{ from: "2026-10-20", to: "2026-10-22" }] })));
    for (const delay of [1, 1, 2_001, 10_001, 30_001])
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    const calls = request.mock.calls.length;
    expect(request.mock.calls.filter((call) => call[1].method === "GET")).toHaveLength(5);
    expect(view.read().saved).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(request.mock.calls).toHaveLength(calls);
    request.mockImplementation(normal);
    await act(async () => { window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(10); });
    expect(view.read().saved).toBe(true);
    expect(remote?.holidayRanges).toEqual([{ from: "2026-10-20", to: "2026-10-22" }]);
  } finally { vi.useRealTimers(); }
});

it("never chooses between conflicting financial settings or sends a guessed merged stand", async () => {
  const base = createEmptyAccountState(), local = structuredClone(base);
  local.settings.emergencyTarget = 123;
  remote = structuredClone(base);
  remote.settings.emergencyTarget = 456;
  revision = 2;
  const original = JSON.stringify({ state: local, revision: 1, pending: true, baseState: base });
  localStorage.setItem(accountStorageKey(account.id), original);
  const view = mount(false, true);
  await waitFor(() => expect(view.read().syncNeedsAttention).toBe(true));
  expect(screen.getByRole("link", { name: "Details prüfen" })).toBeTruthy();
  expect(view.read().state.settings.emergencyTarget).toBe(123);
  expect(remote.settings.emergencyTarget).toBe(456);
  expect(request.mock.calls.filter((call) => call[1].method === "PUT")).toHaveLength(0);
  expect(view.read().storageError).toContain("widersprüchliche");
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

it("automatically combines device edits and newer server changes without requiring confirmation", async () => {
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  revision++;
  remote = { ...remote!, holidayRanges: [{ from: "2026-11-01", to: "2026-11-03" }] };
  act(() => view.read().update((state) => ({ ...state, holidayRanges: [{ from: "2026-10-20", to: "2026-10-22" }] })));
  await waitFor(() => expect(view.read().saved).toBe(true));
  expect(view.read().storageError).toBeNull();
  expect(view.read().state.holidayRanges).toEqual([
    { from: "2026-10-20", to: "2026-10-22" }, { from: "2026-11-01", to: "2026-11-03" },
  ]);
  expect(remote?.holidayRanges).toEqual(view.read().state.holidayRanges);
});

it("recovers the actual conflict UI without deleting local/server bookings, manual choices or an older backup", async () => {
  const row = (id: string) => ({
    id, bank: "Amex", pocket: "Amex", date: "2026-10-06",
    description: "Public Duty Free", amount: -42, category: "Shopping" as const, includeInPlan: true,
  });
  const local = { ...createEmptyAccountState(), transactions: [
    row("local"), { ...row("shared"), manualCategory: true, category: "Geschenke & Spenden" as const },
  ] };
  remote = { ...createEmptyAccountState(), transactions: [row("shared"), row("server")] };
  revision = 2;
  localStorage.setItem(accountStorageKey(account.id), JSON.stringify({ state: local, revision: 1, pending: true }));
  const original = JSON.stringify({ state: local, revision: 0, pending: true });
  localStorage.setItem(accountConflictKey(account.id), original);
  const view = mount(false, true);
  await waitFor(() => expect(view.read().saved).toBe(true));
  expect(new Set(view.read().state.transactions.map((booking) => booking.id))).toEqual(new Set(["local", "shared", "server"]));
  expect(remote?.transactions.find((booking) => booking.id === "shared")?.category).toBe("Geschenke & Spenden");
  expect(view.read().storageError).toBeNull();
  expect(localStorage.getItem(accountConflictKey(account.id))).toBe(original);
  expect(screen.queryByText("Lokale Konfliktsicherung")).toBeNull();
  expect(screen.queryByRole("button", { name: "Serverstand laden" })).toBeNull();
});

it("automatically resumes a failed merged acknowledgement without dropping server rows", async () => {
  const view = mount(false, true);
  await waitFor(() => expect(view.read().saved).toBe(true));
  remote = { ...remote!, transactions: [{ id: "server", bank: "Amex", pocket: "Amex",
    date: "2026-10-06", description: "Public Duty Free", amount: -42, category: "Shopping", includeInPlan: true }] };
  revision++;
  const normal = request.getMockImplementation();
  if (!normal) throw new Error("Finance request fixture missing");
  let writes = 0;
  request.mockImplementation(async (url: string, options: RequestInit) => {
    if (options.method === "PUT") {
      writes++;
      if (writes === 1) return new Response(null, { status: 409 });
      if (writes === 2) throw new TypeError("Acknowledgement lost");
    }
    return normal(url, options);
  });
  act(() => view.read().update((state) => ({ ...state, transactions: [{ ...remote!.transactions[0], id: "local" }] })));
  await waitFor(() => expect(view.read().storageError).toContain("Server nicht erreichbar"));
  expect(new Set(view.read().state.transactions.map((row) => row.id))).toEqual(new Set(["local", "server"]));
  await waitFor(() => expect(view.read().saved).toBe(true), { timeout: 7_000 });
  expect(new Set(remote?.transactions.map((row) => row.id))).toEqual(new Set(["local", "server"]));
});

it("automatically preserves newer working edits whose cache save failed during reconciliation", async () => {
    const view = mount(false, true);
    await waitFor(() => expect(view.read().saved).toBe(true));
    remote = { ...remote!, transactions: [{ id: "server", bank: "Amex", pocket: "Amex",
      date: "2026-10-06", description: "Public Duty Free", amount: -42, category: "Shopping", includeInPlan: true }] };
    revision++;
    const normal = request.getMockImplementation();
    if (!normal) throw new Error("Finance request fixture missing");
    let finish!: () => void;
    let writes = 0;
    request.mockImplementation(async (url: string, options: RequestInit) => {
      if (options.method !== "PUT") return normal(url, options);
      writes++;
      if (writes === 1) return new Response(null, { status: 409 });
      if (writes > 2) return normal(url, options);
      const sent = JSON.parse(String(options.body));
      return new Promise<Response>((resolve) => { finish = () => {
        remote = sent.state;
        revision++;
        resolve(Response.json({ state: remote, revision }));
      }; });
    });
    act(() => view.read().update((state) => ({ ...state, transactions: [{ ...remote!.transactions[0], id: "local" }] })));
    await waitFor(() => expect(finish).toBeDefined());
    const full = () => { throw new DOMException("quota", "QuotaExceededError"); };
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(full).mockImplementationOnce(full);
    act(() => view.read().update((state) => ({ ...state, settings: { ...state.settings, emergencyTarget: 123 } })));
    await waitFor(() => expect(view.read().storageError).toContain("Browserspeicher"));
    await act(async () => finish());
    expect(view.read().state.settings.emergencyTarget).toBe(123);
    await waitFor(() => expect(view.read().saved).toBe(true), { timeout: 7_000 });
    expect(view.read().state.settings.emergencyTarget).toBe(123);
    expect(remote?.settings.emergencyTarget).toBe(123);
    expect(remote?.transactions.map((row) => row.id)).toEqual(["local", "server"]);
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

it("automatically recovers a transient background-read error without a user retry", async () => {
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  request.mockRejectedValueOnce(new TypeError("offline"));
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(request.mock.calls.filter((call) => call[1].method === "GET").length).toBeGreaterThan(2));
  await waitFor(() => expect(view.read().saved).toBe(true));
  act(() => view.read().update((state) => ({ ...state, holidayRanges: [{ from: "2026-10-20", to: "2026-10-22" }] })));
  await waitFor(() => expect(view.read().saved).toBe(true));
  expect(remote?.holidayRanges).toEqual([{ from: "2026-10-20", to: "2026-10-22" }]);
});

it("retries the current working state after a cache-quota failure, never the older cached server data", async () => {
  const view = mount();
  await waitFor(() => expect(view.read().saved).toBe(true));
  const full = () => { throw new DOMException("quota", "QuotaExceededError"); };
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(full).mockImplementationOnce(full);

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
