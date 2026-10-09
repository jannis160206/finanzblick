import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AutomationStore } from "./store";
import { merchantSchema } from "./merchants";
const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("./merchant-logo-refresh", () => ({
  refreshMerchantLogos: mocks.refresh,
}));
import { refreshMerchantLogoBatches } from "./merchant-logo-batches";
import { AccountDatabase } from "@/lib/server/database";
import { AutomationStore as Store } from "./store";
import { createTestDirectory } from "@/lib/server/test-support";
import { join } from "node:path";
import { rmSync } from "node:fs";
const merchant = (qid: string, id = qid) =>
  merchantSchema.parse({
    id,
    canonicalName: "Test Brand",
    region: "AT",
    source: "local",
    aliases: [],
    regexPatterns: [],
    defaultCategory: "Shopping",
    updatedAt: 1,
    wikidataId: qid,
  });
let db: AccountDatabase;
let store: AutomationStore;
let directory: string;
beforeEach(() => {
  vi.resetAllMocks();
  directory = createTestDirectory();
  db = new AccountDatabase(join(directory, "batches.sqlite"));
  store = new Store(db);
  mocks.refresh.mockImplementation(async (_store, options) => ({
    downloaded: 0,
    cached: 0,
    skipped: options.entities.length,
    updated: 0,
    remaining: 0,
    entities: options.entities.map((wikidataId: string) => ({
      wikidataId,
      status: "skipped",
    })),
  }));
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
it("visits all known entities once in sequential bounded groups, not just the first missing logos", async () => {
  store.upsertMerchants(
    Array.from({ length: 43 }, (_, index) => merchant(`Q${index + 1}`)),
  );
  store.upsertMerchants([merchant("Q1", "duplicate")]);
  const progress = vi.fn();
  const report = await refreshMerchantLogoBatches(store, { onBatch: progress });
  expect(mocks.refresh).toHaveBeenCalledTimes(3);
  const groups = mocks.refresh.mock.calls.map(
    (call) => call[1].entities as string[],
  );
  expect(groups.map((group) => group.length)).toEqual([20, 20, 3]);
  expect(new Set(groups.flat()).size).toBe(43);
  expect(report).toMatchObject({
    processed: 43,
    skipped: 43,
    remaining: 0,
    nextAfter: null,
  });
  expect(progress).toHaveBeenCalledTimes(3);
  expect(progress.mock.calls[2][0]).toMatchObject({
    processed: 43,
    remaining: 0,
  });
});
it("caps a run at 200 public entities and resumes after the supplied cursor", async () => {
  store.upsertMerchants(
    Array.from({ length: 205 }, (_, index) => merchant(`Q${index + 1}`)),
  );
  const first = await refreshMerchantLogoBatches(store);
  expect(first).toMatchObject({ processed: 200, remaining: 5 });
  expect(first.nextAfter).toMatch(/^Q/);
  const visited = new Set(
    mocks.refresh.mock.calls.flatMap((call) => call[1].entities),
  );
  mocks.refresh.mockClear();
  const second = await refreshMerchantLogoBatches(store, {
    after: first.nextAfter!,
  });
  expect(second).toMatchObject({ processed: 5, remaining: 0, nextAfter: null });
  expect(
    mocks.refresh.mock.calls
      .flatMap((call) => call[1].entities)
      .every((id) => !visited.has(id)),
  ).toBe(true);
});
it("propagates source failure without issuing later batches or success-shaped progress", async () => {
  store.upsertMerchants([merchant("Q1"), merchant("Q2"), merchant("Q3")]);
  mocks.refresh.mockRejectedValueOnce(new Error("HTTP 429"));
  const progress = vi.fn();
  await expect(
    refreshMerchantLogoBatches(store, { batchSize: 1, onBatch: progress }),
  ).rejects.toThrow("HTTP 429");
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(progress).not.toHaveBeenCalled();
});
it.each([0, 21, Number.NaN])(
  "rejects an invalid batch size before reading the catalog: %s",
  async (batchSize) => {
    const read = vi.spyOn(store, "loadMerchants");
    await expect(
      refreshMerchantLogoBatches(store, { batchSize }),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  },
);
it("rejects arbitrary cursor text and an already-aborted run without any network lookup", async () => {
  await expect(
    refreshMerchantLogoBatches(store, { after: "private-text" }),
  ).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(
    refreshMerchantLogoBatches(store, { signal: controller.signal }),
  ).rejects.toThrow();
  expect(mocks.refresh).not.toHaveBeenCalled();
});
