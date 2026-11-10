import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  accountMode: vi.fn(),
  runtime: vi.fn(),
  currentUser: vi.fn(),
  rateLimit: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("@/lib/server/auth", () => ({
  authorizeApi: mocks.authorize,
  isAccountMode: mocks.accountMode,
}));
vi.mock("@/lib/server/runtime", () => ({ getAccountRuntime: mocks.runtime }));
vi.mock("@/lib/banks/logo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/banks/logo")>()),
  resolveBankLogo: mocks.resolve,
}));
import { GET } from "./route";

const databasePath = join("synthetic", "data", "accounts.sqlite");
const version = "0123456789abcdef";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const get = (query = "name=Raiffeisen&country=AT", headers: HeadersInit = {}) =>
  GET(new Request(`http://localhost/api/banks/logo?${query}`, { headers }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(null);
  mocks.accountMode.mockReturnValue(true);
  mocks.currentUser.mockReturnValue({ id: "synthetic-account" });
  mocks.runtime.mockResolvedValue({
    database: { path: databasePath, currentUser: mocks.currentUser, consumeRateLimit: mocks.rateLimit },
  });
  mocks.resolve.mockResolvedValue({ png, version });
});

describe("bank logo route", () => {
  it("denies unauthenticated users before any lookup", async () => {
    mocks.authorize.mockResolvedValue(new Response("Bitte anmelden.", { status: 401 }));
    expect((await get()).status).toBe(401);
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("has no logo store in non-account development mode", async () => {
    mocks.accountMode.mockReturnValue(false);
    expect((await get()).status).toBe(404);
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("returns 404 without a signed-in account", async () => {
    mocks.currentUser.mockReturnValue(null);
    expect((await get()).status).toBe(404);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "name=",
    `name=${"x".repeat(121)}`,
    "name=Raiffeisen&country=at",
    "name=Raiffeisen&country=AUT",
    "name=Raiffeisen&v=not-a-version",
  ])("rejects invalid query %s", async (query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("serves the PNG from the bank logo folder next to the database with anti-sniff headers", async () => {
    const response = await get("name=%20Raiffeisen%20");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=86400");
    expect(response.headers.get("ETag")).toBe(`"${version}"`);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(png));
    const [input, deps] = mocks.resolve.mock.calls[0];
    expect(input).toEqual({ name: "Raiffeisen", country: "AT" });
    expect(deps.directory).toBe(join(process.cwd(), "synthetic", "data", "bank-logos"));
    deps.beforeLookup();
    expect(mocks.rateLimit).toHaveBeenCalledWith("bank-logo:synthetic-account", 30, 60_000);
  });

  it("caches only the matching version as immutable", async () => {
    const response = await get(`name=Raiffeisen&v=${version}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=86400, immutable");
    const stale = await get("name=Raiffeisen&v=fedcba9876543210");
    expect(stale.status).toBe(404);
    expect(stale.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("answers revalidation with 304", async () => {
    const response = await get("name=Raiffeisen", { "If-None-Match": `W/"${version}"` });
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
  });

  it("lets the browser keep unknown banks for an hour", async () => {
    mocks.resolve.mockResolvedValue(undefined);
    const response = await get("name=Andere%20Bank&country=DE");
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("");
    expect(mocks.resolve.mock.calls[0][0]).toEqual({ name: "Andere Bank", country: "DE" });
  });

  it("reports rate limits from the lookup", async () => {
    const { AccountError } = await import("@/lib/server/errors");
    mocks.resolve.mockRejectedValue(new AccountError(429, "Zu viele Versuche. Bitte später erneut versuchen."));
    expect((await get()).status).toBe(429);
  });
});
