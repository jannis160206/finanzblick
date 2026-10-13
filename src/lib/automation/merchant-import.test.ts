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
  mergeOsmBrand,
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
  it.each([false, true])("never mixes a branded free car park into a shop aggregate (reverse: %s)", (reverse) => {
    const features = [
      element(1, { name: "BILLA", brand: "BILLA", "brand:wikidata": "Q537781", shop: "supermarket" }),
      element(2, { name: "BILLA", brand: "BILLA", "brand:wikidata": "Q537781", amenity: "parking", fee: "no" }),
    ];
    const { merchants } = parseOsmMerchants(payload(reverse ? features.reverse() : features));
    expect(merchants).toHaveLength(2);
    const shop = merchants.find((merchant) => merchant.matchable)!;
    expect(shop.defaultCategory).toBe("Lebensmittel");
    expect(shop.id).toMatch(/^osm-brand-/);
    expect(merchants.find((merchant) => !merchant.matchable)?.id).toBe("osm-node-2");
    expect(new MerchantIndex(merchants).match("BILLA").merchant?.defaultCategory).toBe("Lebensmittel");
    expect(osmMerchantCategory({ shop: "supermarket", amenity: "parking", fee: "no" }))
      .toBe("Lebensmittel");
  });
  it("keeps public feature metadata but never matches a free store car park as that store's merchant", () => {
    const features = parseOsmMerchants(payload([
      element(1, { name: "BILLA", amenity: "parking", fee: "no" }),
      element(2, { name: "Paid Garage", amenity: "parking", fee: "yes" }),
      element(3, { name: "Local School", amenity: "school" }),
    ])).merchants;
    expect(features[0].matchable).toBe(false);
    expect(features[1].matchable).toBe(true);
    expect(features[2].matchable).toBe(false);
    expect(new MerchantIndex(features).match("BILLA").method).toBe("none");
    expect(new MerchantIndex(features).match("Paid Garage").merchant?.defaultCategory).toBe("Parken & Maut");
  });
  it("retains conflicting brand purposes and aliases across independently imported city tiles", () => {
    const one = parseOsmMerchants(payload([element(1, {
      name: "Public Brand", brand: "Public Brand", "brand:wikidata": "Q123",
      shop: "clothes", alt_name: "Public Clothing",
    })]), 1).merchants[0];
    const two = parseOsmMerchants(payload([element(2, {
      name: "Public Brand", brand: "Public Brand", "brand:wikidata": "Q123",
      shop: "supermarket", alt_name: "Public Grocery",
    })]), 2).merchants[0];
    const merged = mergeOsmBrand(one, two);
    expect(merged).toMatchObject({ defaultCategory: null, requiresCategoryEvidence: true });
    expect(merged.aliases).toEqual(["Public Clothing", "Public Grocery"]);
    expect(new MerchantIndex([merged]).match("Public Brand").requiresManualReview).toBe(true);
  });
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
    expect(query).toContain(
      'nwr["leisure"~"^(fitness_centre|sports_centre|swimming_pool)$"]["name"](area.austria)(48.18,16.33,48.22,16.39)',
    );
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
        "entity",
        "property",
        "format",
      ]);
      expect(target.searchParams.get("property")).toBe("P154");
      expect(target.searchParams.get("entity")).toMatch(/^Q\d+$/);
      return json({ claims: {} });
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
  it.each([
    [{ shop: "clothes" }, "Shopping", false],
    [{ shop: "shoes" }, "Shopping", false],
    [{ shop: "bakery" }, "Lebensmittel", false],
    [{ shop: "books" }, "Bildung", false],
    [{ shop: "cosmetics" }, "Drogerie", false],
    [{ shop: "sports" }, "Sport & Fitness", false],
    [{ shop: "department_store" }, "Shopping", true],
    [{ shop: "mobile_phone" }, "Telefon & Internet", true],
    [{ shop: "hardware" }, "Reparaturen & Instandhaltung", true],
    [{ shop: "garden_centre" }, "Wohnen & Haushalt", true],
    [{ shop: "unknown" }, null, true],
    [{ tourism: "hotel" }, "Urlaub", true],
    [{ tourism: "museum" }, "Freizeit", false],
    [{ amenity: "driving_school" }, "Bildung", false],
    [{ amenity: "parking" }, "Parken & Maut", false],
    [{ amenity: "car_wash" }, "Fahrzeugwartung", false],
    [{ leisure: "fitness_centre" }, "Sport & Fitness", false],
    [{ leisure: "swimming_pool" }, "Freizeit", false],
  ])(
    "maps the explicit public type %j to an existing purpose with appropriate review protection",
    (tags, category, review) => {
      expect(osmMerchantCategory(tags)).toBe(category);
      expect(
        parseOsmMerchants(
          payload([element(1, { name: "Public Example", ...tags })]),
        ).merchants[0],
      ).toMatchObject({
        defaultCategory: category,
        requiresCategoryEvidence: review,
      });
    },
  );

  it("keeps conflicting shop, tourism and leisure purposes open and does not import unnamed leisure places", () => {
    expect(
      osmMerchantCategory({ shop: "books", leisure: "fitness_centre" }),
    ).toBeNull();
    expect(osmMerchantCategory({ shop: "bakery", amenity: "cafe" })).toBeNull();
    expect(
      parseOsmMerchants(
        payload([
          element(1, { name: "Public Park", leisure: "park" }),
          element(2, { leisure: "fitness_centre" }),
        ]),
      ).merchants,
    ).toEqual([]);
  });

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
