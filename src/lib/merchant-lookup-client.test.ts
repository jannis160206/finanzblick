// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { merchantLookupTtl } from "./merchant-lookup-schema";

const storageKey = "finanzblick.merchant-lookup-cache.v1";
const result = {
  id: "123",
  name: "BILLA",
  displayName: "BILLA, Klagenfurt, Kärnten, Österreich",
};
const fetchMock = vi.fn<typeof fetch>();
let lookupMerchant: typeof import("./merchant-lookup-client").lookupMerchant;

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((finish) => { resolve = finish; });
  fetchMock.mockReturnValueOnce(promise);
  return resolve;
}

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
  fetchMock.mockReset().mockImplementation(async () => Response.json({ results: [result] }));
  vi.stubGlobal("fetch", fetchMock);
  lookupMerchant = (await import("./merchant-lookup-client")).lookupMerchant;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("browser merchant lookup transport", () => {
  it("does nothing on import and posts only the merchant query to the local API", async () => {
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(await lookupMerchant(" ＢＩＬＬＡ   Klagenfurt ")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/merchant-lookup");
    expect(String(url)).not.toContain("nominatim");
    expect(options).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(JSON.parse(String(options?.body))).toEqual({ query: "billa klagenfurt" });
    expect(options?.signal).toBeDefined();
  });

  it.each(["", " ", "A", "12345", "a".repeat(181), "ﬃ".repeat(100)])(
    "rejects invalid query %j without HTTP or storage",
    async (query) => {
      await expect(lookupMerchant(query)).rejects.toThrow("gültigen Händlernamen");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(localStorage.length).toBe(0);
    },
  );

  it("coalesces identical pending queries and rejects distinct concurrent queries without another HTTP request", async () => {
    const resolve = deferredResponse();
    const first = lookupMerchant(" BILLA ");
    const identical = lookupMerchant("billa");
    await expect(lookupMerchant("Spar")).rejects.toThrow("Händlersuche läuft bereits");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(Response.json({ results: [result] }));
    expect(await first).toEqual([result]);
    expect(await identical).toEqual([result]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses normalized memory hits without HTTP or another storage read", async () => {
    await lookupMerchant("Billa");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(await lookupMerchant(" ＢＩＬＬＡ ")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not let callers mutate cached results", async () => {
    const first = await lookupMerchant("Billa");
    first[0].name = "Changed";
    first.push({ ...result, id: "456" });
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses entries another tab persisted after an earlier lookup, without another HTTP request", async () => {
    await lookupMerchant("Billa");
    localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      entries: [{ query: "spar", cachedAt: Date.now(), results: [] }],
    }));
    expect(await lookupMerchant("SPAR")).toEqual([]);
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves a memory cache hit while a different query is in flight", async () => {
    await lookupMerchant("Billa");
    const resolve = deferredResponse();
    const pending = lookupMerchant("Spar");
    expect(await lookupMerchant("billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolve(Response.json({ results: [] }));
    await pending;
  });

  it.each([[], [result]].map((results) => ({ results })))("reuses persisted results after module reset without HTTP, including empty results: $results", async ({ results }) => {
    fetchMock.mockResolvedValueOnce(Response.json({ results }));
    expect(await lookupMerchant("Billa")).toEqual(results);
    expect(await lookupMerchant("billa")).toEqual(results);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(localStorage.getItem(storageKey)!);
    expect(persisted).toEqual({
      version: 1,
      entries: [{ query: "billa", cachedAt: Date.now(), results }],
    });
    vi.resetModules();
    const reloaded = await import("./merchant-lookup-client");
    expect(await reloaded.lookupMerchant(" ＢＩＬＬＡ ")).toEqual(results);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("expires cached results exactly at thirty days (reload: %s)", async (reload) => {
    await lookupMerchant("Billa");
    vi.setSystemTime(Date.now() + merchantLookupTtl - 1);
    if (reload) {
      vi.resetModules();
      lookupMerchant = (await import("./merchant-lookup-client")).lookupMerchant;
    }
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removes expired persisted entries before requesting a replacement", async () => {
    localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      entries: [{ query: "billa", cachedAt: Date.now() - merchantLookupTtl, results: [result] }],
    }));
    const resolve = deferredResponse();
    const pending = lookupMerchant("Billa");
    expect(JSON.parse(localStorage.getItem(storageKey)!).entries).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(Response.json({ results: [] }));
    expect(await pending).toEqual([]);
  });

  it("discards future-dated persisted entries", async () => {
    localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      entries: [{ query: "billa", cachedAt: Date.now() + 1, results: [] }],
    }));
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "{",
    "null",
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [{ query: "billa", cachedAt: "yesterday", results: [] }] }),
    JSON.stringify({ version: 1, entries: [{ query: "billa", cachedAt: 100, results: [{ id: "1" }] }] }),
  ])("explicitly warns and discards corrupt cache without masking the lookup: %s", async (text) => {
    localStorage.setItem(storageKey, text);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(storageKey);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ungültig"));
    expect(JSON.parse(localStorage.getItem(storageKey)!).entries[0].results).toEqual([result]);
  });

  it("keeps the memory cache when optional storage writes fail", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(await lookupMerchant("billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nicht gespeichert"));
  });

  it("warns on unavailable storage reads but keeps a successful lookup in memory", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(await lookupMerchant("billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nicht gelesen"));
  });

  it("warns when access to localStorage itself is blocked", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(await lookupMerchant("billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nicht zugänglich"));
  });

  it("works with memory-only caching when no window is available", async () => {
    vi.stubGlobal("window", undefined);
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(await lookupMerchant("billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 502, 504, 403])("rejects HTTP %s with a German error, no failure cache and no retry", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("private upstream details", { status }));
    const pending = lookupMerchant("Billa");
    await expect(pending).rejects.toThrow("Händlersuche");
    await expect(pending).rejects.not.toThrow("private upstream details");
    expect(localStorage.getItem(storageKey)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves an existing cached result when a different network lookup fails", async () => {
    await lookupMerchant("Billa");
    const saved = localStorage.getItem(storageKey);
    fetchMock.mockRejectedValueOnce(new Error("private query/network details"));
    const first = lookupMerchant("Spar");
    const joined = lookupMerchant("SPAR");
    const failures = await Promise.allSettled([first, joined]);
    for (const failure of failures) {
      expect(failure.status).toBe("rejected");
      if (failure.status === "rejected") {
        expect(failure.reason).toBeInstanceOf(Error);
        expect(failure.reason.message).toContain("Internetverbindung");
        expect(failure.reason.message).not.toContain("private");
      }
    }
    expect(localStorage.getItem(storageKey)).toBe(saved);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await lookupMerchant("Spar")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves cached data and rejects rather than returning an empty result on HTTP 429", async () => {
    await lookupMerchant("Billa");
    const saved = localStorage.getItem(storageKey);
    fetchMock.mockResolvedValueOnce(Response.json({ error: "busy" }, { status: 429 }));
    await expect(lookupMerchant("Spar")).rejects.toThrow("ausgelastet");
    expect(localStorage.getItem(storageKey)).toBe(saved);
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("distinguishes an app origin rejection from an unavailable search provider", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Diese Händlersuche ist nicht erlaubt." }, { status: 403 }));
    await expect(lookupMerchant("Billa")).rejects.toThrow("für diese Seitenadresse blockiert");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it.each([
    {},
    { results: null },
    { results: [{ id: "1" }] },
    { results: [{ ...result, name: "a".repeat(201) }] },
    { results: [{ ...result, displayName: "a".repeat(1_001) }] },
    { results: Array.from({ length: 4 }, () => result) },
  ])("rejects malformed or oversized API results without caching: %j", async (body) => {
    fetchMock.mockResolvedValueOnce(Response.json(body));
    await expect(lookupMerchant("Billa")).rejects.toThrow("ungültige Antwort");
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid API JSON explicitly", async () => {
    fetchMock.mockResolvedValueOnce(new Response("invalid-json"));
    await expect(lookupMerchant("Billa")).rejects.toThrow("ungültige Antwort");
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("accepts three validated API results", async () => {
    const results = ["1", "2", "3"].map((id) => ({ ...result, id }));
    fetchMock.mockResolvedValueOnce(Response.json({ results }));
    expect(await lookupMerchant("Billa")).toEqual(results);
  });

  it("bounds a stalled HTTP request, rejects explicitly and releases the busy lock", async () => {
    fetchMock.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = expect(lookupMerchant("Billa")).rejects.toThrow("zu lange gedauert");
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(await lookupMerchant("Billa")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains all fresh memory and persisted entries beyond one hundred lookups", async () => {
    for (let index = 0; index < 101; index += 1) {
      await lookupMerchant(`Shop ${index}`);
    }
    const stored = JSON.parse(localStorage.getItem(storageKey)!);
    expect(stored.entries).toHaveLength(101);
    expect(stored.entries[0].query).toBe("shop 0");
    expect(await lookupMerchant("Shop 100")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(101);
    expect(await lookupMerchant("Shop 0")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(101);
    vi.resetModules();
    const reloaded = await import("./merchant-lookup-client");
    expect(await reloaded.lookupMerchant("SHOP 0")).toEqual([result]);
    expect(await reloaded.lookupMerchant("SHOP 100")).toEqual([result]);
    expect(fetchMock).toHaveBeenCalledTimes(101);
  });
});
