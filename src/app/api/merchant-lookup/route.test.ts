import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { merchantLookupTtl } from "@/lib/merchant-lookup-schema";

const upstreamResult = {
  place_id: 123,
  name: "BILLA",
  display_name: "BILLA, Klagenfurt, Kärnten, Österreich",
};
const result = {
  id: "123",
  name: "BILLA",
  displayName: upstreamResult.display_name,
};
const fetchMock = vi.fn<typeof fetch>();
let POST: typeof import("./route").POST;
const disallowedHeaders: HeadersInit[] = [
  { Origin: "https://evil.example" },
  { Origin: "null" },
  { "Sec-Fetch-Site": "cross-site" },
  { "Sec-Fetch-Site": "same-site" },
];
const mismatchedHostHeaders: HeadersInit[] = [
  { Origin: "https://evil.example", Host: "127.0.0.1:3000" },
  { Origin: "http://127.0.0.1:3001", Host: "127.0.0.1:3000" },
  { Origin: "https://127.0.0.1:3000", Host: "127.0.0.1:3000" },
  { Origin: "http://127.0.0.1:3000", Host: "127.0.0.1:3000", "Sec-Fetch-Site": "cross-site" },
  { Origin: "https://evil.example", Host: "localhost:3000", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https" },
  { Origin: "http://localhost:3000", Host: "127.0.0.1:3000" },
];

function request(body: unknown = { query: "Billa" }, headers: HeadersInit = {}) {
  const requestHeaders = new Headers({
    "Content-Type": "application/json",
    Origin: "http://localhost:3000",
  });
  new Headers(headers).forEach((value, key) => requestHeaders.set(key, value));
  return new Request("http://localhost:3000/api/merchant-lookup", {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((finish) => { resolve = finish; });
  fetchMock.mockReturnValueOnce(promise);
  return resolve;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
  vi.stubGlobal("finanzblickMerchantLookup", undefined);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async () => Response.json([upstreamResult]));
  POST = (await import("./route")).POST;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("merchant lookup route", () => {
  it("exports only Next-supported route exports", async () => {
    const route = await import("./route");
    expect(Object.keys(route).sort()).toEqual(["POST", "runtime"]);
    expect(route.runtime).toBe("nodejs");
  });

  it("uses only the fixed Austrian Nominatim endpoint, identifying headers and safe parameters", async () => {
    const response = await POST(request({ query: "  ＢＩＬＬＡ   Klagenfurt " }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ results: [result] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    const target = new URL(String(url));
    expect(target.origin + target.pathname).toBe("https://nominatim.openstreetmap.org/search");
    expect(Object.fromEntries(target.searchParams)).toEqual({
      format: "json",
      limit: "3",
      countrycodes: "at",
      addressdetails: "1",
      q: "billa klagenfurt",
    });
    expect(options).toMatchObject({
      headers: {
        Accept: "application/json",
        "User-Agent": "Finanzblick/1.0 (private; github.com/jannis160206/finanzblick)",
        Referer: "https://github.com/jannis160206/finanzblick",
      },
      cache: "no-store",
      redirect: "error",
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.body).toBeUndefined();
  });

  it.each([
    null,
    [],
    "Billa",
    {},
    { query: null },
    { query: 123 },
    { query: " " },
    { query: "A" },
    { query: "12345" },
    { query: "a".repeat(181) },
    { query: "ﬃ".repeat(100) },
    { query: "Billa", rawBooking: "private booking" },
    { query: "Billa", url: "https://example.com" },
  ].map((body) => ({ body })))("rejects invalid input without contacting upstream: $body", async ({ body }) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and oversized input", async () => {
    for (const body of ['{"query":', " ".repeat(2_001)]) {
      const response = await POST(new Request("http://localhost:3000/api/merchant-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }));
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "application/jsonp", ""])(
    "rejects unsupported content type %s",
    async (contentType) => {
      const response = await POST(request(undefined, { "Content-Type": contentType }));
      expect(response.status).toBe(415);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(disallowedHeaders)("rejects cross-origin web calls: %j", async (headers) => {
    const response = await POST(request(undefined, headers));
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "finanzblick.example"])(
    "uses the incoming Host for same-origin requests when Next normalizes the internal URL: %s",
    async (host) => {
      const incoming = request(undefined, {
        Origin: `http://${host}`, Host: host, "Sec-Fetch-Site": "same-origin",
      });
      expect(new URL(incoming.url).hostname).toBe("localhost");
      expect((await POST(incoming)).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(mismatchedHostHeaders)("does not bypass the origin boundary for mismatched or forwarded headers: %j", async (headers) => {
    expect((await POST(request(undefined, headers))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "localhost:3000/path", "user@localhost:3000", "localhost:3000?query", "localhost:3000#fragment", "localhost:bad"])(
    "rejects malformed Host values without contacting Nominatim: %s",
    async (host) => {
      expect((await POST(request(undefined, { Host: host }))).status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("allows JSON requests without browser origin headers", async () => {
    const incoming = request();
    incoming.headers.delete("origin");
    expect((await POST(incoming)).status).toBe(200);
  });

  it("maps up to three results and falls back to the first display-name component", async () => {
    fetchMock.mockResolvedValueOnce(Response.json([
      upstreamResult,
      { place_id: "456", display_name: "SPAR, Villach, Österreich" },
      { place_id: 789, name: " ", display_name: "HOFER, Wien, Österreich" },
    ]));
    const response = await POST(request());
    expect(await response.json()).toEqual({
      results: [
        result,
        { id: "456", name: "SPAR", displayName: "SPAR, Villach, Österreich" },
        { id: "789", name: "HOFER", displayName: "HOFER, Wien, Österreich" },
      ],
    });
  });

  it.each([
    {},
    [null],
    [{ place_id: null, name: "Billa", display_name: "Billa, Österreich" }],
    [{ place_id: 1, name: "Billa" }],
    [{ ...upstreamResult, name: "a".repeat(201) }],
    [{ ...upstreamResult, display_name: "a".repeat(1_001) }],
    Array.from({ length: 4 }, () => upstreamResult),
  ].map((body) => ({ body })))("rejects invalid upstream data instead of returning success: $body", async ({ body }) => {
    fetchMock.mockResolvedValueOnce(Response.json(body));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });

  it("rejects malformed upstream JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not-json"));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty("results");
  });

  it.each([429, 500, 403])("reports upstream %s without caching failures or retrying", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("private upstream details", { status }));
    const response = await POST(request());
    expect(response.status).toBe(status === 429 ? 429 : 502);
    const body = await response.json();
    expect(body).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("private upstream details");
    if (status === 429) expect(response.headers.get("retry-after")).toBe("1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await POST(request())).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps network failures explicit, unlogged, uncached and without retries", async () => {
    const logs = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    fetchMock.mockRejectedValueOnce(new Error("private query and network details"));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Die Händlersuche ist derzeit nicht erreichbar.",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await POST(request())).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("aborts timed-out upstream requests and releases the concurrency lock", async () => {
    fetchMock.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = POST(request());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(8_000);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).not.toHaveProperty("results");
    expect((await POST(request())).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("also bounds upstream response-body reads", async () => {
    fetchMock.mockImplementationOnce(async (_url, options) => {
      const response = Response.json([]);
      vi.spyOn(response, "json").mockImplementation(() => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
      return response;
    });
    const pending = POST(request());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(8_000);
    expect((await pending).status).toBe(504);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("joins identical pending normalized queries and rejects distinct ones without a queue", async () => {
    const resolve = deferredResponse();
    const first = POST(request({ query: " BILLA " }));
    const identical = POST(request({ query: "billa" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    const busy = await POST(request({ query: "Spar" }));
    expect(busy.status).toBe(429);
    expect(await busy.json()).toHaveProperty("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(Response.json([upstreamResult]));
    const replies = await Promise.all([first, identical]);
    expect(await replies[0].json()).toEqual({ results: [result] });
    expect(await replies[1].json()).toEqual({ results: [result] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never starts consecutive upstream requests less than one second apart", async () => {
    expect((await POST(request())).status).toBe(200);
    await vi.advanceTimersByTimeAsync(999);
    const blocked = await POST(request({ query: "Spar" }));
    expect(blocked.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await POST(request({ query: "Spar" }))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares process concurrency across module reloads", async () => {
    const resolve = deferredResponse();
    const first = POST(request());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.resetModules();
    const reloaded = await import("./route");
    const busy = await reloaded.POST(request({ query: "Spar" }));
    expect(busy.status).toBe(429);
    const identical = reloaded.POST(request());
    resolve(Response.json([upstreamResult]));
    expect((await first).status).toBe(200);
    expect((await identical).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves normalized cache hits before the rate and busy gates", async () => {
    await POST(request());
    expect((await POST(request({ query: " ＢＩＬＬＡ " }))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const resolve = deferredResponse();
    const other = POST(request({ query: "Spar" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const cached = await POST(request({ query: "billa" }));
    expect(await cached.json()).toEqual({ results: [result] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolve(Response.json([]));
    await other;
  });

  it.each([[], [upstreamResult]].map((body) => ({ body })))("caches valid results, including empty arrays, for exactly thirty days: $body", async ({ body }) => {
    fetchMock.mockImplementation(async () => Response.json(body));
    const first = await POST(request());
    const expected = await first.json();
    vi.setSystemTime(Date.now() + merchantLookupTtl - 1);
    expect(await (await POST(request())).json()).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    expect(await (await POST(request())).json()).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains all fresh process-cache entries beyond 256 lookups", async () => {
    for (let index = 0; index < 257; index += 1) {
      expect((await POST(request({ query: `Shop ${index}` }))).status).toBe(200);
      vi.setSystemTime(Date.now() + 1_000);
    }
    expect((await POST(request({ query: "Shop 256" }))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(257);
    const first = await POST(request({ query: "SHOP 0" }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ results: [result] });
    expect(fetchMock).toHaveBeenCalledTimes(257);
  });
});
