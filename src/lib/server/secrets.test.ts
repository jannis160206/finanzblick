import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { masterKey, openSecret, resetSecretKeyCache, sealSecret, SecretError } from "./secrets";

let directory: string;
beforeEach(async () => {
  resetSecretKeyCache();
  directory = await mkdtemp(join(tmpdir(), "finanzblick-secrets-"));
});
afterEach(async () => {
  resetSecretKeyCache();
  await rm(directory, { recursive: true, force: true });
});

describe("secrets at rest", () => {
  it("round-trips a value and never stores it in plain text", async () => {
    const key = await masterKey(directory, {});
    const sealed = sealSecret("synthetisch-geheim", key, "finanzblick:user:payslip-password");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("synthetisch");
    expect(openSecret(sealed, key, "finanzblick:user:payslip-password")).toBe("synthetisch-geheim");
    expect(sealSecret("synthetisch-geheim", key, "x")).not.toBe(sealSecret("synthetisch-geheim", key, "x"));
  });

  it("rejects a value moved to another context, a tampered value and another key", async () => {
    const key = await masterKey(directory, {});
    const sealed = sealSecret("synthetisch-geheim", key, "finanzblick:alice:payslip-password");
    expect(() => openSecret(sealed, key, "finanzblick:bob:payslip-password")).toThrow(SecretError);
    const parts = sealed.split(".");
    const data = Buffer.from(parts[3], "base64url");
    data[0] ^= 1;
    expect(() => openSecret([...parts.slice(0, 3), data.toString("base64url")].join("."), key, "finanzblick:alice:payslip-password")).toThrow(SecretError);
    expect(() => openSecret(sealed, Buffer.alloc(32, 7), "finanzblick:alice:payslip-password")).toThrow(SecretError);
    expect(() => openSecret("v2.a.b.c", key, "x")).toThrow(SecretError);
  });

  it("creates one private key file and keeps using it", async () => {
    const first = await masterKey(directory, {});
    resetSecretKeyCache();
    const second = await masterKey(directory, {});
    expect(second.equals(first)).toBe(true);
    expect(Buffer.from(await readFile(join(directory, "secret.key"), "utf8"), "base64").equals(first)).toBe(true);
    if (process.platform !== "win32") expect((await stat(join(directory, "secret.key"))).mode & 0o777).toBe(0o600);
  });

  it("prefers FINANZBLICK_SECRET_KEY and validates its length", async () => {
    const configured = Buffer.alloc(32, 3);
    expect((await masterKey(directory, { FINANZBLICK_SECRET_KEY: configured.toString("base64") })).equals(configured)).toBe(true);
    await expect(masterKey(directory, { FINANZBLICK_SECRET_KEY: Buffer.alloc(16).toString("base64") })).rejects.toThrow(/32 Byte/);
  });
});
