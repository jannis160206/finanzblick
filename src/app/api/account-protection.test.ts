import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), accountMode: vi.fn(() => true), recovery: vi.fn(),
}));
vi.mock("@/lib/server/auth", () => ({ authorizeApi: mocks.authorize, isAccountMode: mocks.accountMode }));
vi.mock("@/lib/import/amex-local-recovery", () => ({ readLocalAmexBalanceRecovery: mocks.recovery }));
import { POST as lookup } from "./merchant-lookup/route";
import { GET as recovery } from "./amex-balance-recovery/route";
import { GET as worker } from "./pdf-worker/route";
import { GET as ocr } from "./ocr/[asset]/route";

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("rejects unauthenticated use of every pre-existing server API", async () => {
  mocks.authorize.mockImplementation(async () => Response.json({ error: "Anmeldung erforderlich" }, { status: 401 }));
  const request = new Request("http://127.0.0.1/api/resource");
  const responses = await Promise.all([
    lookup(request), recovery(request), worker(request),
    ocr(request, { params: Promise.resolve({ asset: "worker.min.js" }) }),
  ]);
  expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
  expect(mocks.recovery).not.toHaveBeenCalled();
});

it("never reads private host screenshot recoveries for signed-in accounts", async () => {
  mocks.authorize.mockResolvedValue(null);
  const response = await recovery(new Request("https://167.233.251.240/api/amex-balance-recovery"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ recoveries: [] });
  expect(mocks.recovery).not.toHaveBeenCalled();
});

it("accepts the already authorized HTTPS origin through Caddy's HTTP reverse proxy", async () => {
  mocks.authorize.mockResolvedValue(null);
  const fetcher = vi.fn(async () => Response.json([]));
  vi.stubGlobal("fetch", fetcher);
  const response = await lookup(new Request("http://127.0.0.1:3000/api/merchant-lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://167.233.251.240",
      Host: "167.233.251.240", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ query: "Unknown test shop in Klagenfurt" }),
  }));
  expect(response.status).toBe(200);
  expect(fetcher).toHaveBeenCalledOnce();
});
