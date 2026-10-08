import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import { transactionSchema } from "@/lib/types";
import { MerchantIndex, seedMerchants } from "./merchants";
import { AutomationStore } from "./store";
import { AutomationWorker } from "./worker";
import {
  BACKFILL_BATCH,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_QUEUE_BYTES,
  MERCHANT_BACKFILL_VERSION,
} from "./schema";

let directory: string;
let accounts: AccountDatabase;
let store: AutomationStore;
let worker: AutomationWorker;
let userId: string;
const owner = "test-worker";
beforeEach(async () => {
  directory = createTestDirectory();
  accounts = new AccountDatabase(join(directory, "worker.sqlite"));
  store = new AutomationStore(accounts);
  userId = (await accounts.register("alice", "test-only-password-123")).user.id;
  store.upsertMerchants(seedMerchants);
  worker = new AutomationWorker(
    store,
    owner,
    new MerchantIndex(store.loadMerchants()),
  );
  expect(store.acquire(owner)).toBe(true);
});
afterEach(() => {
  vi.useRealTimers();
  accounts.close();
  rmSync(directory, { recursive: true, force: true });
});

async function upload(text: string, tenant = userId) {
  const id = randomUUID();
  const bytes = Buffer.from(text);
  store.reserveUpload(tenant, id, "statement.csv", bytes.length);
  await mkdir(dirname(store.filePath(id)), { recursive: true });
  await writeFile(store.filePath(id), bytes);
  store.readyUpload(tenant, id);
  return id;
}
const csv =
  'American Express\nDatum,Beschreibung,Karteninhaber,Kartennummer,Betrag\n08.10.2026,BILLA FILIALE 4711,Test User,XXXX-1001,"42,00"';

it("imports atomically and idempotently, keeps original facts and isolates tenants", async () => {
  const bob = (await accounts.register("bob", "test-only-password-123")).user
    .id;
  await upload(csv);
  await worker.process(store.claim(owner)!);
  const first = accounts.getFinance(userId);
  expect(first.state?.transactions).toHaveLength(1);
  expect(first.state?.transactions[0]).toMatchObject({
    merchantAlias: "BILLA",
    category: "Lebensmittel",
    amount: -42,
    requires_manual_review: false,
  });
  expect(first.state?.transactions[0].description).toContain("4711");
  expect(store.snapshot(userId).jobs[0].status).toBe("COMPLETED");
  expect(store.snapshot(bob).jobs).toEqual([]);
  expect(accounts.getFinance(bob).state).toBeNull();
  await upload(csv);
  await worker.process(store.claim(owner)!);
  expect(accounts.getFinance(userId).state?.transactions).toHaveLength(1);
  await worker.cleanup();
  expect(
    accounts.read(
      (db) =>
        db.prepare("SELECT sum(bytes) AS bytes FROM automation_jobs").get()
          ?.bytes,
    ),
  ).toBe(0);
});

it("rolls back finance writes and checkpoints together when commit fails", () => {
  const job = store.enqueueBackfill(userId);
  const claimed = store.claim(owner)!;
  expect(() =>
    accounts.transformFinance(
      userId,
      () => blankTestState(),
      (db) => {
        store.checkpoint(db, owner, claimed, 0, true);
        throw new Error("Simulated crash before commit");
      },
    ),
  ).toThrow("Simulated crash");
  expect(accounts.getFinance(userId)).toEqual({ state: null, revision: 0 });
  expect(
    store.snapshot(userId).jobs.find((item) => item.id === job.id)?.status,
  ).toBe("PROCESSING");
});

it("uses persisted exponential backoff and a bounded retry budget", async () => {
  vi.useFakeTimers();
  await upload(csv);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const claimed = store.claim(owner)!;
    expect(claimed).not.toBeNull();
    store.fail(owner, claimed, "Test failure");
    const job = store.snapshot(userId).jobs[0];
    expect(job.attempts).toBe(attempt);
    expect(job.status).toBe(attempt === MAX_ATTEMPTS ? "FAILED" : "RETRYING");
    expect(store.claim(owner)).toBeNull();
    vi.setSystemTime(Date.now() + 1000 * 2 ** (attempt - 1));
    store.heartbeat(owner);
  }
});

it("fences a second worker and recovers an interrupted job after lease expiry", async () => {
  vi.useFakeTimers();
  await upload(csv);
  const claimed = store.claim(owner)!;
  expect(store.acquire("second-worker")).toBe(false);
  accounts.close();
  accounts = new AccountDatabase(join(directory, "worker.sqlite"));
  store = new AutomationStore(accounts);
  vi.setSystemTime(Date.now() + LEASE_MS + 1);
  expect(store.acquire("second-worker")).toBe(true);
  expect(store.claim("second-worker")).toBeNull();
  expect(store.snapshot(userId).jobs[0]).toMatchObject({
    status: "RETRYING",
    attempts: 1,
  });
  expect(() => store.progress(owner, claimed, 50)).toThrow("lease lost");
  vi.setSystemTime(Date.now() + 1000);
  expect(store.claim("second-worker")?.id).toBe(claimed.id);
});

it("does not reset the retry budget when a running worker expires its own lease", async () => {
  vi.useFakeTimers();
  await upload(csv);
  vi.spyOn(worker, "process").mockImplementation(async () => {
    vi.setSystemTime(Date.now() + LEASE_MS + 1);
    throw new Error("Stalled processor");
  });
  await expect(worker.run(new AbortController().signal)).rejects.toThrow(
    "lease lost",
  );
  expect(store.snapshot(userId).jobs[0]).toMatchObject({
    status: "PROCESSING",
    attempts: 0,
  });
  store.acquire("replacement");
  store.claim("replacement");
  expect(store.snapshot(userId).jobs[0]).toMatchObject({
    status: "RETRYING",
    attempts: 1,
  });
});

it("backfills receipt-only historical bookings without creating duplicate ledger rows", async () => {
  const row = transactionSchema.parse({
    id: "receipt-only",
    date: "2026-10-08",
    bank: "Amex",
    pocket: "Amex",
    description: "Müller",
    amount: -42,
    category: "Prüfen",
    includeInPlan: false,
  });
  accounts.putFinance(
    userId,
    {
      ...blankTestState(),
      transactions: [],
      fixedReceipts: [
        {
          key: "receipt-only",
          date: row.date,
          category: row.category,
          amount: row.amount,
          booking: row,
        },
      ],
    },
    0,
  );
  expect(store.enqueueBackfill(userId).total).toBe(1);
  await worker.process(store.claim(owner)!);
  const state = accounts.getFinance(userId).state!;
  expect(state.transactions).toEqual([]);
  expect(state.fixedReceipts?.[0]).toMatchObject({
    category: "Drogerie",
    booking: { merchantAlias: "Müller", requires_manual_review: false },
  });
});

it("resumes a 200-row backfill by stable IDs after reopening and never changes locked edits", async () => {
  const rows = Array.from({ length: BACKFILL_BATCH + 3 }, (_, i) =>
    transactionSchema.parse({
      id: String(i),
      date: "2026-10-08",
      bank: "Amex",
      pocket: "Amex",
      description: "BILLA 4711",
      amount: -42,
      category: "Prüfen",
      includeInPlan: true,
      ...(i === 0
        ? {
            description: "Privater Laden",
            category: "Shopping",
            merchantAlias: "Mein Laden",
            manualCategory: true,
          }
        : {}),
    }),
  );
  accounts.putFinance(userId, { ...blankTestState(), transactions: rows }, 0);
  const job = store.enqueueBackfill(userId);
  expect(store.enqueueBackfill(userId).id).toBe(job.id);
  await worker.process(store.claim(owner)!);
  expect(store.snapshot(userId).jobs[0]).toMatchObject({
    cursor: 200,
    status: "QUEUED",
    total: 203,
  });
  store.release(owner);
  accounts.close();
  accounts = new AccountDatabase(join(directory, "worker.sqlite"));
  store = new AutomationStore(accounts);
  store.acquire(owner);
  worker = new AutomationWorker(
    store,
    owner,
    new MerchantIndex(store.loadMerchants()),
  );
  // Removing an already visited row must not shift the cursor past an unvisited row.
  const snapshot = accounts.getFinance(userId);
  accounts.putFinance(
    userId,
    {
      ...snapshot.state!,
      transactions: snapshot.state!.transactions.filter(
        (row) => row.id !== "1",
      ),
    },
    snapshot.revision,
  );
  await worker.process(store.claim(owner)!);
  const final = accounts.getFinance(userId).state!;
  expect(final.transactions[0]).toMatchObject({
    category: "Shopping",
    merchantAlias: "Mein Laden",
    is_locked: true,
  });
  expect(
    final.transactions
      .filter((row) => row.id !== "0")
      .every((row) => row.merchantAlias === "BILLA"),
  ).toBe(true);
  expect(store.snapshot(userId).jobs[0]).toMatchObject({
    status: "COMPLETED",
    cursor: 203,
  });
  expect(store.enqueueBackfill(userId).id).toBe(job.id);
  expect(store.claim(owner)).toBeNull();
});

it.each(["COMPLETED", "FAILED"] as const)(
  "explicitly reruns a %s backfill with a fresh snapshot and protected manual choices",
  async (status) => {
    const row = transactionSchema.parse({
      id: "locked",
      date: "2026-10-08",
      bank: "Amex",
      pocket: "Amex",
      description: "BILLA",
      amount: -42,
      category: "Shopping",
      merchantAlias: "Mein Laden",
      manualCategory: true,
      includeInPlan: true,
    });
    accounts.putFinance(
      userId,
      { ...blankTestState(), transactions: [row] },
      0,
    );
    const job = store.enqueueBackfill(userId);
    await worker.process(store.claim(owner)!);
    accounts.transaction((db) => {
      db.prepare(
        "UPDATE automation_jobs SET status = ?, attempts = 5, error = 'Test failure' WHERE id = ?",
      ).run(status, job.id);
    });
    const before = accounts.getFinance(userId);
    const added = transactionSchema.parse({
      ...row,
      id: "added",
      description: "PENNY FILIALE 4711",
      category: "Prüfen",
      merchantAlias: undefined,
      manualCategory: false,
      is_locked: false,
    });
    accounts.putFinance(
      userId,
      {
        ...before.state!,
        transactions: [...before.state!.transactions, added],
        fixedReceipts: [
          {
            key: "duplicate",
            date: added.date,
            amount: added.amount,
            category: added.category,
            booking: added,
          },
          {
            key: "receipt",
            date: added.date,
            amount: added.amount,
            category: added.category,
            booking: { ...added, id: "receipt-only", description: "Müller" },
          },
        ],
      },
      before.revision,
    );
    expect(store.enqueueBackfill(userId)).toMatchObject({
      id: job.id,
      status,
      total: 1,
    });
    const now = Date.now() + 1;
    expect(store.enqueueAllBackfills({ rerun: true })).toBe(1);
    const reset = store.snapshot(userId).jobs[0];
    expect(reset).toMatchObject({
      id: job.id,
      status: "QUEUED",
      progress: 0,
      attempts: 0,
      cursor: 0,
      total: 3,
      error: null,
    });
    expect(store.enqueueBackfill(userId, now, { rerun: true })).toEqual(reset);
    await worker.process(store.claim(owner)!);
    const final = accounts.getFinance(userId).state!;
    expect(final.transactions).toHaveLength(2);
    expect(final.transactions[0]).toEqual(before.state!.transactions[0]);
    expect(final.transactions[1]).toMatchObject({
      merchantAlias: "PENNY",
      category: "Lebensmittel",
    });
    expect(final.fixedReceipts?.[1].booking).toMatchObject({
      merchantAlias: "Müller",
      category: "Drogerie",
    });
    expect(store.snapshot(userId).jobs[0]).toMatchObject({
      status: "COMPLETED",
      cursor: 3,
      total: 3,
      progress: 100,
    });
  },
);

it("does not reset a running backfill or its frozen IDs when a repeat is requested", async () => {
  const row = transactionSchema.parse({
    id: "original",
    date: "2026-10-08",
    bank: "Amex",
    pocket: "Amex",
    description: "BILLA",
    amount: -42,
    category: "Prüfen",
    includeInPlan: true,
  });
  accounts.putFinance(userId, { ...blankTestState(), transactions: [row] }, 0);
  const job = store.enqueueBackfill(userId);
  const claimed = store.claim(owner)!;
  const snapshot = accounts.getFinance(userId);
  accounts.putFinance(
    userId,
    { ...snapshot.state!, transactions: [row, { ...row, id: "later" }] },
    snapshot.revision,
  );
  expect(
    store.enqueueBackfill(userId, Date.now(), { rerun: true }),
  ).toMatchObject({
    id: job.id,
    status: "PROCESSING",
    total: 1,
    cursor: 0,
  });
  await worker.process(claimed);
  expect(
    accounts.getFinance(userId).state!.transactions[1].merchantAlias,
  ).toBeUndefined();
});

it("rolls back both the terminal job reset and frozen ID replacement on failure", () => {
  const row = transactionSchema.parse({
    id: "original",
    date: "2026-10-08",
    bank: "Amex",
    pocket: "Amex",
    description: "BILLA",
    amount: -42,
    category: "Prüfen",
    includeInPlan: true,
  });
  accounts.putFinance(userId, { ...blankTestState(), transactions: [row] }, 0);
  const job = store.enqueueBackfill(userId);
  accounts.transaction((db) =>
    db
      .prepare("UPDATE automation_jobs SET attempts = ? WHERE id = ?")
      .run(MAX_ATTEMPTS - 1, job.id),
  );
  store.fail(owner, store.claim(owner)!, "Test failure");
  const terminal = store.snapshot(userId).jobs[0];
  expect(terminal.status).toBe("FAILED");
  const snapshot = accounts.getFinance(userId);
  accounts.putFinance(
    userId,
    { ...snapshot.state!, transactions: [{ ...row, id: "replacement" }] },
    snapshot.revision,
  );
  accounts.transaction((db) =>
    db.exec(`
    CREATE TRIGGER reject_backfill_reset BEFORE UPDATE OF total ON automation_jobs
    WHEN OLD.status = 'QUEUED'
    BEGIN SELECT RAISE(ABORT, 'Simulated reset failure'); END;
  `),
  );
  expect(() =>
    store.enqueueBackfill(userId, Date.now(), { rerun: true }),
  ).toThrow("Simulated reset failure");
  expect(store.snapshot(userId).jobs[0]).toEqual(terminal);
  const ids = accounts.read((db) =>
    db
      .prepare(
        "SELECT transaction_id FROM automation_backfill_items WHERE job_id = ?",
      )
      .all(job.id),
  );
  expect(ids).toEqual([{ transaction_id: "original" }]);
  expect(store.enqueueBackfill(userId).id).toBe(job.id);
});

it("enforces bounded queued storage, active jobs and idempotent merchant upserts", () => {
  expect(store.loadMerchants()).toEqual(expect.arrayContaining(seedMerchants));
  store.upsertMerchants(seedMerchants);
  expect(store.loadMerchants()).toHaveLength(seedMerchants.length);
  for (let i = 0; i < 5; i++)
    store.reserveUpload(userId, randomUUID(), "test.csv", 1);
  expect(() =>
    store.reserveUpload(userId, randomUUID(), "test.csv", 1),
  ).toThrow("fünf");
  accounts.transaction((db) =>
    db
      .prepare("UPDATE automation_jobs SET status = 'FAILED', bytes = ?")
      .run(MAX_QUEUE_BYTES),
  );
  expect(() =>
    store.reserveUpload(userId, randomUUID(), "test.csv", 1),
  ).toThrow("voll");
});

it("runs the upgraded merchant backfill once per tenant and never resets its durable cursor", async () => {
  const bob = (await accounts.register("bob", "test-only-password-123")).user
    .id;
  const row = transactionSchema.parse({
    id: "original",
    date: "2026-10-08",
    bank: "Amex",
    pocket: "Amex",
    description: "BILLA",
    amount: -42,
    category: "Prüfen",
    includeInPlan: true,
  });
  accounts.putFinance(userId, { ...blankTestState(), transactions: [row] }, 0);
  const original = store.enqueueBackfill(userId);
  await worker.process(store.claim(owner)!);
  const snapshot = accounts.getFinance(userId);
  accounts.putFinance(
    userId,
    {
      ...snapshot.state!,
      transactions: [
        ...snapshot.state!.transactions,
        ...Array.from({ length: 202 }, (_, index) => ({
          ...row,
          id: `added-${index}`,
        })),
      ],
    },
    snapshot.revision,
  );
  const options = { onceVersion: MERCHANT_BACKFILL_VERSION };
  expect(store.enqueueBackfill(userId, Date.now(), options)).toMatchObject({
    id: original.id,
    status: "QUEUED",
    cursor: 0,
    total: 203,
  });
  await worker.process(store.claim(owner)!);
  expect(store.enqueueBackfill(userId, Date.now(), options)).toMatchObject({
    status: "QUEUED",
    cursor: 200,
    total: 203,
  });
  expect(store.snapshot(bob).jobs).toEqual([]);
  await worker.process(store.claim(owner)!);
  const completed = store.snapshot(userId).jobs[0];
  const revision = accounts.getFinance(userId).revision;
  expect(completed).toMatchObject({
    status: "COMPLETED",
    cursor: 203,
    progress: 100,
  });
  expect(store.enqueueBackfill(userId, Date.now(), options)).toEqual(completed);
  expect(() => store.enqueueBackfill(userId, Date.now(), { rerun: true })).toThrow("nicht zurückgesetzt");
  expect(store.claim(owner)).toBeNull();
  expect(accounts.getFinance(userId).revision).toBe(revision);
  expect(accounts.getFinance(userId).state!.transactions).toHaveLength(203);
  expect(
    accounts.read(
      (db) =>
        db
          .prepare(
            "SELECT completed_at FROM automation_backfill_passes WHERE user_id = ? AND version = ?",
          )
          .get(userId, MERCHANT_BACKFILL_VERSION)?.completed_at,
    ),
  ).toEqual(expect.any(Number));
  accounts.putFinance(
    bob,
    { ...blankTestState(), transactions: [{ ...row, id: "bob-row" }] },
    0,
  );
  expect(store.enqueueBackfill(bob, Date.now(), options).total).toBe(1);
});

it("does not replace an unrelated active backfill or retry a failed once-only pass on restart", () => {
  store.enqueueBackfill(userId);
  expect(() =>
    store.enqueueBackfill(userId, Date.now(), {
      onceVersion: MERCHANT_BACKFILL_VERSION,
    }),
  ).toThrow("bisherige Backfill läuft");
  const claimed = store.claim(owner)!;
  accounts.transformFinance(
    userId,
    () => blankTestState(),
    (db) => store.checkpoint(db, owner, claimed, 0, true),
  );
  store.enqueueBackfill(userId, Date.now(), {
    onceVersion: MERCHANT_BACKFILL_VERSION,
  });
  accounts.transaction((db) =>
    db
      .prepare("UPDATE automation_jobs SET attempts = ? WHERE id = ?")
      .run(MAX_ATTEMPTS - 1, claimed.id),
  );
  store.fail(owner, store.claim(owner)!, "Test failure");
  expect(
    store.enqueueBackfill(userId, Date.now(), {
      onceVersion: MERCHANT_BACKFILL_VERSION,
    }),
  ).toMatchObject({
    status: "FAILED",
    attempts: MAX_ATTEMPTS,
  });
  expect(() => store.enqueueBackfill(userId, Date.now(), { rerun: true })).toThrow("nicht zurückgesetzt");
  expect(() =>
    store.enqueueBackfill(userId, Date.now(), {
      onceVersion: MERCHANT_BACKFILL_VERSION,
      rerun: true,
    }),
  ).toThrow("nicht zurückgesetzt");
});
