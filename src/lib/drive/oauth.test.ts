import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAuthorization, DRIVE_SCOPE, DriveAuthError, driveOAuthConfig, exchangeCode, missingDriveCredentials, refreshAccessToken, revokeToken } from "./oauth";

const config = { clientId: "synthetic-client.apps.example", clientSecret: "synthetic-secret", redirectUri: "http://localhost:3000/api/auth/callback/google" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Google OAuth for Drive", () => {
  it("reads client id and secret only from the environment and derives the redirect URI", () => {
    expect(driveOAuthConfig("http://localhost:3000", {})).toBeNull();
    expect(driveOAuthConfig("http://localhost:3000", { GOOGLE_CLIENT_ID: "id" })).toBeNull();
    expect(driveOAuthConfig("http://localhost:3000", { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }))
      .toEqual({ clientId: "id", clientSecret: "secret", redirectUri: "http://localhost:3000/api/auth/callback/google" });
    expect(driveOAuthConfig("http://localhost:3000", { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REDIRECT_URI: "https://finanzen.example/api/auth/callback/google" })?.redirectUri)
      .toBe("https://finanzen.example/api/auth/callback/google");
  });

  it("uses the registered localhost redirect for every loopback origin and names missing credentials", () => {
    const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
    expect(driveOAuthConfig("http://127.0.0.1:3000", env)?.redirectUri).toBe("http://localhost:3000/api/auth/callback/google");
    expect(driveOAuthConfig("http://[::1]:3000", env)?.redirectUri).toBe("http://localhost:3000/api/auth/callback/google");
    expect(driveOAuthConfig("https://finanzen.example", env)?.redirectUri).toBe("https://finanzen.example/api/auth/callback/google");
    expect(missingDriveCredentials({})).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
    expect(missingDriveCredentials({ GOOGLE_CLIENT_ID: " id ", GOOGLE_CLIENT_SECRET: "   " })).toEqual(["GOOGLE_CLIENT_SECRET"]);
    expect(missingDriveCredentials(env)).toEqual([]);
  });

  it("carries the starting origin in the state only when Google returns to another one", () => {
    expect(createAuthorization(config, "http://localhost:3000").state).not.toContain(".");
    const [random, back] = createAuthorization(config, "http://127.0.0.1:3000").state.split(".");
    expect(random).toMatch(/^[\w-]{43}$/);
    expect(Buffer.from(back, "base64url").toString()).toBe("http://127.0.0.1:3000");
  });

  it("asks for read-only Drive access with offline access, state and a PKCE S256 challenge", () => {
    const { url, state, verifier } = createAuthorization(config);
    const params = new URL(url).searchParams;
    expect(new URL(url).origin).toBe("https://accounts.google.com");
    expect(params.get("scope")).toBe(DRIVE_SCOPE);
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("redirect_uri")).toBe(config.redirectUri);
    expect(params.get("state")).toBe(state);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(url).not.toContain(config.clientSecret);
    expect(createAuthorization(config).state).not.toBe(state);
  });

  it("exchanges the code with the verifier and requires the Drive scope and a refresh token", async () => {
    const fetcher = vi.fn(async () => json({ access_token: "a1", expires_in: 3600, refresh_token: "r1", scope: `${DRIVE_SCOPE} openid` }));
    expect(await exchangeCode(config, "code-1", "verifier-1", fetcher as typeof fetch, 1_000)).toEqual({ accessToken: "a1", accessExpiresAt: 3_601_000, refreshToken: "r1" });
    const body = new URLSearchParams(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(Object.fromEntries(body)).toMatchObject({ code: "code-1", code_verifier: "verifier-1", grant_type: "authorization_code", redirect_uri: config.redirectUri });
    await expect(exchangeCode(config, "c", "v", (async () => json({ access_token: "a", expires_in: 3600, refresh_token: "r", scope: "openid" })) as typeof fetch))
      .rejects.toMatchObject({ kind: "denied" });
    await expect(exchangeCode(config, "c", "v", (async () => json({ access_token: "a", expires_in: 3600, scope: DRIVE_SCOPE })) as typeof fetch))
      .rejects.toBeInstanceOf(DriveAuthError);
  });

  it("reports an expired refresh token separately and refreshes access tokens", async () => {
    await expect(refreshAccessToken(config, "r", (async () => json({ error: "invalid_grant" }, 400)) as typeof fetch)).rejects.toMatchObject({ kind: "expired" });
    await expect(refreshAccessToken(config, "r", (async () => { throw new TypeError("offline"); }) as typeof fetch)).rejects.toMatchObject({ kind: "failed" });
    expect(await refreshAccessToken(config, "r", (async () => json({ access_token: "a2", expires_in: 600 })) as typeof fetch, 0))
      .toEqual({ accessToken: "a2", accessExpiresAt: 600_000 });
  });

  it("revokes best effort", async () => {
    expect(await revokeToken("r", (async () => new Response(null, { status: 200 })) as typeof fetch)).toBe(true);
    expect(await revokeToken("r", (async () => { throw new Error("offline"); }) as typeof fetch)).toBe(false);
  });
});
