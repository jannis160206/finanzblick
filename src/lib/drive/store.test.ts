import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetSecretKeyCache } from "@/lib/server/secrets";
import { disconnectDrive, driveAccessToken, driveStatus, readDriveLink, saveDriveConnection } from "./store";

const config = { clientId: "id", clientSecret: "secret", redirectUri: "http://localhost:3000/api/auth/callback/google" };
let directory: string;
let host: { path: string };
beforeEach(async () => {
  resetSecretKeyCache();
  directory = await mkdtemp(join(tmpdir(), "finanzblick-drive-"));
  host = { path: join(directory, "accounts.sqlite") };
});
afterEach(async () => {
  resetSecretKeyCache();
  await rm(directory, { recursive: true, force: true });
});

const tokens = { accessToken: "synthetic-access", accessExpiresAt: 2_000_000, refreshToken: "synthetic-refresh" };

it("keeps tokens encrypted and only status data in the link file", async () => {
  await saveDriveConnection(host, "alice", tokens, { email: "alice@example.test" }, 1_000_000);
  const files = await readdir(join(directory, "drive-links"));
  const link = await readFile(join(directory, "drive-links", files[0]), "utf8");
  expect(link).not.toContain("synthetic-refresh");
  expect(link).not.toContain("synthetic-access");
  expect(await readFile(join(directory, "secrets", "alice.json"), "utf8")).not.toContain("synthetic-refresh");
  expect(await driveStatus(host, "alice", config)).toMatchObject({ configured: true, connected: true, email: "alice@example.test", connectedAt: 1_000_000, redirectUri: config.redirectUri });
  expect(await driveStatus(host, "bob", null)).toEqual({ configured: false, connected: false });
});

it("uses a valid access token, refreshes it shortly before expiry and marks an expired grant", async () => {
  await saveDriveConnection(host, "alice", tokens, {}, 0);
  const fetcher = vi.fn(async () => Response.json({ access_token: "fresh", expires_in: 3600 }));
  expect(await driveAccessToken(host, "alice", config, fetcher as typeof fetch, 1_000_000)).toBe("synthetic-access");
  expect(fetcher).not.toHaveBeenCalled();
  expect(await driveAccessToken(host, "alice", config, fetcher as typeof fetch, 1_950_000)).toBe("fresh");
  expect(await driveAccessToken(host, "alice", config, fetcher as typeof fetch, 1_960_000)).toBe("fresh");
  expect(fetcher).toHaveBeenCalledOnce();
  const expired = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await expect(driveAccessToken(host, "alice", config, expired as typeof fetch, 99_000_000)).rejects.toMatchObject({ kind: "expired" });
  expect(await readDriveLink(host, "alice")).toMatchObject({ expired: true });
  expect((await driveStatus(host, "alice", config)).expired).toBe(true);
});

it("revokes and forgets the connection when disconnecting", async () => {
  await saveDriveConnection(host, "alice", tokens, {});
  const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
  await disconnectDrive(host, "alice", fetcher as typeof fetch);
  expect(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)).toContain("synthetic-refresh");
  expect(await readDriveLink(host, "alice")).toBeNull();
  await expect(driveAccessToken(host, "alice", config, fetcher as typeof fetch)).rejects.toMatchObject({ kind: "expired" });
});
