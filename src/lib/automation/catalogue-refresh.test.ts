import { join } from "node:path";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import { AutomationStore } from "./store";
import { LEASE_MS, MERCHANT_BACKFILL_VERSION } from "./schema";
import {
  PublicMerchantCatalogue,
  PUBLIC_MERCHANT_SOURCES,
} from "./catalogue-refresh";
import { AutomationWorker } from "./worker";
import { MerchantIndex, type Merchant } from "./merchants";
import { parseOsmMerchants } from "./merchant-import";

let directory: string;
let accounts: AccountDatabase;
let store: AutomationStore;
let userId: string;
beforeEach(async () => {
  directory = createTestDirectory();
  accounts = new AccountDatabase(join(directory, "catalogue.sqlite"));
  store = new AutomationStore(accounts);
  userId = (await accounts.register("catalogue", "test-password-123")).user.id;
  accounts.putFinance(userId, blankTestState(), 0);
  store.acquire("catalogue-worker");
});
afterEach(() => {
  accounts.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const request = () =>
  vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      version: 0.6,
      osm3s: { copyright: "OpenStreetMap contributors" },
      elements: [
        {
          type: "node",
          id: 71234,
          tags: { name: "Public Duty Free", shop: "duty_free" },
        },
      ],
    }),
  );

function completeSnapshots(first: Merchant[]) {
  accounts.transaction((db) => {
    for (const [index, source] of PUBLIC_MERCHANT_SOURCES.entries()) {
      db.prepare(
        "INSERT INTO merchant_catalogue_sources VALUES (?, 'current', 0, ?, 0)",
      ).run(source.id, index === 0 ? 0 : Date.now() + 86_400_000);
      db.prepare("INSERT INTO merchant_catalogue_snapshots VALUES (?, ?)").run(
        source.id,
        JSON.stringify(index === 0 ? first : []),
      );
    }
  });
}

it("covers the three public regions exactly once with twenty bounded, unique tiles", () => {
  expect(PUBLIC_MERCHANT_SOURCES).toHaveLength(20);
  expect(new Set(PUBLIC_MERCHANT_SOURCES.map((source) => source.id)).size).toBe(
    20,
  );
  const regions = [
    { id: "villach", bbox: [46.59, 13.81, 46.64, 13.89] },
    { id: "klagenfurt", bbox: [46.6, 14.27, 46.65, 14.35] },
    { id: "salzburg", bbox: [47.78, 13.02, 47.83, 13.09] },
  ];
  for (const {
    id,
    bbox: [south, west, north, east],
  } of regions) {
    const tiles = PUBLIC_MERCHANT_SOURCES.filter((source) =>
      source.id.startsWith(`${id}-`),
    );
    let area = 0;
    for (const {
      bbox: [s, w, n, e],
    } of tiles) {
      expect(s).toBeGreaterThanOrEqual(south);
      expect(w).toBeGreaterThanOrEqual(west);
      expect(n).toBeLessThanOrEqual(north);
      expect(e).toBeLessThanOrEqual(east);
      expect(n).toBeGreaterThan(s);
      expect(e).toBeGreaterThan(w);
      area += (n - s) * (e - w);
    }
    expect(area).toBeCloseTo((north - south) * (east - west), 12);
    for (const [index, left] of tiles.entries())
      for (const right of tiles.slice(index + 1))
        expect(
          Math.min(left.bbox[2], right.bbox[2]) <=
            Math.max(left.bbox[0], right.bbox[0]) ||
            Math.min(left.bbox[3], right.bbox[3]) <=
              Math.max(left.bbox[1], right.bbox[1]),
        ).toBe(true);
  }
});

it.each([null, "Shopping"] as const)(
  "retains outside-region category evidence %s after a complete regional rebuild",
  async (category) => {
    const payload = {
      version: 0.6,
      osm3s: { copyright: "OpenStreetMap contributors" },
      elements: [
        {
          type: "node",
          id: 4,
          tags: {
            name: "Regional Brand",
            brand: "Regional Brand",
            "brand:wikidata": "Q123",
            shop: "supermarket",
          },
        },
      ],
    };
    const fresh = parseOsmMerchants(payload, 1).merchants[0];
    store.upsertMerchants([
      {
        ...fresh,
        city: "Wien",
        defaultCategory: category,
        requiresCategoryEvidence: category === null,
      },
    ]);
    completeSnapshots([]);
    await new PublicMerchantCatalogue(
      store,
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)),
    ).maintain(new AbortController().signal, "catalogue-worker");
    expect(store.getMerchant(fresh.id)?.defaultCategory).toBeNull();
    expect(store.getMerchant(fresh.id)?.requiresCategoryEvidence).toBe(true);
    expect(
      accounts.read((db) =>
        db
          .prepare(
            "SELECT category FROM merchant_catalogue_external WHERE merchant_id = ?",
          )
          .get(fresh.id),
      )?.category,
    ).toBe(category);
  },
);

it.each([true, false])(
  "retires superseded managed brand identities without deleting metadata (initial coverage complete: %s)",
  async (complete) => {
    const branded = {
      name: "Public Brand",
      brand: "Public Brand",
      "brand:wikidata": "Q123",
    };
    const payload = (tags: Record<string, string>) => ({
      version: 0.6,
      osm3s: { copyright: "OpenStreetMap contributors" },
      elements: [{ type: "node", id: 5, tags }],
    });
    const legacy = parseOsmMerchants(
      payload({ ...branded, amenity: "parking", fee: "yes" }),
      1,
    ).merchants[0];
    store.upsertMerchants([legacy]);
    if (complete) completeSnapshots([legacy]);
    else
      accounts.transaction((db) => {
        db.prepare(
          "INSERT INTO merchant_catalogue_sources VALUES (?, 'current', 0, 0, 1)",
        ).run(PUBLIC_MERCHANT_SOURCES[0].id);
        db.prepare(
          "INSERT INTO merchant_catalogue_snapshots VALUES (?, ?)",
        ).run(PUBLIC_MERCHANT_SOURCES[0].id, JSON.stringify([legacy]));
      });
    await new PublicMerchantCatalogue(
      store,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(payload({ ...branded, amenity: "parking", fee: "no" })),
        ),
    ).maintain(new AbortController().signal, "catalogue-worker");
    if (!complete) {
      expect(store.getMerchant(legacy.id)?.matchable).toBe(true);
      accounts.transaction((db) => {
        db.prepare(
          "UPDATE merchant_catalogue_sources SET next_refresh_at = 0 WHERE id = ?",
        ).run(PUBLIC_MERCHANT_SOURCES[0].id);
        for (const source of PUBLIC_MERCHANT_SOURCES.slice(1)) {
          db.prepare(
            "INSERT INTO merchant_catalogue_sources VALUES (?, 'current', 0, ?, 0)",
          ).run(source.id, Date.now() + 86_400_000);
          db.prepare(
            "INSERT INTO merchant_catalogue_snapshots VALUES (?, '[]')",
          ).run(source.id);
        }
      });
      await new PublicMerchantCatalogue(
        store,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json(
              payload({ ...branded, amenity: "parking", fee: "no" }),
            ),
          ),
      ).maintain(new AbortController().signal, "catalogue-worker");
    }
    expect(store.getMerchant(legacy.id)).toMatchObject({
      canonicalName: legacy.canonicalName,
      matchable: false,
    });
    expect(store.getMerchant("osm-node-5")?.matchable).toBe(false);
    expect(
      new MerchantIndex(store.loadMerchants()).match("Public Brand").merchant,
    ).toBeUndefined();
  },
);

it("rolls back merchant facts and the authoritative snapshot together on interruption", async () => {
  const payload = (shop: string) => ({
    version: 0.6,
    osm3s: { copyright: "OpenStreetMap contributors" },
    elements: [{ type: "node", id: 6, tags: { name: "Public Shop", shop } }],
  });
  const originalFacts = parseOsmMerchants(payload("supermarket"), 1).merchants;
  store.upsertMerchants(originalFacts);
  completeSnapshots(originalFacts);
  const original = store.upsertMerchants.bind(store);
  vi.spyOn(store, "upsertMerchants").mockImplementation((merchants, options) =>
    original(merchants, {
      ...options,
      checkpoint: (db) => {
        options?.checkpoint?.(db);
        throw new Error("Simulated interruption");
      },
    }),
  );
  await expect(
    new PublicMerchantCatalogue(
      store,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(payload("duty_free"))),
    ).maintain(new AbortController().signal, "catalogue-worker"),
  ).rejects.toThrow("Simulated interruption");
  expect(store.loadMerchants()).toEqual(originalFacts);
  expect(
    accounts.read((db) =>
      db
        .prepare(
          "SELECT definitions_json FROM merchant_catalogue_snapshots WHERE source_id = ?",
        )
        .get(PUBLIC_MERCHANT_SOURCES[0].id),
    )?.definitions_json,
  ).toBe(JSON.stringify(originalFacts));
  expect(
    accounts.read((db) =>
      db
        .prepare("SELECT status FROM merchant_catalogue_sources WHERE id = ?")
        .get(PUBLIC_MERCHANT_SOURCES[0].id),
    )?.status,
  ).toBe("refreshing");
});

it("repairs old lossy brand aggregates only from a complete regional snapshot, retaining real shop conflicts", async () => {
  const make = (id: number, name: string, shop: string) => ({
    type: "node",
    id,
    tags: {
      name,
      brand: name,
      "brand:wikidata": name === "Clean Brand" ? "Q123" : "Q124",
      shop,
    },
  });
  const payload = (elements: unknown[]) => ({
    version: 0.6,
    osm3s: { copyright: "OpenStreetMap contributors" },
    elements,
  });
  const incoming = payload([
    make(1, "Clean Brand", "supermarket"),
    make(2, "Mixed Brand", "supermarket"),
  ]);
  const fresh = parseOsmMerchants(incoming, 1).merchants;
  store.upsertMerchants(
    fresh.map((merchant) => ({
      ...merchant,
      defaultCategory: null,
      requiresCategoryEvidence: true,
    })),
  );
  accounts.transaction((db) => {
    db.prepare(
      "INSERT INTO merchant_catalogue_sources VALUES (?, 'current', 0, 0, 2)",
    ).run(PUBLIC_MERCHANT_SOURCES[0].id);
    db.prepare("INSERT INTO merchant_catalogue_snapshots VALUES (?, ?)").run(
      PUBLIC_MERCHANT_SOURCES[0].id,
      JSON.stringify(store.loadMerchants()),
    );
  });
  const controller = new AbortController();
  await new PublicMerchantCatalogue(
    store,
    vi.fn<typeof fetch>().mockResolvedValue(Response.json(incoming)),
  ).maintain(controller.signal, "catalogue-worker");
  expect(store.getMerchant(fresh[0].id)?.defaultCategory).toBeNull();
  const conflicting = parseOsmMerchants(
    payload([make(3, "Mixed Brand", "clothes")]),
    2,
  ).merchants;
  accounts.transaction((db) => {
    for (const [index, source] of PUBLIC_MERCHANT_SOURCES.entries()) {
      db.prepare(
        `INSERT INTO merchant_catalogue_sources VALUES (?, 'current', ?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET next_refresh_at = excluded.next_refresh_at`,
      ).run(source.id, Date.now(), index === 0 ? 0 : Date.now() + 86_400_000);
      db.prepare(
        `INSERT INTO merchant_catalogue_snapshots VALUES (?, ?)
        ON CONFLICT(source_id) DO UPDATE SET definitions_json = excluded.definitions_json`,
      ).run(
        source.id,
        JSON.stringify(index === 0 ? fresh : index === 1 ? conflicting : []),
      );
    }
  });
  await new PublicMerchantCatalogue(
    store,
    vi.fn<typeof fetch>().mockResolvedValue(Response.json(incoming)),
  ).maintain(controller.signal, "catalogue-worker");
  expect(store.getMerchant(fresh[0].id)?.defaultCategory).toBe("Lebensmittel");
  expect(store.getMerchant(fresh[1].id)?.defaultCategory).toBeNull();
  expect(store.getMerchant(fresh[1].id)?.requiresCategoryEvidence).toBe(true);
});

it("persists non-merchant eligibility without poisoning a shop's name match", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      version: 0.6,
      osm3s: { copyright: "OpenStreetMap contributors" },
      elements: [
        {
          type: "node",
          id: 1,
          tags: { name: "Nova", amenity: "parking", fee: "no" },
        },
        { type: "node", id: 2, tags: { name: "Nova", shop: "supermarket" } },
      ],
    }),
  );
  const index = await new PublicMerchantCatalogue(store, fetch).maintain(
    new AbortController().signal,
    "catalogue-worker",
  );
  expect(store.getMerchant("osm-node-1")?.matchable).toBe(false);
  expect(index?.match("Nova").merchant?.id).toBe("osm-node-2");
  expect(
    new MerchantIndex(store.loadMerchants()).match("Nova").merchant?.id,
  ).toBe("osm-node-2");
});

it("does not consume a source-upgrade pass using stale pre-refresh facts", async () => {
  store.enqueueBackfill(userId, Date.now(), {
    onceVersion: MERCHANT_BACKFILL_VERSION,
  });
  await new AutomationWorker(
    store,
    "catalogue-worker",
    new MerchantIndex([]),
  ).process(store.claim("catalogue-worker")!);
  accounts.transaction((db) =>
    db
      .prepare(
        "INSERT INTO merchant_catalogue_sources VALUES (?, 'current', ?, 0, 1)",
      )
      .run(PUBLIC_MERCHANT_SOURCES[0].id, Date.now()),
  );
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => {
      expect(
        store.snapshot(userId).jobs.filter((job) => job.status !== "COMPLETED"),
      ).toHaveLength(0);
      return request()("https://overpass-api.de/api/interpreter");
    });
  await new PublicMerchantCatalogue(store, fetch).maintain(
    new AbortController().signal,
    "catalogue-worker",
  );
  expect(
    store.snapshot(userId).jobs.filter((job) => job.status === "QUEUED"),
  ).toHaveLength(1);
});

it("requests fixed public geography only, persists facts, and automatically queues a historical pass", async () => {
  const fetch = request();
  const refreshed = await new PublicMerchantCatalogue(store, fetch).maintain(
    new AbortController().signal,
    "catalogue-worker",
  );
  expect(refreshed?.match("Public Duty Free").merchant?.defaultCategory).toBe(
    "Shopping",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, options] = fetch.mock.calls[0];
  expect(String(url)).toBe("https://overpass-api.de/api/interpreter");
  const body = new URLSearchParams(String(options?.body)).get("data")!;
  expect(body).toContain(PUBLIC_MERCHANT_SOURCES[0].bbox.join(","));
  expect(body).not.toContain(userId);
  expect(body).not.toContain("catalogue");
  expect(store.snapshot(userId).catalogue).toMatchObject({
    status: "current",
    sources: 1,
    warning: null,
  });
  expect(store.snapshot(userId).jobs).toHaveLength(1);
  expect(
    accounts.read((db) =>
      db.prepare("SELECT version FROM automation_backfill_passes").get(),
    )?.version,
  ).toBe(MERCHANT_BACKFILL_VERSION);
});

it("persists freshness across restart and never resets an existing pass", async () => {
  const first = request();
  const controller = new AbortController();
  await new PublicMerchantCatalogue(store, first).maintain(
    controller.signal,
    "catalogue-worker",
  );
  const next = request();
  await new PublicMerchantCatalogue(store, next).maintain(
    controller.signal,
    "catalogue-worker",
  );
  expect(
    new URLSearchParams(String(next.mock.calls[0][1]?.body)).get("data"),
  ).toContain(PUBLIC_MERCHANT_SOURCES[1].bbox.join(","));
  expect(store.snapshot(userId).jobs).toHaveLength(1);
});

it("reports outages explicitly, retains verified data and backs off failed sources", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(new Error("Offline"));
  const catalogue = new PublicMerchantCatalogue(store, fetch);
  await catalogue.maintain(new AbortController().signal, "catalogue-worker");
  expect(store.snapshot(userId).catalogue).toMatchObject({
    status: "unavailable",
    sources: 0,
  });
  expect(store.snapshot(userId).catalogue?.warning).toContain(
    "erneuter Versuch",
  );
  expect(log).toHaveBeenCalledTimes(1);
  await catalogue.maintain(new AbortController().signal, "catalogue-worker");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    accounts.read((db) =>
      db
        .prepare(
          "SELECT next_refresh_at - checked_at AS delay FROM merchant_catalogue_sources",
        )
        .get(),
    )?.delay,
  ).toBeGreaterThanOrEqual(3_599_900);
});

it("fences catalogue writes when another worker takes over during the request", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + LEASE_MS + 1);
      expect(store.acquire("replacement")).toBe(true);
      return request()("https://overpass-api.de/api/interpreter");
    });
  await expect(
    new PublicMerchantCatalogue(store, fetch).maintain(
      new AbortController().signal,
      "catalogue-worker",
    ),
  ).rejects.toThrow("Worker lease lost");
  expect(store.loadMerchants()).toHaveLength(0);
  expect(store.snapshot(userId).catalogue?.status).toBe("refreshing");
});
