import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { AccountDatabase } from "@/lib/server/database";
import {
  importOsmMerchants,
  mergeOsmBrand,
  type MerchantBbox,
} from "./merchant-import";
import { MerchantIndex, merchantSchema, type Merchant } from "./merchants";
import {
  MERCHANT_BACKFILL_VERSION,
  merchantCatalogueStatusSchema,
} from "./schema";
import type { AutomationStore } from "./store";

const PUBLIC_CITY_AREAS: readonly { id: string; bbox: MerchantBbox }[] = [
  { id: "villach", bbox: [46.59, 13.81, 46.64, 13.89] },
  { id: "klagenfurt", bbox: [46.6, 14.27, 46.65, 14.35] },
  { id: "salzburg", bbox: [47.78, 13.02, 47.83, 13.09] },
];
export const PUBLIC_MERCHANT_SOURCES = PUBLIC_CITY_AREAS.flatMap(
  ({ id, bbox: [south, west, north, east] }) => {
    const latitude = (south + north) / 2;
    const longitude = (west + east) / 2;
    const quadrants = [
      {
        id: `${id}-sw`,
        bbox: [south, west, latitude, longitude] satisfies MerchantBbox,
      },
      {
        id: `${id}-se`,
        bbox: [south, longitude, latitude, east] satisfies MerchantBbox,
      },
      {
        id: `${id}-nw`,
        bbox: [latitude, west, north, longitude] satisfies MerchantBbox,
      },
      {
        id: `${id}-ne`,
        bbox: [latitude, longitude, north, east] satisfies MerchantBbox,
      },
    ];
    return id !== "salzburg"
      ? quadrants
      : quadrants.flatMap((tile) => {
          if (!tile.id.endsWith("w")) return [tile];
          const [s, w, n, e] = tile.bbox;
          const middle = (s + n) / 2;
          return [
            {
              id: `${tile.id}-south`,
              bbox: [s, w, middle, e] satisfies MerchantBbox,
            },
            {
              id: `${tile.id}-north`,
              bbox: [middle, w, n, e] satisfies MerchantBbox,
            },
          ].flatMap((part) => {
            if (!["salzburg-sw-north", "salzburg-nw-south"].includes(part.id))
              return [part];
            const [s, w, n, e] = part.bbox;
            const latitude = (s + n) / 2;
            const longitude = (w + e) / 2;
            return [
              {
                id: `${part.id}-sw`,
                bbox: [s, w, latitude, longitude] satisfies MerchantBbox,
              },
              {
                id: `${part.id}-se`,
                bbox: [s, longitude, latitude, e] satisfies MerchantBbox,
              },
              {
                id: `${part.id}-nw`,
                bbox: [latitude, w, n, longitude] satisfies MerchantBbox,
              },
              {
                id: `${part.id}-ne`,
                bbox: [latitude, longitude, n, e] satisfies MerchantBbox,
              },
            ];
          });
        });
  },
);
const DAY = 86_400_000;
const snapshotSchema = z.array(merchantSchema).max(1000);
const sourceSchema = z.object({
  id: z.string().max(80),
  status: z.enum(["current", "refreshing", "unavailable"]),
  checked_at: z.number().int().nonnegative(),
  next_refresh_at: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
});

function sources(accounts: AccountDatabase) {
  return accounts
    .read((db) =>
      db
        .prepare(
          `SELECT * FROM merchant_catalogue_sources
    WHERE id IN (${PUBLIC_MERCHANT_SOURCES.map(() => "?").join(",")}) ORDER BY id`,
        )
        .all(...PUBLIC_MERCHANT_SOURCES.map((source) => source.id)),
    )
    .map((row) => sourceSchema.parse(row));
}

export function merchantCatalogueStatus(accounts: AccountDatabase) {
  const rows = sources(accounts);
  if (!rows.length) return;
  const unavailable = rows.some((row) => row.status === "unavailable");
  return merchantCatalogueStatusSchema.parse({
    status: unavailable
      ? "unavailable"
      : rows.some((row) => row.status === "refreshing")
        ? "refreshing"
        : "current",
    checkedAt: Math.max(...rows.map((row) => row.checked_at)),
    sources: rows.filter((row) => row.status === "current").length,
    warning: unavailable
      ? "Öffentliche Händlerquelle derzeit nicht verfügbar. Gesicherte lokale Regeln bleiben aktiv; erneuter Versuch erfolgt automatisch."
      : null,
  });
}

export class PublicMerchantCatalogue {
  private nextCheck = 0;

  constructor(
    private readonly store: AutomationStore,
    private readonly request: typeof fetch = fetch,
  ) {}

  private record(
    owner: string,
    id: string,
    status: z.infer<typeof sourceSchema>["status"],
    next: number,
    imported = 0,
    snapshot?: Merchant[],
  ) {
    this.store.accounts.transaction((db) => {
      this.store.assertOwner(db, owner);
      this.writeRecord(db, id, status, next, imported, snapshot);
    });
  }

  private writeRecord(
    db: DatabaseSync,
    id: string,
    status: z.infer<typeof sourceSchema>["status"],
    next: number,
    imported: number,
    snapshot?: Merchant[],
  ) {
    db.prepare(
      `
      INSERT INTO merchant_catalogue_sources VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at,
        next_refresh_at = excluded.next_refresh_at, imported = excluded.imported
      `,
    ).run(id, status, Date.now(), next, imported);
    if (snapshot)
      db.prepare(
        `
        INSERT INTO merchant_catalogue_snapshots VALUES (?, ?)
        ON CONFLICT(source_id) DO UPDATE SET definitions_json = excluded.definitions_json
      `,
      ).run(id, JSON.stringify(snapshot));
  }

  private ensureHistoricalPass(version: string, owner: string) {
    const users = this.store.accounts.read((db) =>
      db
        .prepare(
          `
      SELECT user_id FROM finance
      WHERE NOT EXISTS (SELECT 1 FROM automation_backfill_passes
        WHERE automation_backfill_passes.user_id = finance.user_id AND version = ?)
      AND NOT EXISTS (SELECT 1 FROM automation_jobs WHERE automation_jobs.user_id = finance.user_id
        AND kind = 'backfill' AND status NOT IN ('COMPLETED', 'FAILED'))
      ORDER BY user_id
    `,
        )
        .all(version),
    );
    for (const row of users)
      this.store.enqueueBackfill(z.string().parse(row.user_id), Date.now(), {
        onceVersion: version,
        workerOwner: owner,
      });
  }

  async maintain(
    signal: AbortSignal,
    owner: string,
  ): Promise<MerchantIndex | undefined> {
    const now = Date.now();
    if (now < this.nextCheck) return;
    this.nextCheck = now + 60_000;
    this.ensureHistoricalPass(MERCHANT_BACKFILL_VERSION, owner);
    // No names, amounts, references, user locations or bookings are sent upstream.
    const previous = new Map(
      sources(this.store.accounts).map((row) => [row.id, row]),
    );
    for (const row of previous.values())
      if (row.status === "current" && row.next_refresh_at > now)
        this.ensureHistoricalPass(
          `public-${row.id}-v3-${new Date(row.checked_at).toISOString().slice(0, 10)}`,
          owner,
        );
    const source = PUBLIC_MERCHANT_SOURCES.find(
      (item) => (previous.get(item.id)?.next_refresh_at ?? 0) <= now,
    );
    if (!source) return;
    this.record(owner, source.id, "refreshing", now + 10 * 60_000);
    let result: Awaited<ReturnType<typeof importOsmMerchants>>;
    try {
      result = await importOsmMerchants({
        bbox: source.bbox,
        fetch: this.request,
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      });
    } catch (error) {
      if (signal.aborted) return;
      this.record(owner, source.id, "unavailable", Date.now() + 60 * 60_000);
      console.warn(
        "Public merchant source unavailable:",
        source.id,
        error instanceof Error ? error.name : "UnknownError",
      );
      return;
    }
    const definitions = new Map(
      this.store.loadMerchants().map((merchant) => [merchant.id, merchant]),
    );
    const snapshots = new Map(
      this.store.accounts
        .read((db) =>
          db
            .prepare(
              "SELECT source_id, definitions_json FROM merchant_catalogue_snapshots",
            )
            .all(),
        )
        .map((row) => [
          z.string().parse(row.source_id),
          snapshotSchema.parse(
            JSON.parse(z.string().parse(row.definitions_json)),
          ),
        ]),
    );
    const managed = new Set(
      PUBLIC_MERCHANT_SOURCES.flatMap((item) =>
        (snapshots.get(item.id) ?? []).map((merchant) => merchant.id),
      ),
    );
    for (const row of this.store.accounts.read((db) =>
      db.prepare("SELECT merchant_id FROM merchant_catalogue_managed").all(),
    ))
      managed.add(z.string().parse(row.merchant_id));
    const externalSchema = z.object({
      merchant_id: z.string(),
      category: merchantSchema.shape.defaultCategory,
      requires_evidence: z.union([z.literal(0), z.literal(1)]),
      matchable: z.union([z.literal(0), z.literal(1)]),
    });
    const external = new Map(
      this.store.accounts
        .read((db) =>
          db.prepare("SELECT * FROM merchant_catalogue_external").all(),
        )
        .map((row) => {
          const fact = externalSchema.parse(row);
          return [fact.merchant_id, fact];
        }),
    );
    const newlyExternal: Merchant[] = [];
    for (const merchant of result.merchants) {
      const previous = definitions.get(merchant.id);
      if (
        previous?.source === "osm" &&
        !managed.has(previous.id) &&
        !external.has(previous.id)
      ) {
        newlyExternal.push(previous);
        external.set(previous.id, {
          merchant_id: previous.id,
          category: previous.defaultCategory,
          requires_evidence: previous.requiresCategoryEvidence ? 1 : 0,
          matchable: previous.matchable ? 1 : 0,
        });
      }
    }
    snapshots.set(source.id, result.merchants);
    const complete = PUBLIC_MERCHANT_SOURCES.every((item) =>
      snapshots.has(item.id),
    );
    const regional = new Map<string, Merchant>();
    for (const item of PUBLIC_MERCHANT_SOURCES)
      for (const merchant of snapshots.get(item.id) ?? []) {
        const existing = regional.get(merchant.id);
        regional.set(
          merchant.id,
          existing && merchant.id.startsWith("osm-brand-")
            ? mergeOsmBrand(existing, merchant)
            : !existing || merchant.updatedAt > existing.updatedAt
              ? merchant
              : existing,
        );
      }
    const accepted = [...regional.values()]
      .map((merchant) => {
        const previous = definitions.get(merchant.id);
        const fresh = {
          ...merchant,
          updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1),
        };
        const outside = external.get(merchant.id);
        if (outside?.matchable) {
          fresh.defaultCategory =
            outside.category === fresh.defaultCategory
              ? fresh.defaultCategory
              : null;
          fresh.requiresCategoryEvidence ||=
            !!outside.requires_evidence || fresh.defaultCategory === null;
        }
        // A complete regional rebuild repairs old lossy brand merges. Until then,
        // retain unknown historical conflicts instead of trusting a partial tile.
        return !complete &&
          previous?.source === "osm" &&
          merchant.id.startsWith("osm-brand-")
          ? mergeOsmBrand(previous, fresh)
          : fresh;
      })
      .filter((merchant) => {
        const previous = definitions.get(merchant.id);
        return (
          !previous ||
          JSON.stringify({ ...previous, updatedAt: 0, logo: null }) !==
            JSON.stringify({ ...merchant, updatedAt: 0, logo: null })
        );
      });
    if (complete)
      for (const id of managed) {
        const previous = definitions.get(id);
        if (
          !regional.has(id) &&
          previous?.matchable &&
          !external.get(id)?.matchable
        )
          accepted.push({
            ...previous,
            matchable: false,
            updatedAt: Math.max(Date.now(), previous.updatedAt + 1),
          });
      }
    for (const merchant of accepted) definitions.set(merchant.id, merchant);
    try {
      new MerchantIndex([...definitions.values()]);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      this.record(owner, source.id, "unavailable", Date.now() + 60 * 60_000);
      console.warn("Public merchant catalogue capacity exceeded:", source.id);
      return;
    }
    this.store.upsertMerchants(accepted, {
      workerOwner: owner,
      checkpoint: (db) => {
        for (const merchant of newlyExternal)
          db.prepare(
            "INSERT OR IGNORE INTO merchant_catalogue_external VALUES (?, ?, ?, ?)",
          ).run(
            merchant.id,
            merchant.defaultCategory,
            merchant.requiresCategoryEvidence ? 1 : 0,
            merchant.matchable ? 1 : 0,
          );
        for (const id of new Set([
          ...managed,
          ...result.merchants.map((merchant) => merchant.id),
        ]))
          db.prepare(
            "INSERT OR IGNORE INTO merchant_catalogue_managed VALUES (?)",
          ).run(id);
        this.writeRecord(
          db,
          source.id,
          "current",
          Date.now() + DAY,
          result.merchants.length,
          result.merchants,
        );
      },
    });
    this.ensureHistoricalPass(
      `public-${source.id}-v3-${new Date().toISOString().slice(0, 10)}`,
      owner,
    );
    return new MerchantIndex(this.store.loadMerchants());
  }
}
