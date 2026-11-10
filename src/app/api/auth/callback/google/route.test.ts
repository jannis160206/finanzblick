import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSecretKeyCache } from "@/lib/server/secrets";

const mocks = vi.hoisted(() => ({ accountMode: vi.fn(), runtime: vi.fn(), currentUser: vi.fn(), rateLimit: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/server/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/config")>()),
  isAccountMode: mocks.accountMode,
}));
vi.mock("@/lib/server/runtime", () => ({ getAccountRuntime: mocks.runtime }));
import { POST as connect } from "@/app/api/drive/connect/route";
import { GET as callback } from "./route";
import { readDriveLink } from "@/lib/drive/store";

const origin = "http://localhost:3000";
let directory: string;
let host: { path: string };

function session(user = "synthetic-account") {
  mocks.currentUser.mockImplementation((token: string | null) => token === "session-token" ? { id: user } : null);
}

async function start() {
  const response = await connect(new Request(`${origin}/api/drive/connect`, {
    method: "POST",
    headers: { Origin: origin, Cookie: "finanzblick_session=session-token", "X-Finanzblick-Account": "synthetic-account" },
  }));
  const { url } = await response.clone().json() as { url?: string };
  const cookie = response.headers.get("Set-Cookie") ?? "";
  return { response, state: url ? new URL(url).searchParams.get("state") ?? "" : "", cookie, pair: cookie.split(";")[0] };
}

const back = (query: string, cookies: string) => callback(new Request(`${origin}/api/auth/callback/google?${query}`, { headers: { Cookie: cookies } }));
const outcome = (response: Response) => new URL(response.headers.get("Location") ?? "").searchParams.get("drive");

beforeEach(async () => {
  vi.resetAllMocks();
  resetSecretKeyCache();
  directory = await mkdtemp(join(tmpdir(), "finanzblick-oauth-route-"));
  host = { path: join(directory, "accounts.sqlite") };
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.accountMode.mockReturnValue(true);
  session();
  mocks.runtime.mockResolvedValue({ config: { origin, secureCookies: false }, database: { ...host, currentUser: mocks.currentUser, consumeRateLimit: mocks.rateLimit } });
  mocks.fetch.mockImplementation(async (url: string | URL) => String(url).includes("oauth2.googleapis.com/token")
    ? Response.json({ access_token: "a1", expires_in: 3600, refresh_token: "r1", scope: "https://www.googleapis.com/auth/drive.readonly" })
    : Response.json({ user: { emailAddress: "alice@example.test", displayName: "Alice" } }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetSecretKeyCache();
  await rm(directory, { recursive: true, force: true });
});

describe("Google Drive connect and callback", () => {
  it("sets a short-lived, HttpOnly state cookie limited to the callback path", async () => {
    const { response, cookie, state } = await start();
    expect(response.status).toBe(200);
    expect(cookie).toMatch(/^finanzblick_google_oauth=v1\./);
    expect(cookie).toContain("Path=/api/auth/callback/google");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).not.toContain(state);
  });

  it("connects only with the matching state for the signed-in account and clears the state cookie", async () => {
    const { state, pair } = await start();
    const done = await back(`code=synthetic-code&state=${state}`, `${pair}; finanzblick_session=session-token`);
    expect(done.status).toBe(303);
    expect(outcome(done)).toBe("verbunden");
    expect(new URL(done.headers.get("Location") ?? "").hash).toBe("#google-drive");
    expect(done.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await readDriveLink(host, "synthetic-account")).toMatchObject({ account: { email: "alice@example.test" } });
    const body = new URLSearchParams(String(mocks.fetch.mock.calls[0][1].body));
    expect(body.get("code_verifier")).toMatch(/^[\w-]{43,}$/);
  });

  it("rejects a wrong state, a missing session, another account and a denied consent", async () => {
    const { state, pair } = await start();
    expect(outcome(await back(`code=c&state=other`, `${pair}; finanzblick_session=session-token`))).toBe("abgelaufen");
    expect(outcome(await back(`code=c&state=${state}`, pair))).toBe("anmeldung");
    expect(outcome(await back(`error=access_denied&state=${state}`, `${pair}; finanzblick_session=session-token`))).toBe("abgelehnt");
    session("someone-else");
    expect(outcome(await back(`code=c&state=${state}`, `${pair}; finanzblick_session=session-token`))).toBe("abgelaufen");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await readDriveLink(host, "synthetic-account")).toBeNull();
  });

  it("reports a consent without the Drive scope", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ access_token: "a", expires_in: 3600, refresh_token: "r", scope: "openid" }));
    const { state, pair } = await start();
    expect(outcome(await back(`code=c&state=${state}`, `${pair}; finanzblick_session=session-token`))).toBe("drive-fehlt");
  });

  it("refuses to start without configuration or from a foreign origin", async () => {
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    expect((await start()).response.status).toBe(503);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
    const foreign = await connect(new Request(`${origin}/api/drive/connect`, {
      method: "POST",
      headers: { Origin: "https://evil.example", Cookie: "finanzblick_session=session-token", "X-Finanzblick-Account": "synthetic-account" },
    }));
    expect(foreign.status).toBe(403);
  });
});
