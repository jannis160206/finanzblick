import { describe, expect, it, vi } from "vitest";
import { MerchantIndex } from "./merchants";
import {
  importOsmMerchants,
  MAX_LOGO_ENTITIES,
  MAX_OSM_ELEMENTS,
  merchantOverpassQuery,
  osmMerchantCategory,
  parseMerchantBbox,
  parseOsmMerchants,
} from "./merchant-import";

const element = (
  id: number,
  tags: Record<string, string> = { name: "Test Shop", shop: "supermarket" },
) => ({ type: "node", id, tags });
const payload = (elements: unknown[], extras = {}) => ({
  version: 0.6,
  osm3s: { copyright: "© OpenStreetMap contributors" },
  elements,
  ...extras,
});
const json = (value: unknown) => Response.json(value);
const bbox: [number, number, number, number] = [48.18, 16.33, 48.22, 16.39];

describe("bounded Austrian operator import", () => {
  it("requires four numeric coordinates and a small Austrian-envelope tile", () => {
    expect(parseMerchantBbox("48.18,16.33,48.22,16.39")).toEqual(bbox);
    for (const invalid of [
      "",
      "48,16,49",
      "48,16,49,17,18",
      "NaN,16,48.2,16.2",
      "48,16,Infinity,17",
      "48,16,48.2,16.2);out;",
      "48,16,47,17",
      "48,16,48,17",
      "45,16,46,17",
      "48,8,48.2,8.2",
      "48,16,49,17",
      "48,16,48.1,17.2",
    ])
      expect(() => parseMerchantBbox(invalid)).toThrow();
  });

  it("requires purchase-purpose evidence for fuel references rather than guessing at station shops", () => {
    const parsed = parseOsmMerchants(
      payload([element(7, { name: "Test Tankstelle", amenity: "fuel" })]),
      10,
    );
    expect(parsed.merchants[0]).toMatchObject({
      defaultCategory: "Tanken",
      requiresCategoryEvidence: true,
    });
  });

  it("intersects each shop/amenity/tourism selection with the AT area and bbox", () => {
    const query = merchantOverpassQuery(bbox);
    expect(query).toContain('area["ISO3166-1"="AT"]["admin_level"="2"]');
    for (const type of ["shop", "amenity", "tourism"])
      expect(query).toContain(
        `nwr["${type}"]["name"](area.austria)(48.18,16.33,48.22,16.39)`,
      );
    expect(query).toContain("out tags 1001");
    expect(query).not.toMatch(/https?:|statement|transaction|account/i);
  });

  it("makes only a fixed Overpass POST with geography and bounded options", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json(payload([element(1)])));
    const result = await importOsmMerchants({
      bbox,
      fetch: request,
      updatedAt: 10,
    });
    expect(result.merchants[0]).toMatchObject({
      id: "osm-node-1",
      canonicalName: "Test Shop",
      defaultCategory: "Lebensmittel",
      source: "osm",
      region: "AT",
      city: null,
      license: "ODbL-1.0",
      logo: null,
      updatedAt: 10,
      regexPatterns: [],
      aliases: [],
    });
    expect(result.merchants[0].attribution).toContain(
      "OpenStreetMap contributors",
    );
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(String(url)).toBe("https://overpass-api.de/api/interpreter");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
    });
    expect(new URLSearchParams(String(init?.body)).get("data")).toBe(
      merchantOverpassQuery(bbox),
    );
  });

  it("fails non-2xx, invalid JSON/schema and explicitly incomplete responses", async () => {
    for (const response of [
      new Response("unavailable", { status: 503 }),
      new Response("not json"),
      json({ elements: [] }),
      json(payload([], { remark: "runtime error: timed out" })),
      json(payload([element(1), element(1)])),
      json(
        payload(
          Array.from({ length: MAX_OSM_ELEMENTS + 1 }, (_, index) =>
            element(index + 1),
          ),
        ),
      ),
    ]) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(
        importOsmMerchants({ bbox, fetch: request }),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects invalid configuration without making network requests", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      importOsmMerchants({ bbox, logos: true, fetch: request }),
    ).rejects.toThrow("Private database path");
    await expect(
      importOsmMerchants({
        bbox: [0, 0, 1, 1],
        fetch: request,
      }),
    ).rejects.toThrow("BBox");
    expect(request).not.toHaveBeenCalled();
  });

  it("limits unique logo entity requests, reports every skip and sends no account data", async () => {
    const elements = Array.from({ length: MAX_LOGO_ENTITIES + 2 }, (_, index) =>
      element(index + 1, {
        name: `Unique ${String.fromCharCode(65 + index)}`,
        shop: "supermarket",
        wikidata: `Q${index + 1}`,
      }),
    );
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const target = new URL(String(url));
      if (target.hostname === "overpass-api.de") return json(payload(elements));
      expect(target.hostname).toBe("www.wikidata.org");
      expect([...target.searchParams.keys()]).toEqual([
        "action",
        "ids",
        "props",
        "format",
      ]);
      const id = target.searchParams.get("ids")!;
      return json({ entities: { [id]: { claims: {} } } });
    });
    const result = await importOsmMerchants({
      bbox,
      fetch: request,
      logos: true,
      databasePath: "private.sqlite",
    });
    expect(request).toHaveBeenCalledTimes(MAX_LOGO_ENTITIES + 1);
    expect(result.report.logos).toHaveLength(MAX_LOGO_ENTITIES + 2);
    expect(result.report.logoDownloadedCount).toBe(0);
    expect(result.report.logoSkippedCount).toBe(MAX_LOGO_ENTITIES + 2);
    expect(
      result.report.logos.filter((item) => item.reason?.includes("limit")),
    ).toHaveLength(2);
    expect(result.report.logos.every((item) => item.status === "skipped")).toBe(
      true,
    );
  });
});

describe("conservative OSM identities and categories", () => {
  it("indexes explicit alternative names and reports unsafe alternatives", () => {
    const { merchants, report } = parseOsmMerchants(
      payload([
        element(1, {
          name: "Nordlicht Laden",
          shop: "supermarket",
          alt_name: "Nordlicht Markt; PayPal; Nordlicht Markt",
          short_name: "Nordlicht",
          official_name: "Nordlicht Laden",
        }),
      ]),
      1,
    );
    expect(merchants[0].aliases).toEqual(["Nordlicht Markt", "Nordlicht"]);
    expect(report.aliasSkippedCount).toBe(1);
    expect(
      new MerchantIndex(merchants).match("POS Nordlicht Markt 1234"),
    ).toMatchObject({
      method: "exact",
      merchant: { id: "osm-node-1" },
      requiresManualReview: false,
    });
  });

  it("keeps repeated ordinary names distinct and collision-prone", () => {
    const { merchants } = parseOsmMerchants(
      payload([element(1), element(2)]),
      1,
    );
    expect(merchants.map((merchant) => merchant.id)).toEqual([
      "osm-node-1",
      "osm-node-2",
    ]);
    const match = new MerchantIndex(merchants).match("Test Shop");
    expect(match.requiresManualReview).toBe(true);
    expect(match.merchant).toBeUndefined();
  });

  it("only collapses outlets with matching brand entity AND matching brand/name label", () => {
    const brand = {
      name: "Test Chain",
      brand: "Test Chain",
      "brand:wikidata": "Q123",
      shop: "supermarket",
    };
    const first = parseOsmMerchants(
      payload([
        element(1, { ...brand, "addr:city": "Wien" }),
        element(2, { ...brand, "addr:city": "Graz" }),
      ]),
      7,
    );
    expect(first.merchants).toHaveLength(1);
    expect(first.merchants[0].id).toMatch(/^osm-brand-Q123-[a-f0-9]{16}$/);
    expect(first.merchants[0].city).toBeNull();
    expect(first.entities.get(first.merchants[0].id)).toBe("Q123");
    const repeat = parseOsmMerchants(payload([element(2, brand)]), 8);
    expect(repeat.merchants[0].id).toBe(first.merchants[0].id);
    const different = parseOsmMerchants(
      payload([
        element(1, brand),
        element(2, { ...brand, name: "Test Chain Plus" }),
        element(3, { ...brand, "brand:wikidata": "Q456" }),
        element(4, { ...brand, "brand:wikidata": "Q123;Q456" }),
        element(5, { ...brand, brand: "" }),
      ]),
    );
    expect(different.merchants).toHaveLength(5);
  });

  it("does not mistake an outlet wikidata identity for evidence to merge different outlets", () => {
    const tags = { name: "Common Hotel", tourism: "hotel", wikidata: "Q123" };
    const { merchants } = parseOsmMerchants(
      payload([element(1, tags), element(2, tags)]),
    );
    expect(merchants).toHaveLength(2);
  });

  it("maps only conservative current categories and rejects conflicting types", () => {
    expect(osmMerchantCategory({ shop: "supermarket" })).toBe("Lebensmittel");
    expect(osmMerchantCategory({ amenity: "fuel" })).toBe("Tanken");
    expect(osmMerchantCategory({ tourism: "hotel" })).toBe("Urlaub");
    expect(osmMerchantCategory({ shop: "unknown" })).toBeNull();
    expect(osmMerchantCategory({ shop: "constructor" })).toBeNull();
    expect(osmMerchantCategory({ shop: "__proto__" })).toBeNull();
    expect(
      osmMerchantCategory({ shop: "supermarket", amenity: "restaurant" }),
    ).toBeNull();
    const brand = {
      name: "Test Chain",
      brand: "Test Chain",
      "brand:wikidata": "Q123",
    };
    const { merchants } = parseOsmMerchants(
      payload([
        element(1, { ...brand, shop: "supermarket" }),
        element(2, { ...brand, shop: "chemist" }),
      ]),
    );
    expect(merchants[0].defaultCategory).toBeNull();
  });

  it("reports invalid/provider names and foreign addresses, never inventing aliases", () => {
    const result = parseOsmMerchants(
      payload([
        element(1, { shop: "supermarket" }),
        element(2, { name: "PayPal", shop: "supermarket" }),
        element(3, {
          name: "Foreign Shop",
          shop: "supermarket",
          "addr:country": "DE",
        }),
        element(4, {
          name: "Valid Shop",
          shop: "unknown",
          alt_name: "PayPal",
          "addr:city": "Wien",
        }),
      ]),
    );
    expect(result.merchants).toHaveLength(1);
    expect(result.merchants[0]).toMatchObject({
      aliases: [],
      defaultCategory: null,
      city: "Wien",
    });
    expect(result.report.skipped).toHaveLength(3);
    expect(result.report.skippedCount).toBe(3);
  });
});
