import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  parseArgs: vi.fn(),
  config: vi.fn(),
  close: vi.fn(),
  load: vi.fn(),
  upsert: vi.fn(),
  import: vi.fn(),
  bbox: vi.fn(),
  refresh: vi.fn(),
  batches: vi.fn(),
}));
vi.mock("node:util", async (original) => ({
  ...(await original<typeof import("node:util")>()),
  parseArgs: mocks.parseArgs,
}));
vi.mock("@/lib/server/config", () => ({ readAccountConfig: mocks.config }));
vi.mock("@/lib/server/database", () => ({
  AccountDatabase: class {
    path = "private.sqlite";
    close = mocks.close;
  },
}));
vi.mock("@/lib/automation/store", () => ({
  AutomationStore: class {
    loadMerchants = mocks.load;
    upsertMerchants = mocks.upsert;
  },
}));
vi.mock("./merchant-import", () => ({
  MAX_IMPORTED_MERCHANTS: 10_000,
  importOsmMerchants: mocks.import,
  parseMerchantBbox: mocks.bbox,
}));
vi.mock("./merchant-logo-refresh", () => ({
  refreshMerchantLogos: mocks.refresh,
}));
vi.mock("./merchant-logo-batches", () => ({
  refreshMerchantLogoBatches: mocks.batches,
}));
import { merchantSchema, seedMerchants } from "./merchants";
const item = (id = "osm-node-1") =>
  merchantSchema.parse({
    id,
    canonicalName: "Nordlicht Laden",
    aliases: [],
    regexPatterns: [],
    defaultCategory: "Shopping",
    region: "AT",
    source: "osm",
    updatedAt: 1,
  });
const cachedLogo = {
  file: `${"a".repeat(64)}.png`,
  license: "CC0-1.0" as const,
  attribution: "Test artist",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Test.png",
};

const run = () => import("../../../scripts/merchant-import");
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.parseArgs.mockReturnValue({
    values: { bbox: "48.18,16.33,48.22,16.39", logos: false },
  });
  mocks.bbox.mockReturnValue([48.18, 16.33, 48.22, 16.39]);
  mocks.config.mockReturnValue({ databasePath: "private.sqlite" });
  mocks.load.mockReturnValue([]);
  mocks.import.mockResolvedValue({
    merchants: [item()],
    report: { imported: 1, skipped: [], logos: [] },
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("operator merchant import CLI", () => {
  it("scans all public catalog logo entities in bounded batches without geography or financial input", async () => {
    mocks.parseArgs.mockReturnValue({
      values: { "all-logos": true, limit: "10", after: "Q123", refresh: true },
    });
    mocks.batches.mockResolvedValue({ processed: 30, remaining: 0 });
    await run();
    expect(mocks.batches).toHaveBeenCalledWith(expect.anything(), {
      batchSize: 10,
      after: "Q123",
      refresh: true,
      onBatch: expect.any(Function),
    });
    expect(mocks.import).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it("rejects incompatible all-logo and geographic modes before database access", async () => {
    mocks.parseArgs.mockReturnValue({
      values: { "all-logos": true, bbox: "48,16,48.1,16.1" },
    });
    await expect(run()).rejects.toThrow("--all-logos");
    expect(mocks.config).not.toHaveBeenCalled();
  });
  it("refreshes catalog logos without a geography request", async () => {
    mocks.parseArgs.mockReturnValue({
      values: { "logos-only": true, limit: "3", refresh: true },
    });
    mocks.refresh.mockResolvedValue({ downloaded: 2 });
    await run();
    expect(mocks.refresh).toHaveBeenCalledWith(expect.anything(), {
      limit: 3,
      refresh: true,
    });
    expect(mocks.import).not.toHaveBeenCalled();
    expect(mocks.bbox).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it("rejects contradictory modes before opening a database", async () => {
    mocks.parseArgs.mockReturnValue({
      values: { bbox: "48,16,48.1,16.1", "logos-only": true },
    });
    await expect(run()).rejects.toThrow("either");
    expect(mocks.config).not.toHaveBeenCalled();
  });
  it("requires an explicit bbox before touching the database or network", async () => {
    mocks.parseArgs.mockReturnValue({ values: { logos: false } });
    await expect(run()).rejects.toThrow("Required");
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.import).not.toHaveBeenCalled();
  });

  it("upserts existing seeds, imports reference records and reports explicitly", async () => {
    await run();
    expect(mocks.upsert).toHaveBeenNthCalledWith(1, seedMerchants);
    expect(mocks.upsert).toHaveBeenNthCalledWith(2, [item()], {
      replaceLogos: false,
    });
    expect(mocks.import).toHaveBeenCalledWith({
      bbox: [48.18, 16.33, 48.22, 16.39],
      databasePath: "private.sqlite",
      logos: false,
    });
    expect(console.info).toHaveBeenCalledWith(
      JSON.stringify({ imported: 1, skipped: [], logos: [] }, null, 2),
    );
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("keeps previously licensed cached logos on a geography-only update", async () => {
    const logo = cachedLogo;
    mocks.load.mockReturnValue([{ ...item(), logo }]);
    await run();
    expect(mocks.upsert).toHaveBeenLastCalledWith([{ ...item(), logo }], {
      replaceLogos: false,
    });
  });

  it.each([false, true])(
    "never removes a stricter purchase-purpose guard during geographic refresh (logos=%s)",
    async (logos) => {
      mocks.parseArgs.mockReturnValue({
        values: { bbox: "48.18,16.33,48.22,16.39", logos },
      });
      mocks.load.mockReturnValue([
        { ...item(), requiresCategoryEvidence: true },
      ]);
      await run();
      expect(mocks.upsert).toHaveBeenLastCalledWith(
        [{ ...item(), requiresCategoryEvidence: true }],
        { replaceLogos: logos },
      );
    },
  );

  it("does not retain an older logo when an explicit logo refresh skipped it", async () => {
    mocks.parseArgs.mockReturnValue({
      values: { bbox: "48.18,16.33,48.22,16.39", logos: true },
    });
    mocks.load.mockReturnValue([{ ...item(), logo: cachedLogo }]);
    await run();
    expect(mocks.upsert).toHaveBeenLastCalledWith([item()], {
      replaceLogos: true,
    });
  });

  it("allows an idempotent refresh at the exact index cap but rejects new identities", async () => {
    mocks.load.mockReturnValue(
      Array.from({ length: 10_000 }, (_, index) =>
        item(`osm-node-${index + 1}`),
      ),
    );
    await run();
    expect(mocks.import).toHaveBeenCalledTimes(1);
    vi.resetModules();
    mocks.import.mockResolvedValue({
      merchants: [item("osm-node-10001")],
      report: {},
    });
    await expect(run()).rejects.toThrow("10,000");
    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it("closes the database and does not write imported records on network failure", async () => {
    mocks.import.mockRejectedValue(new Error("HTTP 503"));
    await expect(run()).rejects.toThrow("HTTP 503");
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("retains category/location uncertainty and prior aliases across geographic refreshes", async () => {
    mocks.load.mockReturnValue([
      {
        ...item(),
        defaultCategory: null,
        city: null,
        aliases: ["Nordlicht Markt"],
      },
    ]);
    mocks.import.mockResolvedValue({
      merchants: [{ ...item(), city: "Wien", aliases: ["Nordlicht Shop"] }],
      report: {},
    });
    await run();
    expect(mocks.upsert).toHaveBeenLastCalledWith(
      [
        {
          ...item(),
          city: null,
          defaultCategory: null,
          aliases: ["Nordlicht Markt", "Nordlicht Shop"],
        },
      ],
      { replaceLogos: false },
    );
  });
});
