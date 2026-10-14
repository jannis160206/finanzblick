import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import { IMPORT_RESULT_RETENTION_MS, importResultSchema } from "@/lib/import/result-schema";
import { automationFailure } from "./errors";
import { AutomationStore, type ClaimedJob } from "./store";
import { MAX_ATTEMPTS } from "./schema";

let directory: string;
let accounts: AccountDatabase;
let store: AutomationStore;
let userId: string;
let job: ClaimedJob;
const owner = "store-runtime-owner";
beforeEach(async () => {
  directory = createTestDirectory();
  accounts = new AccountDatabase(join(directory, "synthetic.sqlite"));
  store = new AutomationStore(accounts);
  userId = (await accounts.register("alice", "test-only-password-123")).user.id;
  const id = randomUUID();
  store.reserveUpload(userId, id, "synthetic.csv", 1);
  store.readyUpload(userId, id);
  store.acquire(owner);
  job = store.claim(owner)!;
});
afterEach(() => {
  vi.useRealTimers();
  accounts.close();
  rmSync(directory, { recursive: true, force: true });
});

it("persists safe typed infrastructure retries within the original five-attempt budget", () => {
  vi.useFakeTimers();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    store.fail(owner, job, automationFailure("PARSE_INFRASTRUCTURE"));
    expect(store.snapshot(userId).jobs[0]).toMatchObject({
      attempts: attempt,
      status: attempt < MAX_ATTEMPTS ? "RETRYING" : "FAILED",
      errorCode: "PARSE_INFRASTRUCTURE",
    });
    expect(store.claim(owner)).toBeNull();
    vi.setSystemTime(Date.now() + 1000 * 2 ** (attempt - 1));
    store.heartbeat(owner);
    if (attempt < MAX_ATTEMPTS) job = store.claim(owner)!;
  }
});

it("serves uploads before an older queued backfill so imports are never blocked", () => {
  store.cancel(owner, job);
  const backfill = randomUUID();
  const upload = randomUUID();
  const now = Date.now();
  accounts.transaction((db) => {
    db.prepare("UPDATE automation_jobs SET status = 'COMPLETED' WHERE id = ?").run(job.id);
    const insert = db.prepare(`INSERT INTO automation_jobs
      (id, user_id, kind, name, status, bytes, available_at, updated_at, created_at)
      VALUES (?, ?, ?, 'synthetic.csv', 'QUEUED', 1, ?, ?, ?)`);
    insert.run(backfill, userId, "backfill", now - 1000, now - 1000, now - 1000);
    insert.run(upload, userId, "statement", now, now, now);
  });
  const first = store.claim(owner, now)!;
  expect(first.id).toBe(upload);
  store.fail(owner, first, automationFailure("PARSE_INFRASTRUCTURE"));
  expect(store.claim(owner, now)).toMatchObject({ id: backfill });
});

it("keeps faithful graceful-abort status across restart, without spending retries", () => {
  store.cancel(owner, job);
  expect(() => store.progress(owner, job, 50)).toThrow("ownership lost");
  store.release(owner);
  const path = accounts.path;
  accounts.close();
  accounts = new AccountDatabase(path);
  store = new AutomationStore(accounts);
  expect(store.snapshot(userId).jobs[0]).toMatchObject({
    status: "QUEUED", attempts: 0, errorCode: "WORKER_ABORTED", result: null,
  });
  expect(store.acquire("replacement")).toBe(true);
  expect(store.claim("replacement")).toMatchObject({
    id: job.id, attempts: 0, errorCode: null,
  });
});

it("commits the UUID-linked outcome, cursor and finance in the same fenced transaction", () => {
  const result = importResultSchema.parse({
    uploadId: job.id, name: job.name, completedAt: Date.now(),
    status: "with-warnings", inserted: 1, updated: 0, duplicates: 0, review: 1,
    skipped: 0, issues: [{ id: "issue-1", message: "Please check.", action: "correct" }],
  });
  expect(() => accounts.transformFinance(userId, () => blankTestState(), (db) => {
    store.checkpoint(db, owner, job, 2, true, result);
    throw new Error("Simulated transaction interruption");
  })).toThrow("Simulated transaction interruption");
  expect(accounts.getFinance(userId)).toEqual({ state: null, revision: 0 });
  expect(store.snapshot(userId).jobs[0]).toMatchObject({
    status: "PROCESSING", cursor: 0, result: null,
  });
  expect(() => accounts.transformFinance(userId, () => blankTestState(), (db) => {
    store.checkpoint(db, owner, job, 2, true, { ...result, uploadId: randomUUID() });
  })).toThrow("mismatch");
  expect(accounts.getFinance(userId).revision).toBe(0);
  accounts.transformFinance(userId, () => blankTestState(), (db) =>
    store.checkpoint(db, owner, job, 2, true, result));
  const path = accounts.path;
  accounts.close();
  accounts = new AccountDatabase(path);
  store = new AutomationStore(accounts);
  expect(store.snapshot(userId).jobs[0]).toMatchObject({
    status: "COMPLETED", cursor: 2, errorCode: null, result,
  });
  expect(accounts.getFinance(userId).revision).toBe(1);
});

it("expires terminal statement metadata independently while preserving active jobs, originals and backfill provenance", () => {
  const now = Date.now();
  const boundary = now - IMPORT_RESULT_RETENTION_MS;
  const expired = [randomUUID(), randomUUID()];
  const recent = randomUUID();
  const filePending = randomUUID();
  const active = randomUUID();
  const backfill = randomUUID();
  const outcome = importResultSchema.parse({
    uploadId: expired[0], name: "old.csv", completedAt: boundary,
    status: "imported", inserted: 0, updated: 0, duplicates: 1, review: 0,
    skipped: 0, issues: [],
  });
  accounts.transaction((db) => {
    const insert = db.prepare(`INSERT INTO automation_jobs
      (id, user_id, kind, name, status, bytes, available_at, updated_at, created_at, outcome_json)
      VALUES (?, ?, ?, 'synthetic.csv', ?, ?, ?, ?, ?, ?)`);
    insert.run(expired[0], userId, "statement", "COMPLETED", 0, boundary, boundary, boundary, JSON.stringify(outcome));
    insert.run(expired[1], userId, "statement", "FAILED", 0, boundary, boundary, boundary, null);
    insert.run(recent, userId, "statement", "COMPLETED", 0, now, now, now, null);
    insert.run(filePending, userId, "statement", "FAILED", 1, boundary, boundary, boundary, null);
    insert.run(active, userId, "statement", "QUEUED", 0, boundary, boundary, boundary, null);
    insert.run(backfill, userId, "backfill", "COMPLETED", 0, boundary, boundary, boundary, null);
    db.prepare("INSERT INTO automation_backfill_passes (user_id, version, job_id, completed_at) VALUES (?, ?, ?, ?)")
      .run(userId, "retention-protected", backfill, boundary);
  });
  store.pruneCompletedStatements(now);
  const remaining = store.snapshot(userId).jobs.map((item) => item.id);
  expect(remaining).toEqual(expect.arrayContaining([job.id, recent, filePending, active, backfill]));
  for (const id of expired) expect(remaining).not.toContain(id);
  expect(accounts.getFinance(userId)).toEqual({ state: null, revision: 0 });
  expect(store.enqueueBackfill(userId, now, { onceVersion: "retention-protected" })).toMatchObject({
    id: backfill, status: "COMPLETED",
  });
  const path = accounts.path;
  accounts.close();
  accounts = new AccountDatabase(path);
  store = new AutomationStore(accounts);
  expect(accounts.read((db) => db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'automation_statement_retention'",
  ).get())).toMatchObject({ name: "automation_statement_retention" });
  expect(store.snapshot(userId).jobs.map((item) => item.id)).toEqual(remaining);
});

it("keeps legacy results unavailable and rejects mismatched persisted job provenance", () => {
  expect(store.snapshot(userId).jobs[0].result).toBeNull();
  const result = importResultSchema.parse({
    uploadId: randomUUID(), name: "another-upload.csv", completedAt: Date.now(),
    status: "imported", inserted: 2, updated: 0, duplicates: 0, review: 0,
    skipped: 0, issues: [],
  });
  accounts.transaction((db) => db.prepare(
    "UPDATE automation_jobs SET outcome_json = ? WHERE id = ?",
  ).run(JSON.stringify(result), job.id));
  expect(() => store.snapshot(userId)).toThrow("Import result/job mismatch");
});

it("cancels active statements for their owner only, fences the running worker and reports finished or unknown ids", () => {
  const other = randomUUID();
  const queued = randomUUID();
  store.reserveUpload(userId, queued, "queued.csv", 1);
  store.readyUpload(userId, queued);
  expect(store.cancelStatement(randomUUID(), queued)).toBe("missing");
  expect(store.cancelStatement(userId, other)).toBe("missing");
  expect(store.cancelStatement(userId, queued)).toBe("cancelled");
  expect(store.cancelStatement(userId, queued)).toBe("finished");
  expect(store.snapshot(userId).jobs.find((item) => item.id === queued)).toMatchObject({
    status: "FAILED", error: "Vom Nutzer abgebrochen.",
  });
  expect(store.holds(owner, job)).toBe(true);
  expect(store.cancelStatement(userId, job.id)).toBe("cancelled");
  expect(store.holds(owner, job)).toBe(false);
  expect(() => accounts.transformFinance(userId, () => blankTestState(), (db) =>
    store.checkpoint(db, owner, job, 1, true))).toThrow("ownership lost");
  expect(accounts.getFinance(userId)).toEqual({ state: null, revision: 0 });
});

it("reports whether a worker currently holds a valid lease", () => {
  expect(store.snapshot(userId).worker).toEqual({ running: true });
  store.release(owner, false);
  expect(store.snapshot(userId).worker).toEqual({ running: false });
});