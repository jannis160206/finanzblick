import { expect, it, vi, afterEach } from "vitest";
import { completeMerchantCatalogue } from "./merchant-catalogue-completion";
import { importAuthorizedCommonsLogos } from "./merchant-logo-authorized-import";
import { seedMerchants } from "./merchants";
import { AutomationStore } from "./store";
import { AccountDatabase } from "@/lib/server/database";
import { createTestDirectory } from "@/lib/server/test-support";
import { rm } from "node:fs/promises";
import { join } from "node:path";

vi.mock(
  import("./merchant-logo-authorized-import"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    importAuthorizedCommonsLogos: vi.fn(),
  }),
);

const fixtures: { accounts: AccountDatabase; directory: string }[] = [];
afterEach(async () => {
  for (const { accounts, directory } of fixtures) {
    accounts.close();
    await rm(directory, { recursive: true, force: true });
  }
  fixtures.length = 0;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const options = {
  userId: "synthetic-user",
  rightsReference: "Operator declaration for private use",
};
const report = (remaining = 0, nextAfter: string | null = null) => ({
  imported: 1,
  cached: 2,
  publicCached: 3,
  skipped: 1,
  processed: 7,
  remaining,
  nextAfter,
  entities: [
    {
      wikidataId: "Q123",
      merchantId: "example",
      status: "skipped",
      reason: "No P154 logo",
    },
  ],
});

function storeFixture() {
  const directory = createTestDirectory();
  const accounts = new AccountDatabase(join(directory, "completion.sqlite"));
  accounts.transaction((db) =>
    db
      .prepare(
        "INSERT INTO users VALUES ('synthetic-user', 'synthetic-user', 'user', 'fixture-not-a-password', 1)",
      )
      .run(),
  );
  fixtures.push({ accounts, directory });
  const store = new AutomationStore(accounts);
  vi.spyOn(store, "loadMerchants").mockReturnValue(seedMerchants);
  vi.spyOn(store, "upsertMerchants").mockImplementation(() => {});
  return store;
}

it("seeds the single catalogue once and drains sequential bounded scans beyond the 200-entity cap", async () => {
  const store = storeFixture();
  vi.mocked(importAuthorizedCommonsLogos)
    .mockResolvedValueOnce(report(40, "Q500"))
    .mockResolvedValueOnce(report());
  const result = await completeMerchantCatalogue(store, options);
  expect(store.upsertMerchants).toHaveBeenCalledExactlyOnceWith(seedMerchants);
  expect(importAuthorizedCommonsLogos).toHaveBeenCalledTimes(2);
  expect(
    vi.mocked(importAuthorizedCommonsLogos).mock.calls[0][1].after,
  ).toBeUndefined();
  expect(vi.mocked(importAuthorizedCommonsLogos).mock.calls[1][1].after).toBe(
    "Q500",
  );
  expect(result).toMatchObject({
    processed: 14,
    imported: 2,
    cached: 4,
    publicCached: 6,
    skipped: 2,
  });
  expect(result.entities).toHaveLength(2);
});

it("resumes an explicit cursor and shares one overall deadline without resetting it between scans", async () => {
  const store = storeFixture();
  const onBatch = vi.fn();
  vi.mocked(importAuthorizedCommonsLogos).mockResolvedValue(report());
  await completeMerchantCatalogue(store, {
    ...options,
    after: "Q200",
    onBatch,
  });
  expect(importAuthorizedCommonsLogos).toHaveBeenCalledWith(
    store,
    expect.objectContaining({
      ...options,
      after: "Q200",
      onBatch,
      signal: expect.any(AbortSignal),
    }),
  );
});

it.each([null, "Q100"])(
  "fails explicitly if a continuation cursor does not advance: %s",
  async (cursor) => {
    const store = storeFixture();
    vi.mocked(importAuthorizedCommonsLogos).mockResolvedValue(
      report(1, cursor),
    );
    await expect(
      completeMerchantCatalogue(store, { ...options, after: "Q100" }),
    ).rejects.toThrow("cursor did not advance");
  },
);

it("propagates source failures and never reports partial completion as success", async () => {
  const store = storeFixture();
  vi.mocked(importAuthorizedCommonsLogos)
    .mockResolvedValueOnce(report(1, "Q500"))
    .mockRejectedValueOnce(new Error("Public source unavailable"));
  await expect(completeMerchantCatalogue(store, options)).rejects.toThrow(
    "Public source unavailable",
  );
});

it("does not touch the catalogue or network after cancellation", async () => {
  const store = storeFixture();
  const controller = new AbortController();
  controller.abort(new Error("Cancelled"));
  await expect(
    completeMerchantCatalogue(store, { ...options, signal: controller.signal }),
  ).rejects.toThrow("Cancelled");
  expect(store.upsertMerchants).not.toHaveBeenCalled();
  expect(importAuthorizedCommonsLogos).not.toHaveBeenCalled();
});

it.each([
  { userId: "foreign" },
  { rightsReference: "" },
  { after: "https://foreign.invalid" },
  { logoChoices: [{ wikidataId: "Q999999999999", filename: "Unknown.svg" }] },
])(
  "validates operator identity and public inputs before catalog writes: %j",
  async (invalid) => {
    const store = storeFixture();
    await expect(
      completeMerchantCatalogue(store, { ...options, ...invalid }),
    ).rejects.toThrow();
    expect(store.upsertMerchants).not.toHaveBeenCalled();
    expect(importAuthorizedCommonsLogos).not.toHaveBeenCalled();
  },
);
