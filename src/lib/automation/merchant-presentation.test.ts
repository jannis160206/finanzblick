import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import * as merchantLogo from "./merchant-logo";
import { type PrivateMerchantLogo } from "./merchant-logo-metadata";
import { merchantLogoVersion } from "./merchant-logo-version";
import { merchantPresentations } from "./merchant-presentation";
import {
  MAX_MERCHANT_MARKS,
  merchantMarksResponseSchema,
} from "./merchant-presentation-schema";
import { merchantSchema, seedMerchants, type Merchant } from "./merchants";
import { AutomationStore } from "./store";

let directory: string;
let accounts: AccountDatabase;
let store: AutomationStore;
let network: ReturnType<typeof vi.fn<typeof fetch>>;

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

async function privatePng(color = 20): Promise<PrivateMerchantLogo> {
  const bytes = await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 4,
      background: { r: color, g: 40, b: 60, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const file = `${createHash("sha256").update(bytes).digest("hex")}.png`;
  await mkdir(join(directory, "merchant-logos"), { recursive: true });
  await writeFile(join(directory, "merchant-logos", file), bytes);
  return {
    file,
    license: "CC0-1.0",
    attribution: "Test-created geometric PNG; CC0-1.0",
    sourceUrl:
      "https://commons.wikimedia.org/wiki/File:Test-created-example.png",
  };
}

beforeEach(() => {
  directory = createTestDirectory();
  accounts = new AccountDatabase(join(directory, "presentation.sqlite"));
  store = new AutomationStore(accounts);
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

describe("bounded private merchant presentation", () => {
  it("returns only IDs and verified metadata versions, regardless of an old merchantLogo:false transaction", async () => {
    const logo = await privatePng();
    store.upsertMerchants([merchant({ logo })]);
    const oldTransaction = { merchantId: "test-shop", merchantLogo: false };
    const marks = await merchantPresentations(store, {
      merchantIds: [oldTransaction.merchantId],
    });
    expect(marks).toEqual([
      {
        merchantId: "test-shop",
        logo: { merchantId: "test-shop", version: merchantLogoVersion(logo) },
      },
    ]);
    expect(marks[0].logo?.version).toMatch(/^[a-f0-9]{64}$/);
    expect(merchantMarksResponseSchema.parse({ marks })).toEqual({ marks });
    expect(JSON.stringify(marks)).not.toMatch(
      /aliases|attribution|sourceUrl|amount|transactions|balances/,
    );
  });

  it("returns null for unknown IDs, missing metadata and missing private files", async () => {
    const logo = await privatePng();
    store.upsertMerchants([
      merchant(),
      merchant({
        id: "missing-file",
        canonicalName: "Other Market",
        wikidataId: "Q456",
        logo,
      }),
    ]);
    await rm(join(directory, "merchant-logos", logo.file));
    expect(
      await merchantPresentations(store, {
        merchantIds: ["unknown-shop", "test-shop", "missing-file"],
      }),
    ).toEqual([
      { merchantId: "unknown-shop", logo: null },
      { merchantId: "test-shop", logo: null },
      { merchantId: "missing-file", logo: null },
    ]);
    expect(store.logoCandidates(["unknown-shop"]).get("unknown-shop")).toEqual(
      [],
    );
  });

  it("rejects changed PNG bytes even when they still decode and have the right dimensions", async () => {
    const logo = await privatePng();
    const other = await privatePng(70);
    store.upsertMerchants([merchant({ logo })]);
    await writeFile(
      join(directory, "merchant-logos", logo.file),
      await readFile(join(directory, "merchant-logos", other.file)),
    );
    expect(
      await merchantPresentations(store, { merchantIds: ["test-shop"] }),
    ).toEqual([{ merchantId: "test-shop", logo: null }]);
  });

  it("rejects content-addressed non-images and truncated PNG data", async () => {
    const cases = [
      Buffer.alloc(100, 42),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(48).fill(0)]),
    ];
    for (const [index, bytes] of cases.entries()) {
      const file = `${createHash("sha256").update(bytes).digest("hex")}.png`;
      const logo = { ...(await privatePng()), file };
      await writeFile(join(directory, "merchant-logos", file), bytes);
      store.upsertMerchants([merchant({ logo, updatedAt: 100 + index })]);
      expect(
        await merchantPresentations(store, { merchantIds: ["test-shop"] }),
      ).toEqual([{ merchantId: "test-shop", logo: null }]);
    }
  });

  it.each([
    { license: "Unlicensed" },
    { attribution: "" },
    { sourceUrl: "https://example.invalid/logo.png" },
    { file: "../../accounts.sqlite" },
  ])(
    "does not present invalid private asset licensing or provenance: %j",
    async (invalid) => {
      const logo = await privatePng();
      const reference = {
        ...merchant(),
        logo: { ...logo, ...invalid },
      } as Merchant;
      vi.spyOn(store, "logoCandidates").mockReturnValue(
        new Map([["test-shop", [reference]]]),
      );
      expect(
        await merchantPresentations(store, { merchantIds: ["test-shop"] }),
      ).toEqual([{ merchantId: "test-shop", logo: null }]);
    },
  );

  it("deduplicates requested IDs and shared private file validation", async () => {
    const logo = await privatePng();
    store.upsertMerchants([
      merchant({ logo }),
      merchant({ id: "second-shop", logo }),
      merchant({ id: "third-shop", logo }),
    ]);
    const read = vi.spyOn(merchantLogo, "readPrivateMerchantLogo");
    const marks = await merchantPresentations(store, {
      merchantIds: ["third-shop", "test-shop", "third-shop", "second-shop"],
    });
    expect(marks.map((mark) => mark.merchantId)).toEqual([
      "third-shop",
      "test-shop",
      "second-shop",
    ]);
    expect(marks.map((mark) => mark.logo?.merchantId)).toEqual([
      "third-shop",
      "test-shop",
      "second-shop",
    ]);
    expect(read).toHaveBeenCalledExactlyOnceWith(accounts.path, logo);
  });

  it("prefers a valid exact reference over a newer proven equivalent", async () => {
    const ownLogo = await privatePng();
    const otherLogo = await privatePng(70);
    store.upsertMerchants([
      merchant({ logo: ownLogo }),
      merchant({ id: "newer-reference", logo: otherLogo, updatedAt: 200 }),
    ]);
    expect(
      await merchantPresentations(store, { merchantIds: ["test-shop"] }),
    ).toEqual([
      {
        merchantId: "test-shop",
        logo: {
          merchantId: "test-shop",
          version: merchantLogoVersion(ownLogo),
        },
      },
    ]);
  });

  it.each(["absent metadata", "missing exact file"])(
    "uses the actual equivalent reference ID only with Q/name/region proof: %s",
    async (kind) => {
      const logo = await privatePng();
      const missing = { ...logo, file: `${"a".repeat(64)}.png` };
      store.upsertMerchants([
        merchant({
          canonicalName: "ＥＸＡＭＰＬＥ   MARKET",
          logo: kind === "missing exact file" ? missing : null,
        }),
        merchant({
          id: "proven-reference",
          canonicalName: "Example Market",
          logo,
        }),
      ]);
      expect(
        await merchantPresentations(store, { merchantIds: ["test-shop"] }),
      ).toEqual([
        {
          merchantId: "test-shop",
          logo: {
            merchantId: "proven-reference",
            version: merchantLogoVersion(logo),
          },
        },
      ]);
    },
  );

  it("uses a proven legacy OSM-derived Q identity for an equivalent fallback with a null stored Q", async () => {
    const logo = await privatePng();
    const legacyId = "osm-brand-Q123-0123456789abcdef";
    store.upsertMerchants([
      merchant(),
      merchant({ id: legacyId, wikidataId: null, logo }),
    ]);
    expect(
      accounts.read(
        (db) =>
          db
            .prepare("SELECT wikidata_id FROM merchants WHERE id = ?")
            .get(legacyId)?.wikidata_id,
      ),
    ).toBeNull();
    expect(store.getMerchant(legacyId)?.wikidataId).toBe("Q123");
    expect(
      store
        .logoCandidates(["test-shop"])
        .get("test-shop")
        ?.map((row) => row.id),
    ).toEqual([legacyId]);
    expect(
      await merchantPresentations(store, { merchantIds: ["test-shop"] }),
    ).toEqual([
      {
        merchantId: "test-shop",
        logo: { merchantId: legacyId, version: merchantLogoVersion(logo) },
      },
    ]);
  });

  it("never derives fallback Q proof from malformed legacy IDs or a valid legacy ID with a local source", async () => {
    const logo = await privatePng();
    const unproven = [
      merchant({
        id: "osm-brand-Q123-0123456789abcdef0",
        wikidataId: null,
        logo,
      }),
      merchant({
        id: "osm-brand-Q123-0123456789abcdeg",
        wikidataId: null,
        logo,
      }),
      merchant({
        id: "osm-brand-Q123-not-an-importer-hash",
        wikidataId: null,
        logo,
      }),
      merchant({
        id: "osm-brand-Q123-0123456789abcdef",
        source: "local",
        wikidataId: null,
        logo,
      }),
    ];
    store.upsertMerchants([merchant(), ...unproven]);
    for (const row of unproven)
      expect(store.getMerchant(row.id)?.wikidataId).toBeNull();
    expect(store.logoCandidates(["test-shop"]).get("test-shop")).toEqual([]);
    expect(
      await merchantPresentations(store, { merchantIds: ["test-shop"] }),
    ).toEqual([{ merchantId: "test-shop", logo: null }]);
  });

  it.each([
    { canonicalName: "Unrelated Market" },
    { region: "DE" },
    { wikidataId: "Q456" },
    { wikidataId: null },
  ])(
    "never borrows a logo across an identity mismatch: %j",
    async (identity) => {
      store.upsertMerchants([
        merchant(),
        merchant({
          id: "unproven-reference",
          logo: await privatePng(),
          ...identity,
        }),
      ]);
      expect(
        await merchantPresentations(store, { merchantIds: ["test-shop"] }),
      ).toEqual([{ merchantId: "test-shop", logo: null }]);
    },
  );

  it("does not use same-name aliases or same-name references without a Q identity", async () => {
    store.upsertMerchants([
      merchant({ wikidataId: null }),
      merchant({ id: "name-only", wikidataId: null, logo: await privatePng() }),
      merchant({
        id: "alias-only",
        canonicalName: "Different Brand",
        aliases: ["Example Market"],
        logo: await privatePng(70),
      }),
    ]);
    expect(
      await merchantPresentations(store, { merchantIds: ["test-shop"] }),
    ).toEqual([{ merchantId: "test-shop", logo: null }]);
  });

  it.each([
    null,
    {},
    { merchantIds: [""] },
    { merchantIds: ["../../accounts.sqlite"] },
    { merchantIds: ["shop/name"] },
    { merchantIds: ["shop name"] },
    { merchantIds: ["a".repeat(81)] },
    { merchantIds: [123] },
    { merchantIds: ["test-shop"], transactions: [] },
    { merchantIds: Array(MAX_MERCHANT_MARKS + 1).fill("test-shop") },
  ])(
    "rejects invalid or oversized input before touching the store: %j",
    async (input) => {
      const candidates = vi.spyOn(store, "logoCandidates");
      await expect(merchantPresentations(store, input)).rejects.toThrow();
      expect(candidates).not.toHaveBeenCalled();
    },
  );

  it("accepts exactly 100 public IDs and an empty request without a merchant scan", async () => {
    const load = vi.spyOn(store, "loadMerchants");
    const ids = Array.from(
      { length: MAX_MERCHANT_MARKS },
      (_, index) => `unknown-${index}`,
    );
    expect(await merchantPresentations(store, { merchantIds: ids })).toEqual(
      ids.map((merchantId) => ({ merchantId, logo: null })),
    );
    expect(await merchantPresentations(store, { merchantIds: [] })).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("does not read account finance or mutate any rows while presenting public merchant IDs", async () => {
    const state = JSON.stringify(blankTestState());
    accounts.transaction((db) => {
      db.prepare(
        "INSERT INTO users VALUES ('test-user', 'test-user', 'user', 'synthetic-hash', 1)",
      ).run();
      db.prepare("INSERT INTO finance VALUES ('test-user', ?, 1, ?, 1)").run(
        state,
        Buffer.byteLength(state),
      );
      db.exec(`
        CREATE TRIGGER prevent_finance_update BEFORE UPDATE ON finance
        BEGIN SELECT RAISE(ABORT, 'finance must not change'); END;
        CREATE TRIGGER prevent_finance_delete BEFORE DELETE ON finance
        BEGIN SELECT RAISE(ABORT, 'finance must not change'); END;
      `);
    });
    store.upsertMerchants([merchant({ logo: await privatePng() })]);
    const before = accounts.read((db) =>
      db.prepare("SELECT * FROM finance").all(),
    );
    const finance = vi.spyOn(accounts, "getFinance").mockImplementation(() => {
      throw new Error("No finance reads");
    });
    const transaction = vi.spyOn(accounts, "transaction");
    const merchantsBefore = store.loadMerchants();
    const prepare = accounts.read((db) => vi.spyOn(db, "prepare"));
    expect(
      await merchantPresentations(store, { merchantIds: ["test-shop"] }),
    ).toHaveLength(1);
    expect(finance).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(
      prepare.mock.calls.map(([sql]) => String(sql)).join(" "),
    ).not.toMatch(/finance|users|sessions|automation_jobs/i);
    expect(store.loadMerchants()).toEqual(merchantsBefore);
    expect(
      accounts.read((db) => db.prepare("SELECT * FROM finance").all()),
    ).toEqual(before);
  });
});

describe("bounded store logo candidates", () => {
  it("issues only parameterized ID and related-Q reads with a SQL bound", async () => {
    store.upsertMerchants([
      merchant(),
      merchant({ id: "related", logo: await privatePng() }),
    ]);
    const prepare = accounts.read((db) => vi.spyOn(db, "prepare"));
    expect(
      store
        .logoCandidates(["test-shop", "test-shop"])
        .get("test-shop")
        ?.map((row) => row.id),
    ).toEqual(["related"]);
    const queries = prepare.mock.calls.map(([sql]) => String(sql));
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/WHERE id IN\s*\(\?\)/i);
    expect(queries[1]).toMatch(/WHERE\s+\(?wikidata_id IN\s*\(\?\)/i);
    expect(queries[1]).toMatch(/LIMIT\s+(?:1000|1001)\b/i);
    expect(queries.join(" ")).not.toMatch(
      /finance|sessions|users|transactions|automation_jobs/i,
    );
  });

  it("accepts 1000 related references but fails closed on the 1001st", async () => {
    const logo = await privatePng();
    store.upsertMerchants([
      merchant(),
      ...Array.from({ length: 1000 }, (_, index) =>
        merchant({ id: `related-${index}`, logo }),
      ),
    ]);
    expect(store.logoCandidates(["test-shop"]).get("test-shop")).toHaveLength(
      1000,
    );
    store.upsertMerchants([merchant({ id: "related-overflow", logo })]);
    expect(() => store.logoCandidates(["test-shop"])).toThrow(/limit/i);
  });

  it("does not scan or parse unrelated merchant rows", async () => {
    store.upsertMerchants([merchant({ logo: await privatePng() })]);
    accounts.transaction((db) => {
      db.prepare(
        `INSERT INTO merchants
        (id, canonical_name, aliases_json, regex_json, region, source, updated_at)
        VALUES ('unrelated', 'Other Shop', '[""]', '[]', 'AT', 'osm', 1)`,
      ).run();
    });
    expect(
      await merchantPresentations(store, {
        merchantIds: ["test-shop", "unknown"],
      }),
    ).toEqual([
      {
        merchantId: "test-shop",
        logo: {
          merchantId: "test-shop",
          version: merchantLogoVersion(store.getMerchant("test-shop")!.logo!),
        },
      },
      { merchantId: "unknown", logo: null },
    ]);
    expect(() => store.logoCandidates(Array(101).fill("test-shop"))).toThrow();
  });
});

describe("merchant metadata and selective logo writes", () => {
  it("preserves a valid cached logo through seed and metadata refreshes by default", async () => {
    const seed = seedMerchants.find((row) => row.id === "at-bipa")!;
    const logo = await privatePng();
    store.upsertMerchants([{ ...seed, logo }]);
    store.upsertMerchants([{ ...seed, updatedAt: seed.updatedAt + 1 }]);
    expect(store.getMerchant(seed.id)?.logo).toEqual(logo);
    store.upsertMerchants([
      {
        ...store.getMerchant(seed.id)!,
        aliases: ["Bipa Test"],
        city: "Test City",
        logo: null,
        updatedAt: seed.updatedAt + 2,
      },
    ]);
    expect(store.getMerchant(seed.id)).toMatchObject({
      aliases: ["Bipa Test"],
      city: "Test City",
      logo,
    });
  });

  it("clears a cached logo only when replacement is explicitly requested", async () => {
    store.upsertMerchants([merchant({ logo: await privatePng() })]);
    store.upsertMerchants([merchant({ updatedAt: 101 })], {
      replaceLogos: true,
    });
    expect(store.getMerchant("test-shop")?.logo).toBeNull();
  });

  it.each([
    { canonicalName: "Different Brand" },
    { region: "DE" },
    { wikidataId: "Q456" },
    { wikidataId: null },
  ])(
    "clears a logo when its merchant identity changes: %j",
    async (identity) => {
      store.upsertMerchants([merchant({ logo: await privatePng() })]);
      store.upsertMerchants([merchant({ ...identity, updatedAt: 101 })]);
      expect(store.getMerchant("test-shop")?.logo).toBeNull();
    },
  );

  it("does not overwrite newer metadata or logos with stale upserts", async () => {
    const logo = await privatePng();
    store.upsertMerchants([merchant({ logo, updatedAt: 200 })]);
    const before = store.getMerchant("test-shop");
    store.upsertMerchants(
      [merchant({ canonicalName: "Outdated Market", updatedAt: 199 })],
      { replaceLogos: true },
    );
    expect(store.getMerchant("test-shop")).toEqual(before);
  });

  it("updates only logo, timestamp and Q identity, not categorization or merchant metadata", async () => {
    store.upsertMerchants([
      merchant({
        city: "Test City",
        license: "Factual metadata",
        attribution: "Test metadata",
        requiresCategoryEvidence: true,
      }),
    ]);
    const before = store.getMerchant("test-shop")!;
    const logo = await privatePng();
    const reference = {
      ...before,
      canonicalName: "Must Not Replace",
      aliases: ["Must Not Replace"],
      defaultCategory: "Tanken" as const,
      region: "DE",
      source: "local",
      city: "Other City",
      license: "Other license",
      attribution: "Other attribution",
      requiresCategoryEvidence: false,
      wikidataId: "Q456",
    };
    expect(store.updateMerchantLogo(reference, logo)).toBe(true);
    const after = store.getMerchant("test-shop")!;
    expect(after).toEqual({
      ...before,
      logo,
      wikidataId: "Q456",
      updatedAt: after.updatedAt,
    });
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(store.updateMerchantLogo(after, null)).toBe(true);
    expect(store.getMerchant("test-shop")?.logo).toBeNull();
  });

  it("does not overwrite concurrent metadata or logo changes after an optimistic timestamp conflict", async () => {
    store.upsertMerchants([merchant({ logo: await privatePng() })]);
    const stale = store.getMerchant("test-shop")!;
    const newLogo = await privatePng(70);
    store.upsertMerchants([
      merchant({
        aliases: ["Concurrent Alias"],
        logo: newLogo,
        updatedAt: 101,
      }),
    ]);
    const current = store.getMerchant("test-shop");
    expect(store.updateMerchantLogo(stale, null)).toBe(false);
    expect(store.getMerchant("test-shop")).toEqual(current);
    expect(
      store.updateMerchantLogo({ ...stale, id: "unknown-shop" }, newLogo),
    ).toBe(false);
  });

  it("validates logo licensing before making a selective write", async () => {
    store.upsertMerchants([merchant()]);
    const before = store.getMerchant("test-shop")!;
    const logo = await privatePng();
    expect(() =>
      store.updateMerchantLogo(before, {
        ...logo,
        license: "Unlicensed",
      } as unknown as PrivateMerchantLogo),
    ).toThrow();
    expect(store.getMerchant("test-shop")).toEqual(before);
  });

  it("keeps synthetic account finance byte-for-byte unchanged during metadata, logo and attribution archive writes", async () => {
    const state = JSON.stringify(blankTestState());
    accounts.transaction((db) => {
      db.prepare(
        "INSERT INTO users VALUES ('test-user', 'test-user', 'user', 'synthetic-hash', 1)",
      ).run();
      db.prepare("INSERT INTO finance VALUES ('test-user', ?, 7, ?, 123)").run(
        state,
        Buffer.byteLength(state),
      );
      db.exec(`
        CREATE TRIGGER prevent_finance_insert BEFORE INSERT ON finance
        BEGIN SELECT RAISE(ABORT, 'finance must not change'); END;
        CREATE TRIGGER prevent_finance_update BEFORE UPDATE ON finance
        BEGIN SELECT RAISE(ABORT, 'finance must not change'); END;
        CREATE TRIGGER prevent_finance_delete BEFORE DELETE ON finance
        BEGIN SELECT RAISE(ABORT, 'finance must not change'); END;
      `);
    });
    const before = accounts.read((db) =>
      db.prepare("SELECT * FROM finance").all(),
    );
    const initialLogo = await privatePng();
    const replacementLogo = await privatePng(70);
    store.upsertMerchants([merchant({ logo: initialLogo })]);
    store.upsertMerchants([
      merchant({ aliases: ["Updated Alias"], updatedAt: 101 }),
    ]);
    expect(
      store.updateMerchantLogo(
        store.getMerchant("test-shop")!,
        replacementLogo,
      ),
    ).toBe(true);
    store.upsertMerchants(
      [
        {
          ...store.getMerchant("test-shop")!,
          logo: null,
          updatedAt: store.getMerchant("test-shop")!.updatedAt + 1,
        },
      ],
      { replaceLogos: true },
    );
    expect(
      store.logoAttribution("test-shop", merchantLogoVersion(initialLogo)),
    ).toEqual({ canonicalName: "Example Market", logo: initialLogo });
    expect(
      store.logoAttribution("test-shop", merchantLogoVersion(replacementLogo)),
    ).toEqual({ canonicalName: "Example Market", logo: replacementLogo });
    expect(
      accounts.read((db) => db.prepare("SELECT * FROM finance").all()),
    ).toEqual(before);
  });
});

describe("versioned immutable merchant logo attribution", () => {
  it.each(["upsert", "selective"])(
    "changes presentation versions on logo replacement and retains old attribution through %s writes",
    async (kind) => {
      const originalLogo = await privatePng();
      const replacementLogo = await privatePng(70);
      const oldVersion = merchantLogoVersion(originalLogo);
      const newVersion = merchantLogoVersion(replacementLogo);
      store.upsertMerchants([merchant({ logo: originalLogo })]);
      expect(store.logoAttribution("test-shop", oldVersion)).toEqual({
        canonicalName: "Example Market",
        logo: originalLogo,
      });
      expect(
        (await merchantPresentations(store, { merchantIds: ["test-shop"] }))[0]
          .logo?.version,
      ).toBe(oldVersion);
      if (kind === "upsert")
        store.upsertMerchants([
          merchant({
            canonicalName: "Renamed Market",
            logo: replacementLogo,
            updatedAt: 101,
          }),
        ]);
      else
        expect(
          store.updateMerchantLogo(
            store.getMerchant("test-shop")!,
            replacementLogo,
          ),
        ).toBe(true);
      expect(newVersion).not.toBe(oldVersion);
      expect(
        (await merchantPresentations(store, { merchantIds: ["test-shop"] }))[0]
          .logo?.version,
      ).toBe(newVersion);
      expect(store.logoAttribution("test-shop", oldVersion)).toEqual({
        canonicalName: "Example Market",
        logo: originalLogo,
      });
      expect(store.logoAttribution("test-shop", newVersion)).toEqual({
        canonicalName: kind === "upsert" ? "Renamed Market" : "Example Market",
        logo: replacementLogo,
      });
      expect(store.logoAttribution("test-shop", "f".repeat(64))).toBeNull();
      expect(store.logoAttribution("unknown-shop", oldVersion)).toBeNull();
    },
  );

  it.each([
    { attribution: "Updated test creator credit; CC0-1.0" },
    {
      sourceUrl:
        "https://commons.wikimedia.org/wiki/File:Corrected-test-created-example.png",
    },
    { license: "CC-BY-4.0" as const },
  ])(
    "changes the version when metadata changes for the same raster file: %j",
    async (metadata) => {
      const originalLogo = await privatePng();
      const changedLogo = { ...originalLogo, ...metadata };
      const oldVersion = merchantLogoVersion(originalLogo);
      const newVersion = merchantLogoVersion(changedLogo);
      store.upsertMerchants([merchant({ logo: originalLogo })]);
      expect(newVersion).toMatch(/^[a-f0-9]{64}$/);
      expect(newVersion).not.toBe(oldVersion);
      expect(newVersion).not.toBe(changedLogo.file.slice(0, -4));
      expect(changedLogo.file).toBe(originalLogo.file);
      expect(
        store.updateMerchantLogo(store.getMerchant("test-shop")!, changedLogo),
      ).toBe(true);
      expect(
        await merchantPresentations(store, { merchantIds: ["test-shop"] }),
      ).toEqual([
        {
          merchantId: "test-shop",
          logo: { merchantId: "test-shop", version: newVersion },
        },
      ]);
      expect(store.logoAttribution("test-shop", oldVersion)).toEqual({
        canonicalName: "Example Market",
        logo: originalLogo,
      });
      expect(store.logoAttribution("test-shop", newVersion)).toEqual({
        canonicalName: "Example Market",
        logo: changedLogo,
      });
    },
  );

  it.each(["upsert", "selective"])(
    "preserves old attribution after explicit logo clearing through %s writes",
    async (kind) => {
      const logo = await privatePng();
      const version = merchantLogoVersion(logo);
      store.upsertMerchants([merchant({ logo })]);
      if (kind === "upsert")
        store.upsertMerchants([merchant({ updatedAt: 101 })], {
          replaceLogos: true,
        });
      else
        expect(
          store.updateMerchantLogo(store.getMerchant("test-shop")!, null),
        ).toBe(true);
      expect(
        await merchantPresentations(store, { merchantIds: ["test-shop"] }),
      ).toEqual([{ merchantId: "test-shop", logo: null }]);
      expect(store.logoAttribution("test-shop", version)).toEqual({
        canonicalName: "Example Market",
        logo,
      });
    },
  );

  it("does not replace an archived canonical name or attribution when a version is reused, and never expires it", async () => {
    const originalLogo = await privatePng();
    const replacementLogo = await privatePng(70);
    const originalVersion = merchantLogoVersion(originalLogo);
    const replacementVersion = merchantLogoVersion(replacementLogo);
    store.upsertMerchants([
      merchant({ canonicalName: "Original Market", logo: originalLogo }),
    ]);
    store.upsertMerchants([
      merchant({
        canonicalName: "Intermediate Market",
        logo: replacementLogo,
        updatedAt: 101,
      }),
    ]);
    store.upsertMerchants([
      merchant({
        canonicalName: "Later Market",
        logo: originalLogo,
        updatedAt: 102,
      }),
    ]);
    store.upsertMerchants(
      [
        merchant({
          canonicalName: "Later Market",
          updatedAt: 103,
        }),
      ],
      { replaceLogos: true },
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2040, 0, 1));
    expect(store.logoAttribution("test-shop", originalVersion)).toEqual({
      canonicalName: "Original Market",
      logo: originalLogo,
    });
    expect(store.logoAttribution("test-shop", replacementVersion)).toEqual({
      canonicalName: "Intermediate Market",
      logo: replacementLogo,
    });
    expect(
      accounts.read(
        (db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM merchant_logo_attributions WHERE merchant_id = ?",
            )
            .get("test-shop")?.n,
      ),
    ).toBe(2);
  });
});
