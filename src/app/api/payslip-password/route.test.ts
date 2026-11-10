import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSecretKeyCache } from "@/lib/server/secrets";

const mocks = vi.hoisted(() => ({ accountMode: vi.fn(), runtime: vi.fn(), currentUser: vi.fn(), rateLimit: vi.fn() }));
vi.mock("@/lib/server/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/config")>()),
  isAccountMode: mocks.accountMode,
}));
vi.mock("@/lib/server/runtime", () => ({ getAccountRuntime: mocks.runtime }));
import { DELETE, GET, PUT } from "./route";

const origin = "http://localhost";
let directory: string;
const request = (method: string, init: { query?: string; body?: unknown; account?: string; origin?: string } = {}) =>
  new Request(`${origin}/api/payslip-password${init.query ?? ""}`, {
    method,
    headers: {
      "X-Finanzblick-Account": init.account ?? "synthetic-account",
      ...(method === "GET" ? {} : { Origin: init.origin ?? origin, "Content-Type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

beforeEach(async () => {
  vi.resetAllMocks();
  resetSecretKeyCache();
  directory = await mkdtemp(join(tmpdir(), "finanzblick-password-route-"));
  mocks.accountMode.mockReturnValue(true);
  mocks.currentUser.mockReturnValue({ id: "synthetic-account" });
  mocks.runtime.mockResolvedValue({
    config: { origin, secureCookies: false },
    database: { path: join(directory, "accounts.sqlite"), currentUser: mocks.currentUser, consumeRateLimit: mocks.rateLimit },
  });
});
afterEach(async () => {
  resetSecretKeyCache();
  await rm(directory, { recursive: true, force: true });
});

describe("payslip password route", () => {
  it("saves, reports, reveals only on request and removes the password", async () => {
    expect(await (await GET(request("GET"))).json()).toEqual({ stored: false });
    const saved = await PUT(request("PUT", { body: { password: "synthetisch-123" } }));
    expect(saved.status).toBe(200);
    expect(saved.headers.get("Cache-Control")).toBe("no-store");
    const status = await (await GET(request("GET"))).json();
    expect(status).toEqual({ stored: true, updatedAt: expect.any(Number) });
    expect(JSON.stringify(status)).not.toContain("synthetisch");
    expect(await (await GET(request("GET", { query: "?reveal=1" }))).json()).toEqual({ stored: true, password: "synthetisch-123" });
    expect((await DELETE(request("DELETE"))).status).toBe(200);
    expect(await (await GET(request("GET", { query: "?reveal=1" }))).json()).toEqual({ stored: false });
  });

  it("refuses foreign origins, other accounts, missing sessions, browser mode and invalid passwords", async () => {
    expect((await PUT(request("PUT", { body: { password: "x" }, origin: "https://evil.example" }))).status).toBe(403);
    expect((await GET(request("GET", { account: "someone-else" }))).status).toBe(401);
    expect((await PUT(request("PUT", { body: { password: "" } }))).status).toBe(400);
    expect((await PUT(request("PUT", { body: { password: "x".repeat(201) } }))).status).toBe(400);
    mocks.currentUser.mockReturnValue(null);
    expect((await GET(request("GET", { query: "?reveal=1" }))).status).toBe(401);
    mocks.accountMode.mockReturnValue(false);
    expect((await GET(request("GET"))).status).toBe(404);
  });
});
