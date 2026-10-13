import { mkdirSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAccountRuntime, closeAccountDatabases } from "@/lib/server/runtime";
import { createTestDirectory } from "@/lib/server/test-support";
import { uploadStatement, statementEvents } from "./handlers";
import { AutomationStore } from "./store";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AccountError } from "@/lib/server/errors";
import { AutomationWorker } from "./worker";
import { MerchantIndex } from "./merchants";

let directory: string;
let alice: { id: string; token: string };
let bob: { id: string; token: string };
beforeEach(async () => {
  directory = createTestDirectory();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FINANZBLICK_AUTH", "true");
  vi.stubEnv("FINANZBLICK_DATABASE_PATH", join(directory, "accounts.sqlite"));
  vi.stubEnv("FINANZBLICK_ADMIN_PASSWORD", "test-only-password-123");
  vi.stubEnv("FINANZBLICK_ORIGIN", "http://localhost:3000");
  const { database } = await getAccountRuntime();
  const first = await database.register("alice", "test-only-password-123");
  const second = await database.register("bob", "test-only-password-123");
  alice = { id: first.user.id, token: first.token };
  bob = { id: second.user.id, token: second.token };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeAccountDatabases();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function request(user = alice, account = user.id, body = "not parsed here") {
  return new Request("http://localhost:3000/api/statements?name=test.csv", {
    method: "POST",
    body,
    headers: {
      Origin: "http://localhost:3000",
      "Content-Type": "application/octet-stream",
      "X-Finanzblick-Account": account,
      "X-Upload-Size": String(Buffer.byteLength(body)),
      Cookie: `finanzblick_session=${user.token}`,
    },
  });
}
function events(user = alice, account = user.id) {
  return statementEvents(
    new Request(
      `http://localhost:3000/api/statements/events?account=${account}`,
      {
        headers: { Cookie: `finanzblick_session=${user.token}` },
      },
    ),
  );
}

it("only persists and enqueues the upload, returning 202 without parsing", async () => {
  const response = await uploadStatement(request());
  expect(response.status).toBe(202);
  const { id } = await response.json();
  const { database } = await getAccountRuntime();
  const store = new AutomationStore(database);
  expect((await readFile(store.filePath(id))).toString()).toBe(
    "not parsed here",
  );
  expect(store.snapshot(alice.id).jobs[0].status).toBe("QUEUED");
  expect(database.getFinance(alice.id).state).toBeNull();
});

it("correlates client uploads by validated UUID and never overwrites a reused ID", async () => {
  const id = randomUUID();
  const input = request();
  input.headers.set("X-Upload-Id", id);
  const response = await uploadStatement(input);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ id });
  const duplicate = request(bob);
  duplicate.headers.set("X-Upload-Id", id);
  expect((await uploadStatement(duplicate)).status).toBe(409);
  const { database } = await getAccountRuntime();
  const store = new AutomationStore(database);
  expect(store.snapshot(alice.id).jobs.map((job) => job.id)).toEqual([id]);
  expect(store.snapshot(bob.id).jobs).toEqual([]);
  expect((await readFile(store.filePath(id))).toString()).toBe("not parsed here");
});

it.each(["not-a-uuid", "../outside", ""])("rejects invalid client upload ID %s before reserving a job", async (id) => {
  const input = request();
  input.headers.set("X-Upload-Id", id);
  expect((await uploadStatement(input)).status).toBe(400);
  const { database } = await getAccountRuntime();
  expect(new AutomationStore(database).snapshot(alice.id).jobs).toEqual([]);
});

it("rejects unauthenticated, switched-account and cross-origin uploads", async () => {
  expect(
    (await uploadStatement(request({ id: alice.id, token: "" }))).status,
  ).toBe(401);
  expect((await uploadStatement(request(alice, bob.id))).status).toBe(401);
  const cross = request();
  cross.headers.set("origin", "https://untrusted.example");
  expect((await uploadStatement(cross)).status).toBe(403);
  expect((await events(alice, bob.id)).status).toBe(401);
});

it("rejects incorrect byte counts and reports the failed upload without leaving a payload", async () => {
  const input = request();
  input.headers.set("X-Upload-Size", "1");
  expect((await uploadStatement(input)).status).toBe(413);
  const { database } = await getAccountRuntime();
  const job = new AutomationStore(database).snapshot(alice.id).jobs[0];
  expect(job.status).toBe("FAILED");
  await expect(
    readFile(new AutomationStore(database).filePath(job.id)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("streams only tenant-owned progress and releases connection slots on cancellation", async () => {
  await uploadStatement(request());
  const response = await events(bob);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain('"jobs":[]');
  expect(first).not.toContain("test.csv");
  await reader.cancel();
  const streams = [];
  for (let i = 0; i < 5; i++) streams.push(await events());
  expect((await events()).status).toBe(429);
  for (const stream of streams) await stream.body!.cancel();
  const recovered = await events();
  expect(recovered.status).toBe(200);
  await recovered.body!.cancel();
});

it("revokes an active SSE stream when the session is logged out", async () => {
  vi.useFakeTimers();
  const response = await events();
  const reader = response.body!.getReader();
  await reader.read();
  const { database } = await getAccountRuntime();
  database.logout(alice.token);
  await vi.advanceTimersByTimeAsync(1000);
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    "event: unauthorized",
  );
  expect((await reader.read()).done).toBe(true);
  vi.useRealTimers();
});

it("keeps active SSE authorization and heartbeats readable throughout another writer's long lock", async () => {
  vi.useFakeTimers();
  const { database } = await getAccountRuntime();
  database.read((db) => db.exec("PRAGMA busy_timeout = 1"));
  const writer = new DatabaseSync(database.path);
  const response = await events();
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: progress");
  try {
    writer.exec("BEGIN IMMEDIATE");
    await vi.advanceTimersByTimeAsync(16_000);
    const heartbeat = new TextDecoder().decode((await reader.read()).value);
    expect(heartbeat).toContain(": heartbeat");
    expect(heartbeat).not.toContain("unavailable");
    writer.exec("ROLLBACK");
    const accepted = await uploadStatement(request());
    expect(accepted.status).toBe(202);
    const { id } = await accepted.json();
    await vi.advanceTimersByTimeAsync(1000);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(id);
  } finally {
    await reader.cancel();
    writer.close();
  }
});

it("reports a real late readyUpload lock as 503 and leaves locked cleanup to existing expiry without losing finance", async () => {
  const { database } = await getAccountRuntime();
  database.read((db) => db.exec("PRAGMA busy_timeout = 1"));
  const before = database.getFinance(alice.id);
  const writer = new DatabaseSync(database.path);
  const original = AutomationStore.prototype.readyUpload;
  const ready = vi.spyOn(AutomationStore.prototype, "readyUpload").mockImplementation(function (this: AutomationStore, userId, id) {
    writer.exec("BEGIN IMMEDIATE");
    return original.call(this, userId, id);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const input = request();
    const id = randomUUID();
    input.headers.set("X-Upload-Id", id);
    const response = await uploadStatement(input);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toEqual({
      error: "Der Server ist vorübergehend ausgelastet. Bitte kurz warten und erneut versuchen.",
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Upload cleanup deferred: database temporarily busy.");
    const store = new AutomationStore(database);
    expect(store.snapshot(alice.id).jobs).toMatchObject([{ id, status: "UPLOADING" }]);
    expect((await readFile(store.filePath(id))).toString()).toBe("not parsed here");
    expect(database.getFinance(alice.id)).toEqual(before);
    writer.exec("ROLLBACK");
    ready.mockRestore();
    database.read((db) => db.prepare("UPDATE automation_jobs SET updated_at = ? WHERE id = ?")
      .run(Date.now() - 16 * 60_000, id));
    expect(store.acquire("cleanup-test")).toBe(true);
    expect(store.claim("cleanup-test")).toBeNull();
    expect(store.snapshot(alice.id).jobs).toMatchObject([{ id, status: "FAILED" }]);
    const worker = new AutomationWorker(store, "cleanup-test", new MerchantIndex([]));
    await worker.cleanup();
    expect(database.read((db) => db.prepare("SELECT bytes FROM automation_jobs WHERE id = ?").get(id)))
      .toEqual({ bytes: 0 });
    await expect(readFile(store.filePath(id))).rejects.toMatchObject({ code: "ENOENT" });
    const reselected = request();
    const newId = randomUUID();
    reselected.headers.set("X-Upload-Id", newId);
    expect((await uploadStatement(reselected)).status).toBe(202);
    expect(store.snapshot(alice.id).jobs.map((job) => job.id).sort()).toEqual([id, newId].sort());
    expect(database.getFinance(alice.id)).toEqual(before);
    store.release("cleanup-test");
  } finally { writer.close(); }
});

it("releases the failed upload file and reservation when readyUpload rejects before queueing", async () => {
  vi.spyOn(AutomationStore.prototype, "readyUpload").mockImplementation(() => {
    throw new AccountError(409, "Der Upload ist nicht mehr verfügbar.");
  });

  const response = await uploadStatement(request());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "Der Upload ist nicht mehr verfügbar." });
  const { database } = await getAccountRuntime();
  const store = new AutomationStore(database);
  const job = store.snapshot(alice.id).jobs[0];
  expect(job.status).toBe("FAILED");
  expect(database.read((db) => db.prepare("SELECT bytes FROM automation_jobs WHERE id = ?").get(job.id)))
    .toEqual({ bytes: 0 });
  await expect(readFile(store.filePath(job.id))).rejects.toMatchObject({ code: "ENOENT" });
});

it("returns 503 when reserveUpload contends after a successful rate-limit write, then accepts the same ID after release", async () => {
  const { database } = await getAccountRuntime();
  database.read((db) => db.exec("PRAGMA busy_timeout = 1"));
  const writer = new DatabaseSync(database.path);
  const consume = database.consumeRateLimit.bind(database);
  const hook = vi.spyOn(database, "consumeRateLimit").mockImplementation((...args) => {
    consume(...args);
    writer.exec("BEGIN IMMEDIATE");
  });
  const id = randomUUID();
  try {
    const input = request();
    input.headers.set("X-Upload-Id", id);
    const response = await uploadStatement(input);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    const store = new AutomationStore(database);
    expect(store.snapshot(alice.id).jobs).toEqual([]);
    await expect(readFile(store.filePath(id))).rejects.toMatchObject({ code: "ENOENT" });
    writer.exec("ROLLBACK");
    hook.mockRestore();
    const reselected = request();
    reselected.headers.set("X-Upload-Id", id);
    const accepted = await uploadStatement(reselected);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ id });
    expect(store.snapshot(alice.id).jobs).toMatchObject([{ id, status: "QUEUED" }]);
  } finally { hook.mockRestore(); writer.close(); }
});

it("preserves the original safe diagnosis when final cleanup accounting fails", async () => {
  const cleaned = vi.spyOn(AutomationStore.prototype, "cleaned").mockImplementation(() => {
    throw new Error("Private cleanup detail");
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const input = request();
  input.headers.set("X-Upload-Size", "1");
  const response = await uploadStatement(input);
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "Die Datei ist größer als angekündigt." });
  expect(log).toHaveBeenCalledExactlyOnceWith("Unexpected upload cleanup failure.");
  const { database } = await getAccountRuntime();
  const store = new AutomationStore(database);
  const job = store.snapshot(alice.id).jobs[0];
  expect(job.status).toBe("FAILED");
  await expect(readFile(store.filePath(job.id))).rejects.toMatchObject({ code: "ENOENT" });
  cleaned.mockRestore();
  await new AutomationWorker(store, "cleanup-test", new MerchantIndex([])).cleanup();
  expect(database.read((db) => db.prepare("SELECT bytes FROM automation_jobs WHERE id = ?").get(job.id)))
    .toEqual({ bytes: 0 });
});

it("preserves the upload diagnosis on a real filesystem cleanup failure and releases capacity once removal is possible", async () => {
  const ready = vi.spyOn(AutomationStore.prototype, "readyUpload").mockImplementation(function (this: AutomationStore, tenant, id) {
    const path = this.filePath(id);
    unlinkSync(path);
    mkdirSync(path);
    throw new AccountError(409, "Der Upload ist nicht mehr verfügbar.");
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await uploadStatement(request());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "Der Upload ist nicht mehr verfügbar." });
  expect(log).toHaveBeenCalledExactlyOnceWith("Upload cleanup deferred: file removal unavailable.");
  const { database } = await getAccountRuntime();
  const store = new AutomationStore(database);
  const job = store.snapshot(alice.id).jobs[0];
  expect(job.status).toBe("FAILED");
  expect(database.read((db) => db.prepare("SELECT bytes FROM automation_jobs WHERE id = ?").get(job.id)))
    .toEqual({ bytes: Buffer.byteLength("not parsed here") });
  rmdirSync(store.filePath(job.id));
  ready.mockRestore();
  await new AutomationWorker(store, "cleanup-test", new MerchantIndex([])).cleanup();
  expect(database.read((db) => db.prepare("SELECT bytes FROM automation_jobs WHERE id = ?").get(job.id)))
    .toEqual({ bytes: 0 });
});

it("never deletes a queued payload if a late diagnostic follows its confirmed acceptance", async () => {
  const original = AutomationStore.prototype.readyUpload;
  vi.spyOn(AutomationStore.prototype, "readyUpload").mockImplementation(function (this: AutomationStore, userId, id) {
    original.call(this, userId, id);
    throw new AccountError(409, "Der Upload wurde bereits angenommen.");
  });
  const response = await uploadStatement(request());
  expect(response.status).toBe(409);
  const { database } = await getAccountRuntime();
  const store = new AutomationStore(database);
  const job = store.snapshot(alice.id).jobs[0];
  expect(job.status).toBe("QUEUED");
  expect((await readFile(store.filePath(job.id))).toString()).toBe("not parsed here");
});
