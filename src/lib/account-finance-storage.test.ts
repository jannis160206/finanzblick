// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountFinanceStorage, AccountSessionError, accountStorageKey } from "./account-finance-storage";
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
    expect(controller.error?.message).toContain("zu lange gedauert");
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
    expect(cached()).toEqual({ state, revision: 0, pending: true });
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
    expect(controller.error?.message).toContain("Neuere Daten");
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
