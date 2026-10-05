import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { readRecovery } = vi.hoisted(() => ({ readRecovery: vi.fn() }));
vi.mock("@/lib/import/amex-local-recovery", () => ({ readLocalAmexBalanceRecovery: readRecovery }));
const recovery = {
  snapshot: { periodStart: "2026-09-11", date: "2026-10-05", balance: 1619.19 },
  bookingKeys: ['["jannis","2026-10-04","-12.34","spar"]', '["jannis","2026-10-04","-12.34","billa"]'],
};
const disallowedHeaders: HeadersInit[] = [
  { Origin: "https://evil.example" }, { Origin: "null" },
  { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" },
  { Origin: "http://localhost:3001" }, { Origin: "https://localhost:3000" },
  { Origin: "http://localhost:3000", Host: "127.0.0.1:3000" },
  { Origin: "https://evil.example", Host: "localhost:3000", "X-Forwarded-Host": "evil.example" },
];
function request(headers: HeadersInit = {}, search = "") {
  const incoming = new Headers({ Origin: "http://localhost:3000" });
  new Headers(headers).forEach((value, key) => incoming.set(key, value));
  return new Request(`http://localhost:3000/api/amex-balance-recovery${search}`, { headers: incoming });
}

beforeEach(() => { readRecovery.mockReset().mockResolvedValue([recovery]); });
afterEach(() => { vi.restoreAllMocks(); });

describe("Amex balance recovery GET route", () => {
  it("exports only supported Next route exports and uses the Node runtime", async () => {
    const route = await import("./route");
    expect(Object.keys(route).sort()).toEqual(["GET", "runtime"]);
    expect(route.runtime).toBe("nodejs");
  });

  it("returns only recovery evidence and prevents HTTP caching", async () => {
    const response = await GET(request({ "Sec-Fetch-Site": "same-origin" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ recoveries: [recovery] });
    expect(readRecovery).toHaveBeenCalledExactlyOnceWith();
  });

  it("returns an empty optional recovery without treating it as an error", async () => {
    readRecovery.mockResolvedValueOnce([]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ recoveries: [] });
  });

  it("never forwards request paths or filenames to local filesystem recovery", async () => {
    const response = await GET(request({}, "?filename=secret.jpeg&path=C%3A%5CDownloads"));
    expect(response.status).toBe(200);
    expect(readRecovery).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(disallowedHeaders)("rejects disallowed browser origins or fetch sites without reading private files: %j", async (headers) => {
    const response = await GET(request(headers));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(readRecovery).not.toHaveBeenCalled();
  });

  it.each(["", "localhost:3000/path", "user@localhost:3000", "localhost:3000?query", "localhost:3000#fragment", "localhost:bad"])(
    "rejects malformed Host values: %s", async (host) => {
      expect((await GET(request({ Host: host }))).status).toBe(403);
      expect(readRecovery).not.toHaveBeenCalled();
    },
  );

  it.each(["127.0.0.1:3000", "localhost:3000", "[::1]:3000"])(
    "accepts matching incoming browser Host when Next normalizes the URL: %s", async (host) => {
      expect((await GET(request({ Origin: `http://${host}`, Host: host }))).status).toBe(200);
      expect(readRecovery).toHaveBeenCalledTimes(1);
    },
  );

  it("allows headerless local requests and sec-fetch-site none", async () => {
    const incoming = request({ "Sec-Fetch-Site": "none" });
    incoming.headers.delete("origin");
    expect((await GET(incoming)).status).toBe(200);
  });

  it("keeps OCR/read failures explicit, private, logged server-side, and retriable", async () => {
    const error = new Error("private full bank text and filename");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    readRecovery.mockRejectedValueOnce(error);
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Der lokale Amex-Saldo konnte nicht wiederhergestellt werden. Bitte erneut versuchen.",
    });
    expect(log).toHaveBeenCalledWith("Lokale Amex-Saldo-Wiederherstellung fehlgeschlagen:", error);
    expect((await GET(request())).status).toBe(200);
    expect(readRecovery).toHaveBeenCalledTimes(2);
  });
});
