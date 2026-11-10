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

describe("Google Drive between localhost and 127.0.0.1", () => {
  const local = "http://127.0.0.1:3000";
  const useOrigin = (configured: string) => mocks.runtime.mockResolvedValue({
    config: { origin: configured, secureCookies: false },
    database: { ...host, currentUser: mocks.currentUser, consumeRateLimit: mocks.rateLimit },
  });
  const startAt = async (from: string) => {
    const response = await connect(new Request(`${from}/api/drive/connect`, {
      method: "POST",
      headers: { Origin: from, Cookie: "finanzblick_session=session-token", "X-Finanzblick-Account": "synthetic-account" },
    }));
    const { url } = await response.json() as { url: string };
    return { params: new URL(url).searchParams, pair: (response.headers.get("Set-Cookie") ?? "").split(";")[0] };
  };

  it("sends Google to the registered localhost URI and hands the answer back to 127.0.0.1", async () => {
    useOrigin(local);
    const { params, pair } = await startAt(local);
    expect(params.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback/google");
    const query = `code=synthetic-code&state=${encodeURIComponent(params.get("state") ?? "")}`;
    const arrived = await callback(new Request(`http://localhost:3000/api/auth/callback/google?${query}`, { headers: { Host: "localhost:3000" } }));
    expect(arrived.status).toBe(303);
    expect(arrived.headers.get("Location")).toBe(`${local}/api/auth/callback/google?${query}`);
    expect(arrived.headers.get("Set-Cookie")).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
    const done = await callback(new Request(`${local}/api/auth/callback/google?${query}`, { headers: { Cookie: `${pair}; finanzblick_session=session-token` } }));
    expect(outcome(done)).toBe("verbunden");
    expect(new URL(done.headers.get("Location") ?? "").origin).toBe(local);
    expect(new URLSearchParams(String(mocks.fetch.mock.calls[0][1].body)).get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback/google");
  });

  it("never relays to another host, another port or from a public host", async () => {
    useOrigin(local);
    const state = (target: string) => `${"a".repeat(43)}.${Buffer.from(target).toString("base64url")}`;
    const arrive = (url: string, target: string) => callback(new Request(`${url}/api/auth/callback/google?code=c&state=${state(target)}`));
    expect(outcome(await arrive("http://localhost:3000", "https://evil.example"))).toBe("anmeldung");
    expect(outcome(await arrive("http://localhost:3000", "http://127.0.0.1:4000"))).toBe("anmeldung");
    expect(outcome(await arrive("https://finanzen.example", "http://127.0.0.1:3000"))).toBe("anmeldung");
    expect(outcome(await arrive("http://127.0.0.1:3000", "http://127.0.0.1:3000"))).toBe("anmeldung");
  });
});
