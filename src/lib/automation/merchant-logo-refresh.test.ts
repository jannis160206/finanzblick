import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { createTestDirectory } from "@/lib/server/test-support";
import { type PrivateMerchantLogo } from "./merchant-logo-metadata";
import { merchantSchema, type Merchant } from "./merchants";
import { AutomationStore } from "./store";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  retrieve: vi.fn(),
}));
vi.mock("./merchant-logo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./merchant-logo")>()),
  readPrivateMerchantLogo: mocks.read,
  retrieveMerchantLogo: mocks.retrieve,
}));
import { refreshMerchantLogos } from "./merchant-logo-refresh";

let directory: string;
let accounts: AccountDatabase;
let store: AutomationStore;
let network: ReturnType<typeof vi.fn<typeof fetch>>;
const logo: PrivateMerchantLogo = {
  file: `${"a".repeat(64)}.png`,
  license: "CC0-1.0",
  attribution: "Test-created geometric PNG; CC0-1.0",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Test-created-example.png",
};
function merchant(overrides: Partial<Merchant> = {}): Merchant {
  return merchantSchema.parse({
    id: "test-shop",
    canonicalName: "Example Market",
    aliases: ["Example Shop"],
    regexPatterns: [],
    defaultCategory: "Lebensmittel",
    region: "AT",
    source: "osm",
    wikidataId: "Q123",
    updatedAt: 100,
    ...overrides,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  directory = createTestDirectory();
  accounts = new AccountDatabase(join(directory, "refresh.sqlite"));
  store = new AutomationStore(accounts);
  mocks.read.mockResolvedValue(null);
  mocks.retrieve.mockResolvedValue({
    status: "skipped",
    reason: "No freely licensed logo",
  });
  network = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("Network forbidden"));
  vi.stubGlobal("fetch", network);
});

afterEach(async () => {
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  accounts.close();
  await rm(directory, { recursive: true, force: true });
});

describe("bounded, explicit merchant logo refresh", () => {
  it("reuses a validated cache by default and is idempotent without external calls or writes", async () => {
    store.upsertMerchants([merchant({ logo })]);
    mocks.read.mockResolvedValue(Buffer.from("validated test PNG"));
    const before = store.getMerchant("test-shop");
    const write = vi.spyOn(store, "updateMerchantLogo");
    const finance = vi.spyOn(accounts, "getFinance");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await refreshMerchantLogos(store)).toEqual({
        downloaded: 0,
        cached: 1,
        skipped: 0,
        updated: 0,
        remaining: 0,
        entities: [{ wikidataId: "Q123", status: "cached" }],
      });
    }
    expect(mocks.read).toHaveBeenCalledWith(accounts.path, logo);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(finance).not.toHaveBeenCalled();
    expect(store.getMerchant("test-shop")).toEqual(before);
  });

  it("deduplicates entities, retrieves once and selectively updates all references", async () => {
    store.upsertMerchants([
      merchant(),
      merchant({ id: "second-shop" }),
      merchant({ id: "no-entity", wikidataId: null }),
    ]);
    mocks.retrieve.mockResolvedValue({ status: "downloaded", logo });
    const before = store.loadMerchants();
    const report = await refreshMerchantLogos(store, { fetch: network });
    expect(report).toEqual({
      downloaded: 1,
      cached: 0,
      skipped: 0,
      updated: 2,
      remaining: 0,
      entities: [{ wikidataId: "Q123", status: "downloaded" }],
    });
    expect(mocks.retrieve).toHaveBeenCalledExactlyOnceWith(
      "Q123",
      accounts.path,
      {
        fetch: network,
        signal: expect.any(AbortSignal),
        retries: 2,
      },
    );
    for (const row of before) {
      const current = store.getMerchant(row.id)!;
      expect(current).toEqual(
        row.wikidataId ? { ...row, logo, updatedAt: current.updatedAt } : row,
      );
      if (row.wikidataId)
        expect(current.updatedAt).toBeGreaterThan(row.updatedAt);
    }
  });

  it("shares an existing validated entity cache with logo-less references without retrieval", async () => {
    store.upsertMerchants([
      merchant({ logo }),
      merchant({ id: "second-shop" }),
    ]);
    mocks.read.mockResolvedValue(Buffer.from("validated test PNG"));
    expect(await refreshMerchantLogos(store)).toMatchObject({
      downloaded: 0,
      cached: 1,
      skipped: 0,
      updated: 1,
      remaining: 0,
    });
    expect(store.getMerchant("second-shop")?.logo).toEqual(logo);
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("counts the bounded remaining entities rather than merchant rows and still reuses later caches", async () => {
    store.upsertMerchants([
      merchant({ id: "first", wikidataId: "Q1" }),
      merchant({ id: "second", wikidataId: "Q2" }),
      merchant({ id: "third", wikidataId: "Q3" }),
      merchant({ id: "third-duplicate", wikidataId: "Q3" }),
      merchant({ id: "cached-last", wikidataId: "Q4", logo }),
    ]);
    mocks.read.mockResolvedValue(Buffer.from("validated test PNG"));
    const report = await refreshMerchantLogos(store, { limit: 2 });
    expect(report).toEqual({
      downloaded: 0,
      cached: 1,
      skipped: 2,
      updated: 0,
      remaining: 1,
      entities: [
        {
          wikidataId: "Q1",
          status: "skipped",
          reason: "No freely licensed logo",
        },
        {
          wikidataId: "Q2",
          status: "skipped",
          reason: "No freely licensed logo",
        },
        { wikidataId: "Q4", status: "cached" },
      ],
    });
    expect(mocks.retrieve.mock.calls.map((call) => call[0])).toEqual([
      "Q1",
      "Q2",
    ]);
  });

  it("defaults to at most 20 entity retrievals per run", async () => {
    store.upsertMerchants(
      Array.from({ length: 21 }, (_, index) =>
        merchant({
          id: `shop-${index}`,
          wikidataId: `Q${index + 1}`,
        }),
      ),
    );
    expect(await refreshMerchantLogos(store)).toMatchObject({
      downloaded: 0,
      cached: 0,
      skipped: 20,
      updated: 0,
      remaining: 1,
    });
    expect(mocks.retrieve).toHaveBeenCalledTimes(20);
  });

  it.each([0, -1, 21, 1.5, NaN, Infinity])(
    "rejects invalid limits before loading the store: %s",
    async (limit) => {
      const load = vi.spyOn(store, "loadMerchants");
      await expect(refreshMerchantLogos(store, { limit })).rejects.toThrow();
      expect(load).not.toHaveBeenCalled();
      expect(mocks.retrieve).not.toHaveBeenCalled();
    },
  );

  it("fails closed on an oversized merchant index without retrieval", async () => {
    vi.spyOn(store, "loadMerchants").mockReturnValue(
      Array(10_001).fill(merchant()),
    );
    await expect(refreshMerchantLogos(store)).rejects.toThrow(/limit/i);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("preserves existing metadata on a default-mode skip even if its cached file is missing", async () => {
    store.upsertMerchants([merchant({ logo })]);
    const before = store.getMerchant("test-shop");
    const write = vi.spyOn(store, "updateMerchantLogo");
    expect(await refreshMerchantLogos(store)).toMatchObject({
      skipped: 1,
      downloaded: 0,
      updated: 0,
    });
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(store.getMerchant("test-shop")).toEqual(before);
  });

  it("clears an old logo after a skip only for explicit refresh", async () => {
    store.upsertMerchants([merchant({ logo })]);
    const before = store.getMerchant("test-shop")!;
    mocks.read.mockResolvedValue(Buffer.from("validated test PNG"));
    expect(await refreshMerchantLogos(store, { refresh: true })).toMatchObject({
      cached: 0,
      downloaded: 0,
      skipped: 1,
      updated: 1,
      remaining: 0,
    });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(store.getMerchant("test-shop")).toEqual({
      ...before,
      logo: null,
      updatedAt: expect.any(Number),
    });
    expect(store.getMerchant("test-shop")!.updatedAt).toBeGreaterThan(
      before.updatedAt,
    );
  });

  it.each([false, true])(
    "propagates network failures without success reports or cache metadata loss (refresh=%s)",
    async (refresh) => {
      store.upsertMerchants([merchant({ logo })]);
      const before = store.getMerchant("test-shop");
      const error = new Error("Synthetic network failure");
      mocks.retrieve.mockRejectedValue(error);
      const write = vi.spyOn(store, "updateMerchantLogo");
      await expect(refreshMerchantLogos(store, { refresh })).rejects.toBe(
        error,
      );
      expect(write).not.toHaveBeenCalled();
      expect(store.getMerchant("test-shop")).toEqual(before);
    },
  );

  it("propagates an optimistic write conflict and does not overwrite the concurrent reference", async () => {
    store.upsertMerchants([merchant()]);
    const concurrentLogo = { ...logo, file: `${"b".repeat(64)}.png` };
    mocks.retrieve.mockImplementation(async () => {
      store.upsertMerchants([
        merchant({
          aliases: ["Concurrent Alias"],
          logo: concurrentLogo,
          updatedAt: 101,
        }),
      ]);
      return { status: "downloaded", logo };
    });
    await expect(refreshMerchantLogos(store)).rejects.toThrow(
      /changed during logo refresh/i,
    );
    expect(store.getMerchant("test-shop")).toMatchObject({
      aliases: ["Concurrent Alias"],
      logo: concurrentLogo,
      updatedAt: 101,
    });
  });

  it("respects an already-aborted signal before file reads, retrieval or writes", async () => {
    store.upsertMerchants([merchant({ logo })]);
    const controller = new AbortController();
    const reason = new Error("Stop test refresh");
    controller.abort(reason);
    const write = vi.spyOn(store, "updateMerchantLogo");
    await expect(
      refreshMerchantLogos(store, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does nothing for merchants without public entity identities", async () => {
    store.upsertMerchants([merchant({ wikidataId: null })]);
    expect(await refreshMerchantLogos(store)).toEqual({
      downloaded: 0,
      cached: 0,
      skipped: 0,
      updated: 0,
      remaining: 0,
      entities: [],
    });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("retrieves only explicitly selected known entities and updates all their references", async () => {
    store.upsertMerchants([
      merchant({ id: "unselected", wikidataId: "Q1", logo }),
      merchant({ id: "selected", wikidataId: "Q2" }),
      merchant({ id: "selected-duplicate", wikidataId: "Q2" }),
      merchant({ id: "other-unselected", wikidataId: "Q3" }),
    ]);
    const before = store.loadMerchants();
    mocks.retrieve.mockResolvedValue({ status: "downloaded", logo });
    expect(await refreshMerchantLogos(store, { entities: ["Q2"] })).toEqual({
      downloaded: 1,
      cached: 0,
      skipped: 0,
      updated: 2,
      remaining: 0,
      entities: [{ wikidataId: "Q2", status: "downloaded" }],
    });
    expect(mocks.retrieve).toHaveBeenCalledExactlyOnceWith(
      "Q2",
      accounts.path,
      { fetch: undefined, signal: expect.any(AbortSignal), retries: 2 },
    );
    expect(mocks.read).not.toHaveBeenCalled();
    for (const row of before) {
      const current = store.getMerchant(row.id)!;
      expect(current).toEqual(
        row.wikidataId === "Q2"
          ? { ...row, logo, updatedAt: current.updatedAt }
          : row,
      );
    }
  });

  it("deduplicates repeated selected entity IDs without repeated retrievals or updates", async () => {
    store.upsertMerchants([merchant(), merchant({ id: "second-reference" })]);
    mocks.retrieve.mockResolvedValue({ status: "downloaded", logo });
    expect(
      await refreshMerchantLogos(store, {
        entities: ["Q123", "Q123", "Q123"],
      }),
    ).toEqual({
      downloaded: 1,
      cached: 0,
      skipped: 0,
      updated: 2,
      remaining: 0,
      entities: [{ wikidataId: "Q123", status: "downloaded" }],
    });
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown selected IDs before any cache read, retrieval or write, even alongside known IDs", async () => {
    store.upsertMerchants([merchant({ logo })]);
    const before = store.loadMerchants();
    const write = vi.spyOn(store, "updateMerchantLogo");
    for (const entities of [["Q999"], ["Q123", "Q999"]]) {
      await expect(refreshMerchantLogos(store, { entities })).rejects.toThrow(
        /not in the merchant table/i,
      );
    }
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(store.loadMerchants()).toEqual(before);
  });

  it.each(
    [
      [],
      ["Q0"],
      ["Q0123"],
      ["q123"],
      ["Q"],
      ["Qabc"],
      [" Q123"],
      ["Q123 "],
      ["Q123\n"],
      ["https://www.wikidata.org/wiki/Q123"],
      ["Q123; DELETE FROM merchants"],
      [`Q${"1".repeat(15)}`],
      ["Q123", 123],
      Array(21).fill("Q123"),
    ].map((entities) => ({ entities })),
  )(
    "rejects empty, invalid or oversized entity selections before store access: $entities",
    async ({ entities }) => {
      const load = vi.spyOn(store, "loadMerchants");
      await expect(
        refreshMerchantLogos(store, {
          entities: entities as string[],
        }),
      ).rejects.toThrow();
      expect(load).not.toHaveBeenCalled();
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.retrieve).not.toHaveBeenCalled();
    },
  );

  it("accepts exactly 20 selected known entities", async () => {
    const entities = Array.from({ length: 20 }, (_, index) => `Q${index + 1}`);
    store.upsertMerchants(
      entities.map((wikidataId) =>
        merchant({ id: `shop-${wikidataId}`, wikidataId }),
      ),
    );
    expect(await refreshMerchantLogos(store, { entities })).toMatchObject({
      downloaded: 0,
      cached: 0,
      skipped: 20,
      updated: 0,
      remaining: 0,
    });
    expect(mocks.retrieve.mock.calls.map((call) => call[0])).toEqual(entities);
  });

  it("counts only selected entities against request and remaining limits", async () => {
    store.upsertMerchants([
      merchant({ id: "not-selected-first", wikidataId: "Q1" }),
      merchant({ id: "selected-first", wikidataId: "Q2" }),
      merchant({ id: "not-selected-middle", wikidataId: "Q3" }),
      merchant({ id: "selected-second", wikidataId: "Q4" }),
      merchant({ id: "selected-second-duplicate", wikidataId: "Q4" }),
      merchant({ id: "not-selected-last", wikidataId: "Q5" }),
    ]);
    expect(
      await refreshMerchantLogos(store, { entities: ["Q2", "Q4"], limit: 1 }),
    ).toEqual({
      downloaded: 0,
      cached: 0,
      skipped: 1,
      updated: 0,
      remaining: 1,
      entities: [
        {
          wikidataId: "Q2",
          status: "skipped",
          reason: "No freely licensed logo",
        },
      ],
    });
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    expect(mocks.retrieve.mock.calls[0][0]).toBe("Q2");
  });

  it("reads and reuses only the selected entity cache without external retrievals", async () => {
    const otherLogo = { ...logo, file: `${"b".repeat(64)}.png` };
    store.upsertMerchants([
      merchant({ id: "unselected", wikidataId: "Q1", logo: otherLogo }),
      merchant({ id: "selected", wikidataId: "Q2", logo }),
    ]);
    const before = store.loadMerchants();
    mocks.read.mockResolvedValue(Buffer.from("validated test PNG"));
    expect(await refreshMerchantLogos(store, { entities: ["Q2"] })).toEqual({
      downloaded: 0,
      cached: 1,
      skipped: 0,
      updated: 0,
      remaining: 0,
      entities: [{ wikidataId: "Q2", status: "cached" }],
    });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(accounts.path, logo);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(store.loadMerchants()).toEqual(before);
  });

  it("clears only selected old logos on an explicit refresh skip", async () => {
    store.upsertMerchants([
      merchant({ id: "unselected", wikidataId: "Q1", logo }),
      merchant({ id: "selected", wikidataId: "Q2", logo }),
    ]);
    const unselected = store.getMerchant("unselected");
    expect(
      await refreshMerchantLogos(store, { entities: ["Q2"], refresh: true }),
    ).toMatchObject({
      skipped: 1,
      cached: 0,
      downloaded: 0,
      updated: 1,
      remaining: 0,
    });
    expect(store.getMerchant("unselected")).toEqual(unselected);
    expect(store.getMerchant("selected")?.logo).toBeNull();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    expect(mocks.retrieve.mock.calls[0][0]).toBe("Q2");
  });
});
