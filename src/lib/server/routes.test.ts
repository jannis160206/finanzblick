import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as session } from "@/app/api/auth/session/route";
import { GET as getFinance, PUT as putFinance } from "@/app/api/finance/route";
import {
  authorizeApi,
  getCurrentUser,
  requireAccount,
  registrationEnabled,
} from "./auth";
import { isAccountMode, readAccountConfig } from "./config";
import { readJsonBody, clientAddress } from "./http";
import { closeAccountDatabases, getAccountRuntime } from "./runtime";
import { blankTestState, createTestDirectory } from "./test-support";

const mocked = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (mocked.token ? { value: mocked.token } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`Redirect:${path}`);
  },
}));

const password = "test-only-password-123";
let directory: string;
let accountIds: Map<string, string>;

function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
  origin: string | null = "http://localhost:3000",
): Request {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (cookie) headers.set("Cookie", cookie);
  if (cookie && path.startsWith("/api/finance") && accountIds.has(cookie)) {
    headers.set("X-Finanzblick-Account", accountIds.get(cookie)!);
  }
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function registerUser(username = "alice"): Promise<{
  cookie: string;
  user: { id: string; username: string; role: string };
}> {
  const response = await register(
    request("/api/auth/register", "POST", { username, password }),
  );
  expect(response.status).toBe(201);
  const registered = {
    cookie: response.headers.get("set-cookie")!.split(";")[0],
    user: (await response.json()).user,
  };
  accountIds.set(registered.cookie, registered.user.id);
  return registered;
}

beforeEach(() => {
  directory = createTestDirectory();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FINANZBLICK_AUTH", "true");
  vi.stubEnv("FINANZBLICK_DATABASE_PATH", join(directory, "accounts.sqlite"));
  vi.stubEnv("FINANZBLICK_ADMIN_PASSWORD", password);
  vi.stubEnv("FINANZBLICK_ORIGIN", "");
  vi.stubEnv("FINANZBLICK_TRUST_PROXY", "false");
  vi.stubEnv("FINANZBLICK_REGISTRATION_ENABLED", "true");
  vi.stubEnv("FINANZBLICK_MAX_ACCOUNTS", "100");
  vi.stubEnv("FINANZBLICK_MAX_STORAGE_MB", "256");
  accountIds = new Map();
  mocked.token = "";
});

afterEach(() => {
  closeAccountDatabases();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("account and finance routes", () => {
  it("allows a short administrator password only in explicitly loopback-configured development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FINANZBLICK_ORIGIN", "http://localhost:3000");
    vi.stubEnv("FINANZBLICK_ADMIN_PASSWORD", "1234");
    const response = await login(request("/api/auth/login", "POST", { username: "admin", password: "1234" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { username: "admin", role: "admin" } });
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    expect(response.headers.get("set-cookie")).not.toContain("; Secure");
    expect((await session(request("/api/auth/session", "GET", undefined, cookie))).status).toBe(200);
    expect((await login(request("/api/auth/login", "POST", { username: "admin", password: "wrong" }))).status).toBe(401);
    expect((await register(request("/api/auth/register", "POST", { username: "alice", password: "1234" }))).status).toBe(400);
    expect((await logout(request("/api/auth/logout", "POST", {}, cookie))).status).toBe(200);
    expect((await session(request("/api/auth/session", "GET", undefined, cookie))).status).toBe(401);
  });

  it.each(["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"])(
    "permits a four-character administrator password for local test origin %s",
    (origin) => {
      vi.stubEnv("FINANZBLICK_ORIGIN", origin);
      vi.stubEnv("FINANZBLICK_ADMIN_PASSWORD", "1234");
      expect(readAccountConfig().adminPasswordMinimum).toBe(4);
      vi.stubEnv("FINANZBLICK_ADMIN_PASSWORD", "123");
      expect(() => readAccountConfig()).toThrow(/4–128/);
    },
  );

  it.each([
    ["production", "https://finance.example"],
    ["production", "https://127.0.0.1:3000"],
    ["development", "http://192.168.1.10:3000"],
    ["development", "https://finance.example"],
    ["test", ""],
  ])("rejects short administrator passwords outside local development (%s, %s)", (nodeEnv, origin) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("FINANZBLICK_ORIGIN", origin);
    vi.stubEnv("FINANZBLICK_ADMIN_PASSWORD", "1234");
    expect(() => readAccountConfig()).toThrow(/12–128/);
  });

  it("retains an administrator's existing finances when switching to a short local password", async () => {
    const first = await login(request("/api/auth/login", "POST", { username: "admin", password }));
    const firstUser = (await first.json()).user;
    const firstCookie = first.headers.get("set-cookie")!.split(";")[0];
    accountIds.set(firstCookie, firstUser.id);
    const state = blankTestState();
    expect((await putFinance(request("/api/finance", "PUT", { state, revision: 0 }, firstCookie))).status).toBe(200);
    vi.stubEnv("FINANZBLICK_ORIGIN", "http://localhost:3000");
    vi.stubEnv("FINANZBLICK_ADMIN_PASSWORD", "1234");
    const changed = await login(request("/api/auth/login", "POST", { username: "admin", password: "1234" }));
    const user = (await changed.json()).user;
    const cookie = changed.headers.get("set-cookie")!.split(";")[0];
    accountIds.set(cookie, user.id);
    expect(user).toEqual(firstUser);
    expect((await session(request("/api/auth/session", "GET", undefined, firstCookie))).status).toBe(401);
    expect(await (await getFinance(request("/api/finance", "GET", undefined, cookie))).json()).toEqual({ state, revision: 1 });
    closeAccountDatabases();
    const restored = await login(request("/api/auth/login", "POST", { username: "admin", password: "1234" }));
    expect(restored.status).toBe(200);
    expect((await restored.json()).user).toEqual(user);
  });

  it("registers blank isolated accounts, persists revisions, and rejects stale/malicious writes", async () => {
    const alice = await registerUser();
    const bob = await registerUser("bob");
    expect(
      await (
        await getFinance(
          request("/api/finance", "GET", undefined, alice.cookie),
        )
      ).json(),
    ).toEqual({ state: null, revision: 0 });
    const state = blankTestState();
    const saved = await putFinance(
      request("/api/finance", "PUT", { state, revision: 0 }, alice.cookie),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ state, revision: 1 });
    const stale = await putFinance(
      request(
        "/api/finance",
        "PUT",
        {
          state: { ...state, seasonalTheme: { reduceMotion: true } },
          revision: 0,
        },
        alice.cookie,
      ),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: expect.stringMatching(/anderen Gerät/),
    });
    expect(
      await (
        await getFinance(request("/api/finance", "GET", undefined, bob.cookie))
      ).json(),
    ).toEqual({ state: null, revision: 0 });
    const crossUser = await putFinance(
      request(
        "/api/finance",
        "PUT",
        { state, revision: 0, userId: alice.user.id },
        bob.cookie,
      ),
    );
    expect(crossUser.status).toBe(400);
    const read = await getFinance(
      request(
        `/api/finance?userId=${alice.user.id}`,
        "GET",
        undefined,
        bob.cookie,
      ),
    );
    expect(await read.json()).toEqual({ state: null, revision: 0 });
    closeAccountDatabases();
    expect(
      await (
        await getFinance(
          request("/api/finance", "GET", undefined, alice.cookie),
        )
      ).json(),
    ).toEqual({ state, revision: 1 });
  });

  it("logs in, rotates cookies, reports session users, and revokes on logout", async () => {
    const registered = await registerUser();
    const wrong = await login(
      request("/api/auth/login", "POST", {
        username: "alice",
        password: "a-wrong-password-123",
      }),
    );
    expect(wrong.status).toBe(401);
    expect(wrong.headers.has("set-cookie")).toBe(false);
    const authenticated = await login(
      request(
        "/api/auth/login",
        "POST",
        { username: "ALICE", password },
        registered.cookie,
      ),
    );
    expect(authenticated.status).toBe(200);
    const cookieHeader = authenticated.headers.get("set-cookie")!;
    expect(cookieHeader).toMatch(/HttpOnly/);
    expect(cookieHeader).toMatch(/SameSite=Lax/);
    expect(cookieHeader).toMatch(/Max-Age=2592000/);
    const cookie = cookieHeader.split(";")[0];
    expect(cookie).not.toBe(registered.cookie);
    expect(
      (
        await session(
          request("/api/auth/session", "GET", undefined, registered.cookie),
        )
      ).status,
    ).toBe(401);
    expect(
      await (
        await session(request("/api/auth/session", "GET", undefined, cookie))
      ).json(),
    ).toEqual({ user: registered.user });
    const response = await logout(
      request("/api/auth/logout", "POST", undefined, cookie),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(
      (await session(request("/api/auth/session", "GET", undefined, cookie)))
        .status,
    ).toBe(401);
  });

  it("requires sessions, Origin and same-site mutations, including login/logout", async () => {
    expect((await getFinance(request("/api/finance"))).status).toBe(401);
    expect(
      (
        await putFinance(
          request("/api/finance", "PUT", {
            state: blankTestState(),
            revision: 0,
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await register(
          request(
            "/api/auth/register",
            "POST",
            { username: "alice", password },
            undefined,
            null,
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await login(
          request(
            "/api/auth/login",
            "POST",
            { username: "admin", password },
            undefined,
            "http://evil.example",
          ),
        )
      ).status,
    ).toBe(403);
    const { cookie } = await registerUser();
    expect(
      (
        await putFinance(
          request(
            "/api/finance",
            "PUT",
            { state: blankTestState(), revision: 0 },
            cookie,
            null,
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await logout(
          request(
            "/api/auth/logout",
            "POST",
            undefined,
            cookie,
            "http://evil.example",
          ),
        )
      ).status,
    ).toBe(403);
    const crossSite = request("/api/auth/logout", "POST", undefined, cookie);
    crossSite.headers.set("sec-fetch-site", "cross-site");
    expect((await logout(crossSite)).status).toBe(403);
    expect(
      (await session(request("/api/auth/session", "GET", undefined, cookie)))
        .status,
    ).toBe(200);
  });

  it("validates JSON, credential bounds and finance schemas before mutations", async () => {
    expect(
      (
        await register(
          request("/api/auth/register", "POST", {
            username: "AdMiN",
            password,
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await register(
          request("/api/auth/register", "POST", {
            username: "bad user",
            password,
          }),
        )
      ).status,
    ).toBe(400);
    const wrongType = request("/api/auth/login", "POST", {
      username: "alice",
      password,
    });
    wrongType.headers.set("content-type", "text/plain");
    expect((await login(wrongType)).status).toBe(415);
    const malformed = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: "{",
    });
    expect((await login(malformed)).status).toBe(400);
    const oversized = request("/api/auth/login", "POST", {
      username: "alice",
      password,
    });
    oversized.headers.set("content-length", "2049");
    expect((await login(oversized)).status).toBe(413);
    const { cookie } = await registerUser();
    const invalid = await putFinance(
      request("/api/finance", "PUT", { state: {}, revision: 0 }, cookie),
    );
    expect(invalid.status).toBe(400);
    expect(
      await (
        await getFinance(request("/api/finance", "GET", undefined, cookie))
      ).json(),
    ).toEqual({ state: null, revision: 0 });
    await expect(
      readJsonBody(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "123456",
        }),
        5,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("limits repeated login attempts persistently and does not trust arbitrary proxy headers", async () => {
    const { database, config } = await getAccountRuntime();
    const incoming = request("/api/auth/login", "POST", {
      username: "unknown",
      password,
    });
    incoming.headers.set("x-forwarded-for", "198.51.100.1");
    expect(clientAddress(incoming, config)).toBe("untrusted");
    expect(clientAddress(incoming, { ...config, trustProxy: true })).toBe(
      "198.51.100.1",
    );
    database.consumeRateLimit("login:username:unknown", 1, 15 * 60_000);
    for (let index = 0; index < 9; index++)
      database.consumeRateLimit("login:username:unknown", 10, 15 * 60_000);
    closeAccountDatabases();
    const response = await login(incoming);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
  });

  it("returns no-store on successes and errors and uses secure host-only cookies in production", async () => {
    const missing = await session(request("/api/auth/session"));
    expect(missing.headers.get("cache-control")).toBe("no-store");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FINANZBLICK_ORIGIN", "https://finance.example");
    const response = await login(
      new Request("https://finance.example/api/auth/login", {
        method: "POST",
        headers: {
          Origin: "https://finance.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: "admin", password }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-finanzblick_session=/,
    );
    expect(response.headers.get("set-cookie")).toMatch(/; Secure/);
  });

  it("guards existing APIs and server pages with a local-only bypass", async () => {
    expect((await authorizeApi(request("/api/other")))?.status).toBe(401);
    await expect(requireAccount()).rejects.toThrow("Redirect:/login");
    const { cookie, user } = await registerUser();
    expect(
      await authorizeApi(request("/api/other", "GET", undefined, cookie)),
    ).toBeNull();
    expect(
      (await authorizeApi(request("/api/other", "POST", {}, cookie, null)))
        ?.status,
    ).toBe(403);
    mocked.token = cookie.split("=")[1];
    expect(await getCurrentUser()).toEqual(user);
    expect(await requireAccount()).toEqual(user);
    vi.stubEnv("FINANZBLICK_AUTH", "false");
    expect(await authorizeApi(request("/api/other"))).toBeNull();
    expect(await getCurrentUser()).toBeNull();
    expect(await requireAccount()).toMatchObject({ id: "local" });
  });

  it("does not provision a database in local mode and fails closed on broken production config", async () => {
    vi.stubEnv("FINANZBLICK_AUTH", "false");
    expect(isAccountMode()).toBe(false);
    expect(
      (
        await login(
          request("/api/auth/login", "POST", { username: "admin", password }),
        )
      ).status,
    ).toBe(404);
    expect(existsSync(join(directory, "accounts.sqlite"))).toBe(false);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => isAccountMode()).toThrow(/cannot be disabled/);
    expect((await authorizeApi(request("/api/other")))?.status).toBe(503);
    vi.stubEnv("FINANZBLICK_AUTH", "true");
    vi.stubEnv("FINANZBLICK_ADMIN_PASSWORD", "");
    expect((await session(request("/api/auth/session"))).status).toBe(503);
    expect(existsSync(join(directory, "accounts.sqlite"))).toBe(false);
  });

  it("validates exact configured origins and explicit protected production database paths", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FINANZBLICK_ORIGIN", "https://finance.example/");
    expect(() => readAccountConfig()).toThrow(/exact origin/);
    vi.stubEnv("FINANZBLICK_ORIGIN", "http://finance.example");
    expect(() => readAccountConfig()).toThrow(/HTTPS/);
    vi.stubEnv("FINANZBLICK_ORIGIN", "https://finance.example");
    vi.stubEnv("FINANZBLICK_DATABASE_PATH", "accounts.sqlite");
    expect(() => readAccountConfig()).toThrow(/absolute/);
    vi.stubEnv(
      "FINANZBLICK_DATABASE_PATH",
      join(process.cwd(), "public", "accounts.sqlite"),
    );
    expect(() => readAccountConfig()).toThrow(/public/);
    vi.stubEnv("FINANZBLICK_DATABASE_PATH", "");
    expect(() => readAccountConfig()).toThrow(/absolute/);
  });

  it("applies changed administrator secrets without losing the administrator snapshot", async () => {
    const signedIn = await login(
      request("/api/auth/login", "POST", { username: "admin", password }),
    );
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const admin = (await signedIn.json()).user;
    accountIds.set(cookie, admin.id);
    const state = blankTestState();
    expect(
      (
        await putFinance(
          request("/api/finance", "PUT", { state, revision: 0 }, cookie),
        )
      ).status,
    ).toBe(200);
    const changedPassword = "another-test-password-123";
    vi.stubEnv("FINANZBLICK_ADMIN_PASSWORD", changedPassword);
    expect(
      (await session(request("/api/auth/session", "GET", undefined, cookie)))
        .status,
    ).toBe(401);
    const changed = await login(
      request("/api/auth/login", "POST", {
        username: "admin",
        password: changedPassword,
      }),
    );
    expect(changed.status).toBe(200);
    expect((await changed.json()).user).toEqual(admin);
    const changedCookie = changed.headers.get("set-cookie")!.split(";")[0];
    accountIds.set(changedCookie, admin.id);
    expect(
      await (
        await getFinance(
          request("/api/finance", "GET", undefined, changedCookie),
        )
      ).json(),
    ).toEqual({ state, revision: 1 });
  });

  it("fails closed on unexpected database errors without exposing exception secrets", async () => {
    const { cookie } = await registerUser();
    const { database } = await getAccountRuntime();
    const logging = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(database, "getFinance").mockImplementation(() => {
      throw new Error("secret request state and token");
    });
    const response = await getFinance(
      request("/api/finance", "GET", undefined, cookie),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
    expect(JSON.stringify(logging.mock.calls)).not.toContain("secret");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires matching account identity on GET/PUT and cannot save a lingering tab under a switched account", async () => {
    const alice = await registerUser();
    const bob = await registerUser("bob");
    const state = blankTestState();
    for (const method of ["GET", "PUT"]) {
      const readOrWrite = method === "GET" ? getFinance : putFinance;
      const body = method === "PUT" ? { state, revision: 0 } : undefined;
      const staleTab = request("/api/finance", method, body, bob.cookie);
      staleTab.headers.set("X-Finanzblick-Account", alice.user.id);
      expect((await readOrWrite(staleTab)).status).toBe(401);
      const missing = request("/api/finance", method, body, bob.cookie);
      missing.headers.delete("X-Finanzblick-Account");
      expect((await readOrWrite(missing)).status).toBe(401);
    }
    expect(
      await (
        await getFinance(request("/api/finance", "GET", undefined, bob.cookie))
      ).json(),
    ).toEqual({ state: null, revision: 0 });
    expect(
      await (
        await getFinance(
          request("/api/finance", "GET", undefined, alice.cookie),
        )
      ).json(),
    ).toEqual({ state: null, revision: 0 });
  });

  it("rechecks authorization after reading a streamed finance write", async () => {
    const alice = await registerUser();
    const { database } = await getAccountRuntime();
    const update = { state: blankTestState(), revision: 0 };
    const incoming = request("/api/finance", "PUT", update, alice.cookie);
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        pull(controller) {
          database.logout(alice.cookie.split("=")[1]);
          controller.enqueue(new TextEncoder().encode(JSON.stringify(update)));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    vi.spyOn(incoming, "body", "get").mockReturnValue(stream);
    const lookups = vi.spyOn(database, "currentUser");
    expect((await putFinance(incoming)).status).toBe(401);
    expect(lookups.mock.results.map((result) => result.value)).toEqual([
      alice.user,
      null,
    ]);
    expect(database.getFinance(alice.user.id)).toEqual({
      state: null,
      revision: 0,
    });
  });

  it("exposes and enforces registration configuration without disabling existing logins", async () => {
    expect(registrationEnabled()).toBe(true);
    vi.stubEnv("FINANZBLICK_REGISTRATION_ENABLED", "false");
    expect(registrationEnabled()).toBe(false);
    const response = await register(
      request("/api/auth/register", "POST", { username: "alice", password }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Die Registrierung ist deaktiviert.",
    });
    expect(
      (
        await login(
          request("/api/auth/login", "POST", { username: "admin", password }),
        )
      ).status,
    ).toBe(200);
    vi.stubEnv("FINANZBLICK_AUTH", "false");
    expect(registrationEnabled()).toBe(false);
    vi.stubEnv("FINANZBLICK_AUTH", "true");
    vi.stubEnv("FINANZBLICK_REGISTRATION_ENABLED", "invalid");
    expect(() => registrationEnabled()).toThrow(/must be true or false/);
  });

  it("validates operational account and storage quota configuration", async () => {
    expect(readAccountConfig()).toMatchObject({
      maxAccounts: 100,
      maxStorageBytes: 256 * 1024 * 1024,
    });
    vi.stubEnv("FINANZBLICK_MAX_ACCOUNTS", "1");
    expect(
      (
        await register(
          request("/api/auth/register", "POST", {
            username: "alice",
            password,
          }),
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await login(
          request("/api/auth/login", "POST", { username: "admin", password }),
        )
      ).status,
    ).toBe(200);
    vi.stubEnv("FINANZBLICK_MAX_ACCOUNTS", "0");
    expect(() => readAccountConfig()).toThrow(/FINANZBLICK_MAX_ACCOUNTS/);
    vi.stubEnv("FINANZBLICK_MAX_ACCOUNTS", "100");
    vi.stubEnv("FINANZBLICK_MAX_STORAGE_MB", "0");
    expect(() => readAccountConfig()).toThrow(/FINANZBLICK_MAX_STORAGE_MB/);
  });
});
