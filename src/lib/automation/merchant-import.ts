import { createHash } from "node:crypto";
import { z } from "zod";
import {
  merchantSchema,
  normalizeMerchantText,
  type Merchant,
} from "./merchants";
import { fetchMerchantJson, retrieveMerchantLogo } from "./merchant-logo";

export const MAX_IMPORTED_MERCHANTS = 10_000;
export const MAX_OSM_ELEMENTS = 1000;
export const MAX_LOGO_ENTITIES = 20;
export type MerchantBbox = [number, number, number, number];
export interface MerchantImportReport {
  elements: number;
  imported: number;
  skippedCount: number;
  aliasSkippedCount: number;
  logoDownloadedCount: number;
  logoSkippedCount: number;
  skipped: { id: string; reason: string }[];
  logos: {
    id: string;
    status: "downloaded" | "skipped";
    reason?: string;
  }[];
}
export interface MerchantImportResult {
  merchants: Merchant[];
  report: MerchantImportReport;
}

export function parseMerchantBbox(value: string): MerchantBbox {
  const parts = value.split(",");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^-?\d+(?:\.\d+)?$/.test(part.trim()))
  )
    throw new Error(
      "Use --bbox south,west,north,east with four numeric coordinates",
    );
  const bbox = parts.map(Number) as MerchantBbox;
  validateMerchantBbox(bbox);
  return bbox;
}

export function validateMerchantBbox(bbox: MerchantBbox): void {
  if (
    bbox.length !== 4 ||
    !bbox.every(Number.isFinite) ||
    bbox[0] < 46.3 ||
    bbox[2] > 49.1 ||
    bbox[1] < 9.5 ||
    bbox[3] > 17.2 ||
    bbox[0] >= bbox[2] ||
    bbox[1] >= bbox[3] ||
    bbox[2] - bbox[0] > 1 ||
    bbox[3] - bbox[1] > 1 ||
    (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > 0.25
  )
    throw new Error(
      "BBox must be within Austria's envelope, at most 1 degree per side and 0.25 square degrees; use smaller tiles",
    );
}

export function merchantOverpassQuery(bbox: MerchantBbox): string {
  validateMerchantBbox(bbox);
  return `[out:json][timeout:20][maxsize:8388608];
area["ISO3166-1"="AT"]["admin_level"="2"]->.austria;
(
  nwr["shop"]["name"](area.austria)(${bbox.join(",")});
  nwr["amenity"]["name"](area.austria)(${bbox.join(",")});
  nwr["tourism"]["name"](area.austria)(${bbox.join(",")});
);
out tags ${MAX_OSM_ELEMENTS + 1};`;
}

const responseSchema = z.object({
  version: z.number(),
  osm3s: z.object({
    copyright: z.string().max(2000),
  }),
  remark: z.string().max(4000).optional(),
  elements: z
    .array(
      z.object({
        type: z.enum(["node", "way", "relation"]),
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        tags: z.record(z.string().max(100), z.string().max(2000)),
      }),
    )
    .max(MAX_OSM_ELEMENTS + 1),
});

const shopCategories: Record<string, Merchant["defaultCategory"]> = {
  supermarket: "Lebensmittel",
  convenience: "Lebensmittel",
  greengrocer: "Lebensmittel",
  butcher: "Lebensmittel",
  seafood: "Lebensmittel",
  chemist: "Drogerie",
  hairdresser: "Körperpflege",
  optician: "Gesundheit",
  pet: "Haustiere",
  furniture: "Möbel & Einrichtung",
};
const amenityCategories: Record<string, Merchant["defaultCategory"]> = {
  restaurant: "Restaurants",
  cafe: "Cafés & Snacks",
  pharmacy: "Gesundheit",
  doctors: "Gesundheit",
  dentist: "Gesundheit",
  veterinary: "Haustiere",
  fuel: "Tanken",
  cinema: "Entertainment",
};
const tourismCategories: Record<string, Merchant["defaultCategory"]> = {
  hotel: "Urlaub",
  motel: "Urlaub",
  guest_house: "Urlaub",
  hostel: "Urlaub",
};

export function osmMerchantCategory(
  tags: Record<string, string>,
): Merchant["defaultCategory"] {
  const matches = new Set(
    [
      Object.hasOwn(shopCategories, tags.shop)
        ? shopCategories[tags.shop]
        : null,
      Object.hasOwn(amenityCategories, tags.amenity)
        ? amenityCategories[tags.amenity]
        : null,
      Object.hasOwn(tourismCategories, tags.tourism)
        ? tourismCategories[tags.tourism]
        : null,
    ].filter((category) => category != null),
  );
  return matches.size === 1 ? [...matches][0] : null;
}

const qid = (value: string | undefined): string | null =>
  value && /^Q[1-9]\d{0,11}$/.test(value) ? value : null;

export function parseOsmMerchants(
  input: unknown,
  updatedAt = Date.now(),
): MerchantImportResult & { entities: Map<string, string> } {
  const response = responseSchema.parse(input);
  if (response.remark)
    throw new Error(`Overpass reported incomplete data: ${response.remark}`);
  if (response.elements.length > MAX_OSM_ELEMENTS)
    throw new Error("OSM record limit exceeded; repeat with a smaller bbox");
  const merchants = new Map<string, Merchant>();
  const entities = new Map<string, string>();
  const seen = new Set<string>();
  const report: MerchantImportReport = {
    elements: response.elements.length,
    imported: 0,
    skippedCount: 0,
    aliasSkippedCount: 0,
    logoDownloadedCount: 0,
    logoSkippedCount: 0,
    skipped: [],
    logos: [],
  };
  const elements = [...response.elements].sort((left, right) =>
    `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`),
  );
  for (const element of elements) {
    const osmId = `${element.type}/${element.id}`;
    if (seen.has(osmId))
      throw new Error("Overpass returned duplicate OSM identities");
    seen.add(osmId);
    const tags = element.tags;
    if (!tags.name || !(tags.shop || tags.amenity || tags.tourism)) {
      report.skipped.push({ id: osmId, reason: "Missing merchant name/type" });
      continue;
    }
    if (tags["addr:country"] && tags["addr:country"].toUpperCase() !== "AT") {
      report.skipped.push({
        id: osmId,
        reason: "Explicit non-Austrian address",
      });
      continue;
    }
    const canonicalName = tags.name.trim();
    const brandId = qid(tags["brand:wikidata"]);
    const brandEvidence =
      brandId &&
      tags.brand &&
      normalizeMerchantText(tags.brand) ===
        normalizeMerchantText(canonicalName);
    // Same names alone never collapse outlets; a brand entity AND matching label do.
    const id = brandEvidence
      ? `osm-brand-${brandId}-${createHash("sha256")
          .update(normalizeMerchantText(canonicalName))
          .digest("hex")
          .slice(0, 16)}`
      : `osm-${element.type}-${element.id}`;
    const city = tags["addr:city"]?.trim() || null;
    const aliasCandidates = [...new Set(
      [tags.alt_name, tags.short_name, tags.official_name]
        .flatMap(value => value?.split(";") ?? []).map(value => value.trim())
        .filter(value => value && value !== canonicalName),
    )];
    const validAliases = aliasCandidates.filter(value => merchantSchema.shape.aliases.element.safeParse(value).success);
    const aliases = validAliases.slice(0, 32);
    report.aliasSkippedCount += aliasCandidates.length - aliases.length;
    const parsed = merchantSchema.safeParse({
      id,
      canonicalName,
      aliases,
      regexPatterns: [],
      defaultCategory: osmMerchantCategory(tags),
      region: "AT",
      city,
      source: "osm",
      license: "ODbL-1.0",
      attribution:
        "© OpenStreetMap contributors; https://www.openstreetmap.org/copyright",
      logo: null,
      updatedAt,
    });
    if (!parsed.success) {
      report.skipped.push({
        id: osmId,
        reason: "Name or metadata fails merchant schema",
      });
      continue;
    }
    const previous = merchants.get(id);
    if (previous) {
      const merged = [...new Set([...previous.aliases, ...parsed.data.aliases])];
      report.aliasSkippedCount += Math.max(0, merged.length - 32);
      previous.aliases = merged.slice(0, 32);
      if (previous.defaultCategory !== parsed.data.defaultCategory)
        previous.defaultCategory = null;
      if (previous.city !== parsed.data.city) previous.city = null;
    } else merchants.set(id, parsed.data);
    const entity = brandEvidence ? brandId : qid(tags.wikidata);
    if (entity) entities.set(id, entity);
  }
  report.imported = merchants.size;
  report.skippedCount = report.skipped.length;
  return { merchants: [...merchants.values()], entities, report };
}

/** Operator-only: callers pass geography, never descriptions or account data. */
export async function importOsmMerchants(options: {
  bbox: MerchantBbox;
  databasePath?: string;
  logos?: boolean;
  updatedAt?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<MerchantImportResult> {
  const query = merchantOverpassQuery(options.bbox);
  if (options.logos && !options.databasePath)
    throw new Error("Private database path is required for logo downloads");
  const deadline = AbortSignal.timeout(180_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  const data = await fetchMerchantJson(
    "https://overpass-api.de/api/interpreter",
    {
      fetch: options.fetch,
      signal,
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 25_000,
      body: new URLSearchParams({ data: query }).toString(),
    },
  );
  const result = parseOsmMerchants(data, options.updatedAt);
  if (options.logos) {
    const cache = new Map<
      string,
      Awaited<ReturnType<typeof retrieveMerchantLogo>>
    >();
    for (const merchant of result.merchants) {
      signal.throwIfAborted();
      const entity = result.entities.get(merchant.id);
      if (!entity) {
        result.report.logos.push({
          id: merchant.id,
          status: "skipped",
          reason: "No unambiguous associated Wikidata entity",
        });
        continue;
      }
      if (!cache.has(entity)) {
        if (cache.size >= MAX_LOGO_ENTITIES) {
          result.report.logos.push({
            id: merchant.id,
            status: "skipped",
            reason: `Logo entity limit (${MAX_LOGO_ENTITIES}) reached`,
          });
          continue;
        }
        cache.set(
          entity,
          await retrieveMerchantLogo(entity, options.databasePath!, {
            fetch: options.fetch,
            signal,
          }),
        );
      }
      const logo = cache.get(entity)!;
      if (logo.status === "downloaded") merchant.logo = logo.logo;
      result.report.logos.push({
        id: merchant.id,
        status: logo.status,
        ...(logo.status === "skipped" ? { reason: logo.reason } : {}),
      });
    }
  }
  result.report.logoDownloadedCount = result.report.logos.filter(
    (logo) => logo.status === "downloaded",
  ).length;
  result.report.logoSkippedCount =
    result.report.logos.length - result.report.logoDownloadedCount;
  return { merchants: result.merchants, report: result.report };
}
