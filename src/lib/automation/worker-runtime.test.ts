import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import { AutomationStore } from "./store";
import { AutomationWorker } from "./worker";
import { MerchantIndex, seedMerchants } from "./merchants";
import { ParserFailure, type AutomationErrorCode } from "./errors";
import { IMPORT_RESULT_RETENTION_MS } from "@/lib/import/result-schema";

let directory: string;
let accounts: AccountDatabase;
let store: AutomationStore;
let userId: string;
const owner = "runtime-test-worker";
const csv = Buffer.from(
  'American Express\nDatum,Beschreibung,Karteninhaber,Kartennummer,Betrag\n08.10.2026,BILLA,Test User,XXXX-1001,"42,00"',
);
beforeEach(async () => {
  directory = createTestDirectory();
  accounts = new AccountDatabase(join(directory, "synthetic.sqlite"));
  store = new AutomationStore(accounts);
  userId = (await accounts.register("alice", "test-only-password-123")).user.id;
  store.upsertMerchants(seedMerchants);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  accounts.close();
  rmSync(directory, { recursive: true, force: true });
});
async function upload(name = "statement.csv", bytes = csv) {
  const id = randomUUID();
  store.reserveUpload(userId, id, name, bytes.length);
  await mkdir(dirname(store.filePath(id)), { recursive: true });
  await writeFile(store.filePath(id), bytes);
  store.readyUpload(userId, id);
  return id;
}
async function syntheticParser() {
  const entrypoint = join(directory, "synthetic-parser.mjs");
  await writeFile(entrypoint, `
    import { writeFile } from "node:fs/promises";
    import { Worker } from "node:worker_threads";
    process.once("message", async (request) => {
      if (request.name === "hang.csv") {
        new Worker("while (true) {}", { eval: true });
        await writeFile(request.path + ".started", String(process.pid));
        while (true) {}
      }
      const result = {
        source: "Amex", file: request.name, skipped: 0, issues: [],
        rows: [{
          id: "synthetic-booking", date: "2026-10-08", bank: "Amex",
          pocket: "Amex", description: "BILLA", category: "Prüfen",
          amount: -42, includeInPlan: true,
        }],
      };
      process.send({type:"result", id:request.id, result}, () => process.exit(0));
    });
  `);
  return entrypoint;
}
async function started(id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (existsSync(`${store.filePath(id)}.started`)) return;
    await delay(10);
  }
  throw new Error("Synthetic child never started");
}
function createWorker(options: ConstructorParameters<typeof AutomationWorker>[3] = {}) {
  return new AutomationWorker(store, owner, new MerchantIndex(store.loadMerchants()), options);
}

it("retries an actual concurrent finance conflict in the running worker without losing the edit", async () => {
  await upload();
  const editor = new AccountDatabase(accounts.path);
  const changed = { ...blankTestState(), seasonalTheme: { reduceMotion: true } };
  const transformFinance = accounts.transformFinance.bind(accounts);
  vi.spyOn(accounts, "transformFinance").mockImplementationOnce((tenant, reconcile, checkpoint) =>
    transformFinance(tenant, (state) => {
      const next = reconcile(state);
      editor.putFinance(tenant, changed, 0);
      return next;
    }, checkpoint));
  const worker = createWorker({ entrypoint: await syntheticParser(), budgetMs: 5000 });
  const stop = new AbortController();
  const processJob = worker.process.bind(worker);
  vi.spyOn(worker, "process").mockImplementation(async (job, signal) => {
    await processJob(job, signal);
    stop.abort();
  });
  try {
    await worker.run(stop.signal);
    expect(accounts.getFinance(userId).state?.seasonalTheme).toEqual(changed.seasonalTheme);
    expect(accounts.getFinance(userId).state?.transactions).toHaveLength(1);
    expect(accounts.getFinance(userId).revision).toBe(2);
    expect(store.snapshot(userId).jobs[0]).toMatchObject({ status: "COMPLETED", attempts: 1, errorCode: null });
  } finally {
    stop.abort();
    editor.close();
  }
}, 15_000);

it("marks a hanging upload timed out exactly once and commits the next queued upload", async () => {
  const hanging = await upload("hang.csv");
  const good = await upload();
  const stop = new AbortController();
  const pids: number[] = [];
  const worker = createWorker({
    entrypoint: await syntheticParser(), budgetMs: 3000,
    onSpawn: (pid) => pids.push(pid),
  });
  const processJob = worker.process.bind(worker);
  vi.spyOn(worker, "process").mockImplementation(async (job, signal) => {
    await processJob(job, signal);
    if (job.id === good) stop.abort();
  });
  const running = worker.run(stop.signal);
  try {
    await started(hanging);
    await running;
    expect(store.snapshot(userId).jobs.find((job) => job.id === hanging)).toMatchObject({
      status: "FAILED", attempts: 1, errorCode: "PARSE_TIMEOUT",
    });
    expect(store.snapshot(userId).jobs.find((job) => job.id === good)).toMatchObject({
      status: "COMPLETED", attempts: 0, cursor: 1,
      result: { uploadId: good, inserted: 1 },
    });
    expect(accounts.getFinance(userId).state?.transactions).toHaveLength(1);
    expect(accounts.getFinance(userId).revision).toBe(1);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    stop.abort();
    await running;
  }
});

it("cancels active parsing without financial half-state or consumed retry, then resumes once", async () => {
  const id = await upload("hang.csv");
  const stop = new AbortController();
  let pid = 0;
  const worker = createWorker({ entrypoint: await syntheticParser(), onSpawn: (value) => { pid = value; } });
  const running = worker.run(stop.signal);
  try {
    await started(id);
    stop.abort();
    await running;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(store.snapshot(userId).jobs[0]).toMatchObject({
      status: "QUEUED", attempts: 0, errorCode: "WORKER_ABORTED", result: null,
    });
    expect(accounts.getFinance(userId)).toEqual({ state: null, revision: 0 });
    expect(existsSync(store.filePath(id))).toBe(true);
    expect((await readdir(dirname(store.filePath(id)))).some((name) => name.startsWith(".parser-"))).toBe(false);
    expect(store.acquire("replacement")).toBe(true);
    const next = new AutomationWorker(store, "replacement", worker.index);
    await next.process(store.claim("replacement")!);
    expect(accounts.getFinance(userId).state?.transactions).toHaveLength(1);
    expect(store.snapshot(userId).jobs[0]).toMatchObject({ status: "COMPLETED", attempts: 0 });
  } finally {
    stop.abort();
    await running;
  }
});

it.each<AutomationErrorCode>([
  "PARSE_DAMAGED", "PARSE_ENCRYPTED", "PARSE_UNSUPPORTED", "PARSE_RESOURCE_LIMIT",
])("does not repeat permanent %s failures five times", async (code) => {
  const bad = await upload();
  const good = await upload();
  const stop = new AbortController();
  const worker = createWorker();
  const processJob = worker.process.bind(worker);
  vi.spyOn(worker, "process").mockImplementation(async (job, signal) => {
    if (job.id === bad) throw new ParserFailure(code, "private statement text");
    await processJob(job, signal);
    stop.abort();
  });
  await worker.run(stop.signal);
  expect(store.snapshot(userId).jobs.find((job) => job.id === bad)).toMatchObject({
    status: "FAILED", attempts: 1, errorCode: code,
    error: expect.not.stringContaining("private"),
  });
  expect(store.snapshot(userId).jobs.find((job) => job.id === good)?.status).toBe("COMPLETED");
});

it("never retries a committed transaction when upload cleanup fails", async () => {
  const id = await upload();
  const stop = new AbortController();
  const worker = createWorker();
  const failed = vi.spyOn(store, "fail");
  const processJob = worker.process.bind(worker);
  vi.spyOn(worker, "process").mockImplementation(async (job, signal) => {
    await processJob(job, signal);
    await unlink(store.filePath(id));
    await mkdir(store.filePath(id));
    stop.abort();
  });
  await worker.run(stop.signal);
  expect(failed).not.toHaveBeenCalled();
  expect(store.snapshot(userId).jobs[0]).toMatchObject({
    status: "COMPLETED", attempts: 0, cursor: 1,
  });
  expect(accounts.getFinance(userId).revision).toBe(1);
  expect(accounts.getFinance(userId).state?.transactions).toHaveLength(1);
});

it("kills active parsing when heartbeat fencing fails, leaving recovery to the new lease owner", async () => {
  const id = await upload("hang.csv");
  const stop = new AbortController();
  let pid = 0;
  const worker = createWorker({ entrypoint: await syntheticParser(), onSpawn: (value) => { pid = value; } });
  const interval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(
    ((callback: () => void) => interval(callback, 50)) as typeof setInterval,
  );
  const heartbeat = store.heartbeat.bind(store);
  vi.spyOn(store, "heartbeat").mockImplementation((leaseOwner) => {
    if (existsSync(`${store.filePath(id)}.started`))
      accounts.transaction((db) => db.prepare("UPDATE automation_worker SET expires_at = 0 WHERE owner = ?").run(leaseOwner));
    heartbeat(leaseOwner);
  });
  const running = worker.run(stop.signal).catch((error: unknown) => error);
  try {
    await started(id);
    expect(await running).toMatchObject({ message: "Worker lease lost" });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(accounts.getFinance(userId)).toEqual({ state: null, revision: 0 });
    expect(store.snapshot(userId).jobs[0]).toMatchObject({ status: "PROCESSING", attempts: 0 });
    expect(store.acquire("replacement")).toBe(true);
    expect(store.claim("replacement")).toBeNull();
    expect(store.snapshot(userId).jobs[0]).toMatchObject({
      status: "RETRYING", attempts: 1, errorCode: "WORKER_INTERRUPTED",
    });
  } finally {
    stop.abort();
    await running;
  }
});

it("runs bounded periodic retention with an empty queue and no file-cleanup candidates", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const first = randomUUID();
  const second = randomUUID();
  const insert = (id: string) => accounts.transaction((db) => db.prepare(
    `INSERT INTO automation_jobs
      (id, user_id, kind, name, status, bytes, available_at, updated_at, created_at)
      VALUES (?, ?, 'statement', 'synthetic.csv', 'COMPLETED', 0, ?, ?, ?)`,
  ).run(id, userId, now, now, now));
  insert(first);
  const worker = createWorker();
  const prune = vi.spyOn(store, "pruneCompletedStatements");
  expect(store.cleanupCandidates()).toEqual([]);
  await worker.cleanup();
  expect(prune).toHaveBeenCalledTimes(1);
  expect(store.snapshot(userId).jobs.map((item) => item.id)).toEqual([first]);
  vi.setSystemTime(now + IMPORT_RESULT_RETENTION_MS);
  await worker.cleanup();
  expect(prune).toHaveBeenCalledTimes(2);
  expect(store.snapshot(userId).jobs).toEqual([]);
  insert(second);
  vi.setSystemTime(now + IMPORT_RESULT_RETENTION_MS + 59_999);
  await worker.cleanup();
  expect(prune).toHaveBeenCalledTimes(2);
  expect(store.snapshot(userId).jobs.map((item) => item.id)).toEqual([second]);
  vi.setSystemTime(now + IMPORT_RESULT_RETENTION_MS + 60_000);
  await worker.cleanup();
  expect(prune).toHaveBeenCalledTimes(3);
  expect(store.snapshot(userId).jobs).toEqual([]);
  expect(accounts.getFinance(userId)).toEqual({ state: null, revision: 0 });
});

it("commits incomplete source repair drafts with UUID provenance but no inferred bookings", async () => {
  const bytes = Buffer.from(
    "Raiffeisen\nBuchungsdatum;Verwendungszweck/Text;Betrag\n;SPAR;-12,00\n2026-10-05;;-5,00",
  );
  const id = await upload("repair.csv", bytes);
  const worker = createWorker();
  expect(store.acquire(owner)).toBe(true);
  await worker.process(store.claim(owner)!);
  const state = accounts.getFinance(userId).state!;
  expect(state.transactions).toEqual([]);
  expect(state.reviewQueue).toHaveLength(2);
  expect(state.reviewQueue?.every((item) => item.kind === "booking" &&
    item.sourceRepair === true && item.importUploadId === id)).toBe(true);
  expect(state.reviewQueue).toEqual([
    expect.objectContaining({ draft: expect.objectContaining({ date: "", description: "SPAR" }) }),
    expect.objectContaining({ draft: expect.objectContaining({ date: "2026-10-05", description: "" }) }),
  ]);
  expect(store.snapshot(userId).jobs[0]).toMatchObject({
    status: "COMPLETED", result: { uploadId: id, status: "with-warnings", inserted: 0, review: 2, skipped: 0 },
  });
});

it("preserves foreign-currency reupload evidence without queuing an editable Euro repair", async () => {
  const bytes = Buffer.from(
    "Raiffeisen\nBuchungsdatum;Verwendungszweck/Text;Betrag;Währung\n2026-10-05;SPAR;-12,00;USD",
  );
  const id = await upload("foreign.csv", bytes);
  const worker = createWorker();
  expect(store.acquire(owner)).toBe(true);
  await worker.process(store.claim(owner)!);
  const state = accounts.getFinance(userId).state!;
  expect(state.transactions).toEqual([]);
  expect(state.reviewQueue ?? []).toEqual([]);
  expect(state.importResults?.[0].issues[0].reviewId).toBeUndefined();
  expect(state.importResults?.[0].issues[0].evidence).toContain("USD");
  expect(state.importResults?.[0].issues[0].evidence).toContain("-12");
  expect(store.snapshot(userId).jobs[0]).toMatchObject({
    status: "COMPLETED", result: {
      uploadId: id, inserted: 0, review: 0, skipped: 1,
      issues: [{ action: "reupload", reason: "foreign-currency" }],
    },
  });
});

it("commits a valid CSV row through the real parser child despite an oversized bad-row draft", async () => {
  const bytes = Buffer.from("Raiffeisen\nBuchungsdatum;Verwendungszweck/Text;Betrag\n2026-10-05;SPAR;-12,00\n2026-10-06;" +
    "X".repeat(1001) + ";-5,00");
  const id = await upload("oversized.csv", bytes);
  const worker = createWorker();
  expect(store.acquire(owner)).toBe(true);
  await worker.process(store.claim(owner)!);
  const state = accounts.getFinance(userId).state!;
  expect(state.transactions).toHaveLength(1);
  expect(state.transactions[0]).toMatchObject({ description: "SPAR", amount: -12 });
  expect(state.reviewQueue ?? []).toEqual([]);
  expect(accounts.getFinance(userId).revision).toBe(1);
  expect(store.snapshot(userId).jobs[0]).toMatchObject({
    status: "COMPLETED", attempts: 0, result: {
      uploadId: id, inserted: 1, review: 0, skipped: 1,
      issues: [{ action: "reupload", reason: "invalid-repair-draft" }],
    },
  });
});
