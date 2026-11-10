import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetSecretKeyCache } from "./secrets";
import { deleteUserSecret, readUserSecret, userSecretInfo, writeUserSecret } from "./user-secrets";

let directory: string;
let host: { path: string };
beforeEach(async () => {
  resetSecretKeyCache();
  directory = await mkdtemp(join(tmpdir(), "finanzblick-user-secrets-"));
  host = { path: join(directory, "accounts.sqlite") };
});
afterEach(async () => {
  resetSecretKeyCache();
  await rm(directory, { recursive: true, force: true });
});

it("stores, reads and removes a per-user secret without plain text on disk", async () => {
  expect(await userSecretInfo(host, "alice", "payslip-password")).toBeNull();
  expect(await readUserSecret(host, "alice", "payslip-password")).toBeNull();
  const { updatedAt } = await writeUserSecret(host, "alice", "payslip-password", "synthetisch-123", 1_800_000_000_000);
  expect(updatedAt).toBe(1_800_000_000_000);
  expect(await userSecretInfo(host, "alice", "payslip-password")).toEqual({ updatedAt });
  expect(await readUserSecret(host, "alice", "payslip-password")).toBe("synthetisch-123");
  expect(await readFile(join(directory, "secrets", "alice.json"), "utf8")).not.toContain("synthetisch-123");
  await deleteUserSecret(host, "alice", "payslip-password");
  expect(await readUserSecret(host, "alice", "payslip-password")).toBeNull();
});

it("keeps users apart: another user's sealed value cannot be read under a different account", async () => {
  await writeUserSecret(host, "alice", "payslip-password", "nur-alice");
  await writeUserSecret(host, "bob", "payslip-password", "nur-bob");
  expect(await readUserSecret(host, "bob", "payslip-password")).toBe("nur-bob");
  await writeFile(join(directory, "secrets", "bob.json"), await readFile(join(directory, "secrets", "alice.json"), "utf8"));
  await expect(readUserSecret(host, "bob", "payslip-password")).rejects.toThrow();
});

it("keeps other secrets of the same user when one is replaced or removed", async () => {
  await writeUserSecret(host, "alice", "payslip-password", "eins");
  await writeUserSecret(host, "alice", "google-drive", "{\"refresh\":\"token\"}");
  await writeUserSecret(host, "alice", "payslip-password", "zwei");
  await deleteUserSecret(host, "alice", "payslip-password");
  expect(await readUserSecret(host, "alice", "google-drive")).toBe("{\"refresh\":\"token\"}");
});

it("rejects unsafe user ids", async () => {
  await expect(writeUserSecret(host, "../evil", "payslip-password", "x")).rejects.toThrow();
});
