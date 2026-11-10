// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountFinanceStorage, AccountSessionError, accountStorageKey, accountConflictKey, discardAccountConflictBackup, parseAccountConflictBackup } from "./account-finance-storage";
import { createEmptyAccountState } from "./account-state";
import { appStateSchema, type AppState } from "./types";

const changed = (label: string): AppState => ({
  ...createEmptyAccountState(),
  transactions: [{ id: label, bank: "Amex", pocket: "Amex", date: "2026-10-06", description: label,
    amount: -42, category: "Shopping", includeInPlan: true }],
});
const response = (state: AppState | null, revision: number) => Response.json({ state, revision });
const cached = (id = "alice") => JSON.parse(localStorage.getItem(accountStorageKey(id))!);
beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function storage(id = "alice") {
  const saved = vi.fn();
  const error = vi.fn();
  return { controller: new AccountFinanceStorage(id, saved, error), saved, error };
}

describe("account finance persistence", () => {
  it("starts from a server-rendered snapshot without requesting it again", async () => {
    const server = changed("server");
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const { controller } = storage();
    expect(await controller.load({ state: server, revision: 4 })).toEqual(server);
    expect(request).not.toHaveBeenCalled();
    expect(cached()).toMatchObject({ revision: 4, pending: false });
  });
  it("keeps pending device changes when the server-rendered snapshot is newer", async () => {
    const local = changed("local");
    localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 2, pending: true }));
    vi.stubGlobal("fetch", vi.fn());
    const { controller } = storage();
    expect(await controller.load({ state: changed("server"), revision: 3 })).toEqual(local);
    expect(controller.error).not.toBeNull();
  });
  it("does not duplicate large booking/review/receipt data in the persisted baseline", async () => {
    const base = changed("shared");
    base.transactions = Array.from({ length: 3_062 }, (_, id) => ({ ...base.transactions[0],
      id: `booking-${id}`, description: "Synthetic known purchase".repeat(12) }));
    base.reviewQueue = [{ kind: "booking", id: "proposal", draft: { ...base.transactions[0], id: "proposal" }, message: "Approval needed" }];
    base.fixedReceipts = [{ key: "receipt", amount: -42, date: base.transactions[0].date,
      category: "Shopping", booking: base.transactions[0] }];
    const { controller } = storage();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(base, 2)));
    await controller.load();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Offline")));
    const local = { ...base, settings: { ...base.settings, emergencyTarget: 123 } };
    controller.save(local);
    const primary = cached();
    expect(primary.state).toEqual(local);
    expect(primary.baseState.settings).toEqual(base.settings);
    for (const field of ["transactions", "fixedReceipts", "reviewQueue"])
      expect(primary.baseState[field]).toBeUndefined();
    expect(JSON.stringify(primary.baseState).length).toBeLessThan(JSON.stringify(base).length / 10);
    await vi.waitFor(() => expect(controller.error).not.toBeNull());
  });
  it("restores the common baseline after reload and safely combines independent settings", async () => {
    const base = changed("shared"), local = structuredClone(base), remote = structuredClone(base);
    local.settings.emergencyTarget = 123;
    remote.settings.vacationTarget = 456;
    localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 2, pending: true, baseState: base }));
    const request = vi.fn().mockResolvedValue(response(remote, 3));
    request.mockImplementation(async (_url: string, options: RequestInit) => {
      if (options.method !== "PUT") return response(remote, 3);
      const sent = JSON.parse(String(options.body));
      return response(appStateSchema.parse(sent.state), 4);
    });
    vi.stubGlobal("fetch", request);
    const { controller } = storage();
    expect(await controller.load()).toEqual(local);
    const combined = await controller.reconcileServer(local);
    expect(combined.settings.emergencyTarget).toBe(123);
    expect(combined.settings.vacationTarget).toBe(456);
    expect(cached()).toEqual({ state: combined, revision: 4, pending: false });
  });
  it("surfaces a failed response body or timeout without erasing pending changes", async () => {
    const local = changed("pending");
    localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 2, pending: true }));
    const reply = response(local, 2);
    vi.spyOn(reply, "json").mockRejectedValue(new TypeError("Response stream disconnected"));
    const fetcher = vi.fn().mockResolvedValueOnce(reply)
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    vi.stubGlobal("fetch", fetcher);
    const { controller } = storage();
    expect(await controller.load()).toEqual(local);
    expect(controller.error?.message).toContain("Serverantwort ist unlesbar");
    expect(await controller.retry(local)).toEqual(local);
    expect(controller.error?.message).toContain("dauert länger");
    expect(cached().pending).toBe(true);
  });
  it("does not import shared legacy data or another user's cache", async () => {
    localStorage.setItem("finanzdashboard.v1", JSON.stringify(changed("private legacy")));
    localStorage.setItem(accountStorageKey("bob"), JSON.stringify({ state: changed("bob"), pending: false, revision: 7 }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(null, 0)));
    expect(await storage().controller.load()).toBeNull();
    expect(localStorage.getItem(accountStorageKey("alice"))).toBeNull();
  });

  it("coalesces StrictMode hydration into one request", async () => {
    const request = vi.fn().mockResolvedValue(response(changed("server"), 2));
    vi.stubGlobal("fetch", request);
    const { controller } = storage();
    const [a, b] = await Promise.all([controller.load(), controller.load()]);
    expect(a).toEqual(b);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("writes the complete local pending snapshot immediately and waits for server confirmation", async () => {
    let finish!: (result: Response) => void;
    const request = vi.fn().mockResolvedValueOnce(response(null, 0))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", request);
    const { controller, saved } = storage();
    await controller.load();
    const state = changed("confirmed");
    state.holidayRanges = [{ from: "2026-10-01", to: "2026-10-03" }];
    state.merchantRules = [{ key: "amex|confirmed", category: "Shopping", merchantAlias: "Mein Einkauf" }];
    controller.save(state);
    expect(cached()).toEqual({ state, revision: 0, pending: true, baseState: null });
    expect(saved).not.toHaveBeenCalled();
    finish(response(state, 1));
    await vi.waitFor(() => expect(saved).toHaveBeenCalledWith(state));
    expect(cached().pending).toBe(false);
    expect(request.mock.calls[1][1].headers["X-Finanzblick-Account"]).toBe("alice");
  });

  it("serializes edits made during a write and never acknowledges an older state as the latest", async () => {
    let finish!: (result: Response) => void;
    const first = changed("first"), second = changed("second");
    const request = vi.fn().mockResolvedValueOnce(response(null, 0))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(response(second, 2));
    vi.stubGlobal("fetch", request);
    const { controller, saved } = storage();
    await controller.load();
    controller.save(first);
    controller.save(second);
    expect(cached().state).toEqual(second);
    finish(response(first, 1));
    await vi.waitFor(() => expect(saved).toHaveBeenCalledWith(second));
    expect(saved).not.toHaveBeenCalledWith(first);
    expect(JSON.parse(request.mock.calls[2][1].body).revision).toBe(1);
    expect(cached()).toEqual({ state: second, revision: 2, pending: false });
  });

  it("acknowledges an identical new state object during a write without a redundant PUT", async () => {
    let finish!: (result: Response) => void;
    const request = vi.fn().mockResolvedValueOnce(response(null, 0))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", request);
    const { controller, saved } = storage();
    await controller.load();
    const first = changed("same"), next = structuredClone(first);
    controller.save(first);
    controller.save(next);
    finish(response(first, 1));
    await vi.waitFor(() => expect(saved).toHaveBeenCalledWith(next));
    expect(saved.mock.calls[0][0]).toBe(next);
    expect(request).toHaveBeenCalledTimes(2);
    expect(cached().pending).toBe(false);
  });

  it("does not generate a write for an unchanged polled snapshot", async () => {
    const state = appStateSchema.parse(changed("same"));
    const request = vi.fn().mockResolvedValue(response(state, 3));
    vi.stubGlobal("fetch", request);
    const { controller, saved } = storage();
    await controller.load();
    controller.save(state);
    expect(saved).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  describe("data-preserving server reconciliation", () => {
    it("keeps both stands, protected categories and an older conflict copy, then persists the merged revision", async () => {
      const local = changed("local"), remote = changed("server");
      local.transactions.push({ ...changed("shared").transactions[0], manualCategory: true, category: "Geschenke & Spenden" });
      remote.transactions.push(changed("shared").transactions[0]);
      localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 1, pending: true }));
      const older = JSON.stringify({ state: changed("older conflict"), revision: 0, pending: true });
      localStorage.setItem(accountConflictKey("alice"), older);
      const request = vi.fn().mockResolvedValueOnce(response(remote, 2)).mockResolvedValueOnce(response(remote, 2))
        .mockImplementationOnce(async (_url: string, options: RequestInit) => response(JSON.parse(String(options.body)).state, 3));
      vi.stubGlobal("fetch", request);
      const { controller } = storage();
      await controller.load();
      const result = await controller.reconcileServer(local);
      expect(result.transactions.map((row) => row.id)).toEqual(["local", "shared", "server"]);
      expect(result.transactions.find((row) => row.id === "shared")?.category).toBe("Geschenke & Spenden");
      expect(cached()).toEqual({ state: result, revision: 3, pending: false });
      expect(controller.error).toBeNull();
      expect(localStorage.getItem(accountConflictKey("alice"))).toBe(older);
      expect(JSON.parse(request.mock.calls[2][1].body).revision).toBe(2);
    });

    it("releases a conflict copy once the confirmed server stand holds all of its values", async () => {
      const local = changed("local"), remote = structuredClone(local);
      remote.transactions.push(changed("server").transactions[0]);
      localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 1, pending: true }));
      const request = vi.fn().mockResolvedValueOnce(response(remote, 2)).mockResolvedValueOnce(response(remote, 2))
        .mockImplementationOnce(async (_url: string, options: RequestInit) => response(JSON.parse(String(options.body)).state, 3));
      vi.stubGlobal("fetch", request);
      const { controller } = storage();
      await controller.load();
      await controller.reconcileServer(local);
      expect(cached().pending).toBe(false);
      expect(localStorage.getItem(accountConflictKey("alice"))).toBeNull();
    });

    it("retries a worker revision race from fresh server evidence without dropping local or server additions", async () => {
      const local = changed("local"), first = changed("server-first"), second = changed("server-second");
      second.transactions.push(...first.transactions);
      localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 1, pending: true }));
      const request = vi.fn().mockResolvedValueOnce(response(first, 2)).mockResolvedValueOnce(response(first, 2))
        .mockResolvedValueOnce(new Response(null, { status: 409 })).mockResolvedValueOnce(response(second, 3))
        .mockImplementationOnce(async (_url: string, options: RequestInit) => response(JSON.parse(String(options.body)).state, 4));
      vi.stubGlobal("fetch", request);
      const { controller } = storage();
      await controller.load();
      const result = await controller.reconcileServer(local);
      expect(new Set(result.transactions.map((row) => row.id))).toEqual(new Set(["local", "server-first", "server-second"]));
      expect(cached().revision).toBe(4);
      expect(cached().pending).toBe(false);
      expect(localStorage.getItem(accountConflictKey("alice"))).toBeNull();
    });

    it("stops bounded revision retries explicitly while keeping the complete merged device stand", async () => {
      const local = changed("local"), remote = changed("server");
      localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 1, pending: true }));
      const request = vi.fn().mockImplementation(async (_url: string, options: RequestInit) =>
        options.method === "PUT" ? new Response(null, { status: 409 }) : response(remote, 2));
      vi.stubGlobal("fetch", request);
      const { controller } = storage();
      await controller.load();
      await expect(controller.reconcileServer(local)).rejects.toThrow(/neuere Änderungen/);
      expect(request.mock.calls.filter((call) => call[1].method === "PUT")).toHaveLength(3);
      expect(cached().state.transactions.map((row: { id: string }) => row.id)).toEqual(["local", "server"]);
      expect(cached().pending).toBe(true);
    });

    it("takes the bank's newest booking amount automatically and keeps an older conflict copy untouched", async () => {
      const local = changed("shared"), remote = changed("shared");
      remote.transactions[0].amount = -84;
      localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 1, pending: true }));
      localStorage.setItem(accountConflictKey("alice"), "older preserved original");
      const request = vi.fn().mockImplementation(async (_url: string, options: RequestInit) =>
        options.method === "PUT" ? response(JSON.parse(String(options.body)).state, 3) : response(remote, 2));
      vi.stubGlobal("fetch", request);
      const { controller } = storage();
      await controller.load();
      const result = await controller.reconcileServer(local);
      expect(result.transactions[0].amount).toBe(-84);
      expect(cached().pending).toBe(false);
      expect(localStorage.getItem(accountConflictKey("alice"))).toBe("older preserved original");
    });

    it("merges a stand another tab wrote meanwhile instead of stopping", async () => {
      const request = vi.fn().mockImplementation(async (_url: string, options: RequestInit) =>
        options.method === "PUT" ? response(JSON.parse(String(options.body)).state, 4) : response(changed("initial"), 2));
      vi.stubGlobal("fetch", request);
      const { controller } = storage();
      await controller.load();
      const other = changed("initial");
      other.transactions.push(changed("other tab").transactions[0]);
      localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: other, revision: 2, pending: true }));
      const mine = changed("initial");
      mine.transactions.push(changed("this tab").transactions[0]);
      expect(() => controller.save(mine)).toThrow(/anderer Tab/);
      const result = await controller.reconcileServer(mine);
      expect(new Set(result.transactions.map((row) => row.id))).toEqual(new Set(["initial", "other tab", "this tab"]));
      expect(cached().pending).toBe(false);
    });

    it.each(["device", "other tab"])("preserves new %s edits while a reconciliation read is pending", async (source) => {
      const local = changed("local"), remote = changed("server"), newer = changed("newer device");
      localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 1, pending: true }));
      let finish!: (result: Response) => void;
      const request = vi.fn().mockResolvedValueOnce(response(remote, 2))
        .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
      vi.stubGlobal("fetch", request);
      const { controller } = storage();
      await controller.load();
      const pending = controller.reconcileServer(local);
      if (source === "device") controller.save(newer);
      else localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: newer, revision: 1, pending: true }));
      finish(response(remote, 2));
      await expect(pending).rejects.toThrow(/Gerätestand wurde aktualisiert/);
      expect(cached().state).toEqual(newer);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it("leaves a complete pending merged stand after a failed network acknowledgement", async () => {
      const local = changed("local"), remote = changed("server");
      localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 1, pending: true }));
      const request = vi.fn().mockResolvedValueOnce(response(remote, 2)).mockResolvedValueOnce(response(remote, 2))
        .mockRejectedValueOnce(new TypeError("network"));
      vi.stubGlobal("fetch", request);
      const { controller } = storage();
      await controller.load();
      await expect(controller.reconcileServer(local)).rejects.toThrow(/Server nicht erreichbar/);
      expect(cached().state.transactions.map((row: { id: string }) => row.id)).toEqual(["local", "server"]);
      expect(cached().pending).toBe(true);
      expect(JSON.parse(localStorage.getItem(accountConflictKey("alice"))!).state).toEqual(local);
      const puts = request.mock.calls.filter((call) => call[1].method === "PUT").length;
      request.mockResolvedValue(response(remote, 2));
      expect((await controller.retry(local))?.transactions.map((row) => row.id)).toEqual(["local", "server"]);
      controller.save(local);
      expect(controller.error?.message).toContain("Abgleich ist noch nicht abgeschlossen");
      expect(cached().reconcileRequired).toBe(true);
      expect(cached().state.transactions.map((row: { id: string }) => row.id)).toEqual(["local", "server"]);
      expect(request.mock.calls.filter((call) => call[1].method === "PUT")).toHaveLength(puts);
    });

    it("falls back to a single local copy when a large ledger cannot also store its merge baseline", async () => {
      const local = changed("local"), remote = changed("server");
      localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 1, pending: true }));
      const request = vi.fn().mockImplementation(async (_url: string, options: RequestInit) =>
        options.method === "PUT" ? response(JSON.parse(String(options.body)).state, 3) : response(remote, 2));
      vi.stubGlobal("fetch", request);
      const { controller } = storage();
      await controller.load();
      const original = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
        if (key === accountStorageKey("alice") && JSON.parse(value).baseState) throw new DOMException("full", "QuotaExceededError");
        original.call(this, key, value);
      });
      const result = await controller.reconcileServer(local);
      expect(result.transactions.map((row) => row.id)).toEqual(["local", "server"]);
      expect(cached().pending).toBe(false);
      expect(cached().revision).toBe(3);
    });

    it("never sends a merged stand when its crash-safe local copy or backup cannot be written", async () => {
      const local = changed("local"), remote = changed("server");
      const raw = JSON.stringify({ state: local, revision: 1, pending: true });
      localStorage.setItem(accountStorageKey("alice"), raw);
      const request = vi.fn().mockImplementation(async () => response(remote, 2));
      vi.stubGlobal("fetch", request);
      const { controller } = storage();
      await controller.load();
      const original = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
        if (key === accountConflictKey("alice")) throw new DOMException("full", "QuotaExceededError");
        original.call(this, key, value);
      });
      await expect(controller.reconcileServer(local)).rejects.toThrow(DOMException);
      expect(localStorage.getItem(accountStorageKey("alice"))).toBe(raw);
      expect(request.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
    });
  });

  it("keeps unsynced edits across reload and a failed network connection", async () => {
    const state = changed("offline");
    localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state, revision: 3, pending: true }));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    const { controller } = storage();
    expect(await controller.load()).toEqual(state);
    expect(controller.error?.message).toContain("Server nicht erreichbar");
    controller.save(changed("offline next"));
    expect(cached().state.transactions[0].description).toBe("offline next");
    expect(cached().pending).toBe(true);
  });

  it("retains conflicted pending state instead of overwriting newer server edits", async () => {
    const local = changed("local");
    localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 2, pending: true }));
    const request = vi.fn().mockResolvedValue(response(changed("newer server"), 4));
    vi.stubGlobal("fetch", request);
    const { controller } = storage();
    expect(await controller.load()).toEqual(local);
    expect(controller.error?.message).toContain("Neuere Serverdaten");
    controller.save(local);
    expect(request).toHaveBeenCalledOnce();
    expect(cached().revision).toBe(2);
  });

  it("preserves the conflicted local copy when explicitly loading the server", async () => {
    const local = changed("local"), remote = changed("remote");
    localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: local, revision: 2, pending: true }));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(response(remote, 4))));
    const { controller } = storage();
    await controller.load();
    expect(await controller.useServer()).toEqual(remote);
    expect(JSON.parse(localStorage.getItem(`${accountStorageKey("alice")}.conflict-backup`)!).state).toEqual(local);
    expect(cached().state).toEqual(remote);
  });

  it("archives the exact pending primary text rather than reserializing a reviewed copy", async () => {
    const raw = JSON.stringify({ state: changed("pending"), revision: 2, pending: true }, null, 2);
    localStorage.setItem(accountStorageKey("alice"), raw);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response(changed("remote"), 4)));
    const { controller } = storage();
    await controller.load();
    await controller.useServer();
    expect(localStorage.getItem(accountConflictKey("alice"))).toBe(raw);
  });

  it("forgets an old parsed cache when a subsequent load rejects the primary and archives that original", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response(changed("remote"), 4)));
    const { controller } = storage();
    await controller.load();
    const raw = "{malformed newer primary";
    localStorage.setItem(accountStorageKey("alice"), raw);
    await expect(controller.retry()).rejects.toThrow(/unlesbar/);
    expect(controller.cachedState).toBeUndefined();
    await controller.useServer();
    expect(localStorage.getItem(accountConflictKey("alice"))).toBe(raw);
    expect(cached().state).toEqual(changed("remote"));
  });

  it("never overwrites an unresolved older or malformed conflict copy on a successive server choice", async () => {
    const key = accountStorageKey("alice");
    const local = changed("new local");
    const raw = JSON.stringify({ state: local, revision: 2, pending: true });
    localStorage.setItem(key, raw);
    localStorage.setItem(accountConflictKey("alice"), "{older unreadable original");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response(changed("remote"), 4)));
    const { controller } = storage();
    await controller.load();
    await expect(controller.useServer()).rejects.toThrow(/ältere Konfliktsicherung/);
    expect(localStorage.getItem(accountConflictKey("alice"))).toBe("{older unreadable original");
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it("lets the server stand replace a reconciled device stand whose older conflict copy it already contains", async () => {
    const key = accountStorageKey("alice");
    const older = JSON.stringify({ state: changed("old local"), revision: 1, pending: true });
    const merged = changed("old local");
    merged.transactions.push(...changed("server").transactions);
    localStorage.setItem(key, JSON.stringify({ state: merged, revision: 2, pending: true, reconcileRequired: true }));
    localStorage.setItem(accountConflictKey("alice"), older);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response(changed("remote"), 4)));
    const { controller } = storage();
    await controller.load();
    expect((await controller.useServer())?.transactions.map((row) => row.id)).toEqual(["remote"]);
    expect(JSON.parse(localStorage.getItem(accountConflictKey("alice"))!).state).toEqual(merged);
    expect(cached().pending).toBe(false);
  });

  it("merges an older conflict copy with new device changes before loading the server stand", async () => {
    const key = accountStorageKey("alice");
    localStorage.setItem(key, JSON.stringify({ state: changed("new local"), revision: 2, pending: true }));
    localStorage.setItem(accountConflictKey("alice"), JSON.stringify({ state: changed("old local"), revision: 1, pending: true }));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response(changed("remote"), 4)));
    const { controller } = storage();
    await controller.load();
    await controller.useServer();
    const backup = JSON.parse(localStorage.getItem(accountConflictKey("alice"))!).state;
    expect(new Set(backup.transactions.map((row: { id: string }) => row.id))).toEqual(new Set(["new local", "old local"]));
  });

  it("keeps pending data unchanged if the conflict backup cannot be written", async () => {
    const raw = JSON.stringify({ state: changed("pending"), revision: 1, pending: true });
    localStorage.setItem(accountStorageKey("alice"), raw);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response(changed("remote"), 3)));
    const { controller } = storage();
    await controller.load();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    await expect(controller.useServer()).rejects.toThrow(DOMException);
    expect(localStorage.getItem(accountStorageKey("alice"))).toBe(raw);
    expect(localStorage.getItem(accountConflictKey("alice"))).toBeNull();
  });

  it.each(["cache", "conflict"])("rejects a %s change in another tab while loading the server", async (target) => {
    const raw = JSON.stringify({ state: changed("pending"), revision: 1, pending: true });
    localStorage.setItem(accountStorageKey("alice"), raw);
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(changed("remote"), 3))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const { controller } = storage();
    await controller.load();
    const loading = controller.useServer();
    const key = target === "cache" ? accountStorageKey("alice") : accountConflictKey("alice");
    localStorage.setItem(key, "changed in another tab");
    finish(response(changed("remote"), 3));
    await expect(loading).rejects.toThrow(/anderer Tab|zwischenzeitlich/);
    expect(localStorage.getItem(key)).toBe("changed in another tab");
    if (target === "conflict") expect(localStorage.getItem(accountStorageKey("alice"))).toBe(raw);
  });

  it("validates historical cache blobs and raw AppState copies without mutating their originals", () => {
    const state = changed("legacy backup");
    const raw = JSON.stringify({ state, revision: 2, pending: true });
    expect(parseAccountConflictBackup(raw, "alice")).toEqual(state);
    expect(parseAccountConflictBackup(JSON.stringify(state), "alice")).toEqual(state);
    expect(() => parseAccountConflictBackup("{broken", "alice")).toThrow(/unlesbar/);
    expect(() => parseAccountConflictBackup(JSON.stringify({ state, revision: -1, pending: true }), "alice")).toThrow(/ungültig/);
  });

  it("requires exact reviewed raw data to discard and touches only that account", () => {
    localStorage.setItem(accountConflictKey("alice"), "new copy");
    localStorage.setItem(accountConflictKey("bob"), "bob private");
    expect(() => discardAccountConflictBackup("alice", "reviewed old copy")).toThrow(/zwischenzeitlich/);
    expect(localStorage.getItem(accountConflictKey("alice"))).toBe("new copy");
    discardAccountConflictBackup("alice", "new copy");
    expect(localStorage.getItem(accountConflictKey("alice"))).toBeNull();
    expect(localStorage.getItem(accountConflictKey("bob"))).toBe("bob private");
  });

  it("keeps another tab's pending cache that changed before the server confirmation", async () => {
    const request = vi.fn().mockImplementation(async () => response(changed("remote"), 4));
    localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: changed("own pending"), revision: 1, pending: true }));
    vi.stubGlobal("fetch", request);
    const { controller } = storage();
    await controller.load();
    const newer = JSON.stringify({ state: changed("other tab pending"), revision: 2, pending: true });
    localStorage.setItem(accountStorageKey("alice"), newer);
    await expect(controller.useServer()).rejects.toThrow(/anderer Tab/);
    expect(localStorage.getItem(accountStorageKey("alice"))).toBe(newer);
    expect(localStorage.getItem(accountConflictKey("alice"))).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it("recognizes a committed write whose acknowledgement was lost", async () => {
    const state = changed("already committed");
    localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state, revision: 2, pending: true }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(state, 3)));
    const { controller } = storage();
    expect(await controller.load()).toEqual(state);
    expect(controller.error).toBeNull();
    expect(cached().pending).toBe(false);
    expect(cached().revision).toBe(3);
  });

  it("rejects stale writes from another tab before sending them to the server", async () => {
    const request = vi.fn().mockResolvedValue(response(changed("initial"), 2));
    vi.stubGlobal("fetch", request);
    const { controller } = storage();
    await controller.load();
    const newer = { state: changed("newer tab"), revision: 3, pending: false };
    localStorage.setItem(accountStorageKey("alice"), JSON.stringify(newer));
    expect(() => controller.save(changed("stale"))).toThrow(/anderer Tab/);
    expect(cached()).toEqual(newer);
    expect(request).toHaveBeenCalledOnce();
  });

  it("preserves malformed local data and rejects invalid server payloads", async () => {
    const { controller } = storage();
    localStorage.setItem(accountStorageKey("alice"), "{broken");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ state: { transactions: [] }, revision: 3 })));
    await expect(controller.load()).rejects.toThrow(/unlesbar/);
    expect(localStorage.getItem(accountStorageKey("alice"))).toBe("{broken");
    localStorage.removeItem(accountStorageKey("alice"));
    await expect(controller.load()).rejects.toThrow(/ungültige/);
  });

  it.each(["malformed", "duplicate IDs"])("archives the exact rejected %s primary before explicit server replacement", async (kind) => {
    const local = changed("rejected local");
    if (kind === "duplicate IDs") local.transactions.push({ ...local.transactions[0] });
    const raw = kind === "malformed" ? "{unreadable primary" : JSON.stringify({ state: local, revision: 1, pending: true }, null, 2);
    localStorage.setItem(accountStorageKey("alice"), raw);
    const remote = changed("remote");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response(remote, 4)));
    const { controller } = storage();
    await expect(controller.load()).rejects.toThrow(/unlesbar|ungültig/);
    expect(controller.cachedState).toBeUndefined();
    expect(await controller.useServer()).toEqual(remote);
    expect(localStorage.getItem(accountConflictKey("alice"))).toBe(raw);
    expect(cached().state).toEqual(remote);
  });

  it.each(["older conflict", "backup write blocked", "server write blocked"])(
    "preserves a rejected primary when replacement fails: %s", async (reason) => {
      const raw = "{unreadable primary";
      const key = accountStorageKey("alice");
      localStorage.setItem(key, raw);
      if (reason === "older conflict") localStorage.setItem(accountConflictKey("alice"), "older unresolved copy");
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response(changed("remote"), 4)));
      const { controller } = storage();
      await expect(controller.load()).rejects.toThrow(/unlesbar/);
      if (reason !== "older conflict") {
        const set = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, target, value) {
          if (target === (reason === "backup write blocked" ? accountConflictKey("alice") : key))
            throw new DOMException("blocked", "QuotaExceededError");
          set.call(this, target, value);
        });
      }
      await expect(controller.useServer()).rejects.toThrow();
      expect(localStorage.getItem(key)).toBe(raw);
      expect(localStorage.getItem(accountConflictKey("alice"))).toBe(
        reason === "older conflict" ? "older unresolved copy" : reason === "server write blocked" ? raw : null,
      );
    },
  );

  it("preserves a rejected primary even when replacing it with an empty server account", async () => {
    const raw = "{unreadable primary";
    localStorage.setItem(accountStorageKey("alice"), raw);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(null, 0)));
    const { controller } = storage();
    await expect(controller.load()).rejects.toThrow(/unlesbar/);
    expect(await controller.useServer()).toBeNull();
    expect(localStorage.getItem(accountStorageKey("alice"))).toBeNull();
    expect(localStorage.getItem(accountConflictKey("alice"))).toBe(raw);
  });

  it("reports 401 without writing to another account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "login" }, { status: 401 })));
    await expect(storage().controller.load()).rejects.toBeInstanceOf(AccountSessionError);
    expect(localStorage.getItem(accountStorageKey("alice"))).toBeNull();
  });

  it("retains pending state and surfaces a rejected write", async () => {
    const request = vi.fn().mockResolvedValueOnce(response(null, 0))
      .mockResolvedValueOnce(Response.json({ error: "conflict" }, { status: 409 }));
    vi.stubGlobal("fetch", request);
    const { controller, error, saved } = storage();
    await controller.load();
    controller.save(changed("pending"));
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(saved).not.toHaveBeenCalled();
    expect(cached().pending).toBe(true);
  });

  it("flushes edits made while a background read is in flight", async () => {
    let finish!: (result: Response) => void;
    const first = changed("initial"), next = changed("during poll");
    const request = vi.fn().mockResolvedValueOnce(response(first, 1))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(response(next, 2));
    vi.stubGlobal("fetch", request);
    const { controller, saved } = storage();
    await controller.load();
    const polling = controller.poll();
    controller.save(next);
    finish(response(first, 1));
    await polling;
    await vi.waitFor(() => expect(saved).toHaveBeenCalledWith(next));
    expect(cached().pending).toBe(false);
  });

  it("does not discard new edits made after confirming a server replacement", async () => {
    const first = changed("initial");
    localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: first, revision: 2, pending: true }));
    let finish!: (result: Response) => void;
    const request = vi.fn().mockResolvedValueOnce(response(changed("remote"), 4))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", request);
    const { controller } = storage();
    await controller.load();
    const replacement = controller.useServer();
    controller.save(changed("new edit"));
    finish(response(changed("remote"), 4));
    await expect(replacement).rejects.toThrow(/neue Änderungen/);
    expect(cached().state.transactions[0].description).toBe("new edit");
    expect(cached().pending).toBe(true);
  });

  it("keeps edits made while retrying a previously failed synchronization", async () => {
    const first = changed("first"), next = changed("retry edit");
    localStorage.setItem(accountStorageKey("alice"), JSON.stringify({ state: first, revision: 2, pending: true }));
    let finish!: (result: Response) => void;
    const request = vi.fn().mockRejectedValueOnce(new TypeError("offline"))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", request);
    const { controller } = storage();
    await controller.load();
    const retry = controller.retry();
    controller.save(next);
    finish(response(first, 2));
    expect(await retry).toEqual(next);
    expect(cached().state).toEqual(next);
  });
});
