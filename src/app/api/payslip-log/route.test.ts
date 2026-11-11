import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { payslipLogEntry } from "@/lib/payslip-log";

const mocks = vi.hoisted(() => ({ accountMode: vi.fn(), runtime: vi.fn(), currentUser: vi.fn(), rateLimit: vi.fn() }));
vi.mock("@/lib/server/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/config")>()),
  isAccountMode: mocks.accountMode,
}));
vi.mock("@/lib/server/runtime", () => ({ getAccountRuntime: mocks.runtime }));
import { DELETE, GET, POST } from "./route";

const origin = "http://localhost";
let directory: string;
const request = (method: string, init: { body?: unknown; account?: string; origin?: string } = {}) =>
  new Request(`${origin}/api/payslip-log`, {
    method,
    headers: {
      "X-Finanzblick-Account": init.account ?? "synthetic-account",
      ...(method === "GET" ? {} : { Origin: init.origin ?? origin, "Content-Type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), "finanzblick-payslip-log-route-"));
  mocks.accountMode.mockReturnValue(true);
  mocks.currentUser.mockReturnValue({ id: "synthetic-account" });
  mocks.runtime.mockResolvedValue({
    config: { origin, secureCookies: false },
    database: { path: join(directory, "accounts.sqlite"), currentUser: mocks.currentUser, consumeRateLimit: mocks.rateLimit },
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("appends, lists and clears the import log of the signed-in account", async () => {
  const entry = payslipLogEntry({ source: "upload", message: "1 Abrechnung übernommen.", at: 3 });
  expect(await (await GET(request("GET"))).json()).toEqual({ entries: [] });
  expect((await POST(request("POST", { body: entry }))).status).toBe(200);
  expect(await (await GET(request("GET"))).json()).toEqual({ entries: [entry] });
  expect((await DELETE(request("DELETE"))).status).toBe(200);
  expect(await (await GET(request("GET"))).json()).toEqual({ entries: [] });
  expect(mocks.rateLimit).toHaveBeenCalledWith("payslip-log:synthetic-account", 60, 60_000);
});

it("refuses foreign origins, other accounts, invalid entries and browser mode", async () => {
  const entry = payslipLogEntry({ source: "upload", message: "ok", at: 3 });
  expect((await POST(request("POST", { body: entry, origin: "https://evil.example" }))).status).toBe(403);
  expect((await GET(request("GET", { account: "someone-else" }))).status).toBe(401);
  expect((await POST(request("POST", { body: { ...entry, source: "unbekannt" } }))).status).toBe(400);
  mocks.accountMode.mockReturnValue(false);
  expect((await GET(request("GET"))).status).toBe(404);
});
