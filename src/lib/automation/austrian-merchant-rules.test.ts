import { describe, expect, it } from "vitest";
import { transactionSchema } from "@/lib/types";
import { reviewedAustrianMerchants } from "./austrian-merchant-rules";
import {
  MerchantIndex,
  normalizeMerchantText,
  seedMerchants,
} from "./merchants";
import { enrichTransaction } from "./pipeline";
import { parseOsmMerchants } from "./merchant-import";

const index = new MerchantIndex(seedMerchants);
const booking = (description: string) =>
  transactionSchema.parse({
    id: "public-austrian-example",
    description,
    date: "2026-10-11",
    bank: "Amex",
    pocket: "Amex",
    amount: -25,
    category: "Prüfen",
    includeInPlan: true,
  });

describe("expanded Austrian public purpose references", () => {
  it("keeps reference IDs, categories and provenance in the existing catalogue", () => {
    const seeds = new Map(
      seedMerchants.map((merchant) => [merchant.id, merchant]),
    );
    expect(
      new Set(reviewedAustrianMerchants.map((merchant) => merchant.id)).size,
    ).toBe(reviewedAustrianMerchants.length);
    for (const review of reviewedAustrianMerchants) {
      expect(seeds.get(review.id)).toMatchObject({
        canonicalName: review.canonicalName,
        defaultCategory: review.category,
        wikidataId: review.wikidataId,
        requiresCategoryEvidence: review.requiresCategoryEvidence ?? false,
      });
      expect(seeds.get(review.id)?.attribution).toContain(review.evidenceUrl);
    }
  });

  it.each([
    ["Humanic", "Shopping"],
    ["Palmers", "Shopping"],
    ["Hervis", "Sport & Fitness"],
    ["Douglas", "Drogerie"],
    ["Marionnaud", "Drogerie"],
    ["JYSK", "Möbel & Einrichtung"],
    ["Graz Linien", "Öffentliche Verkehrsmittel"],
    ["Takko", "Shopping"],
    ["Nah&Frisch", "Lebensmittel"],
    ["UNIMARKT", "Lebensmittel"],
    ["PROSI", "Lebensmittel"],
    ["Gigasport", "Sport & Fitness"],
    ["Kleiderbauer", "Shopping"],
    ["Joseph Brot", "Cafés & Snacks"],
    ["Kärntner Linien", "Öffentliche Verkehrsmittel"],
    ["VVT", "Öffentliche Verkehrsmittel"],
    ["Badner Bahn", "Öffentliche Verkehrsmittel"],
    ["Burgschenke Finkenstein", "Restaurants"],
    ["Die Kaffeemacher Schwaz", "Cafés & Snacks"],
  ])("assigns the concrete existing purpose for %s", (name, category) => {
    expect(enrichTransaction(booking(name), index)).toMatchObject({
      category,
      requires_manual_review: false,
      merchantId: expect.any(String),
    });
  });

  it.each([
    "LIBRO",
    "Hartlauer",
    "Tchibo",
    "Forstinger",
    "Wien Energie",
    "Verbund",
    "KELAG",
    "TIWAG",
    "Manner",
    "Zotter",
    "Zgonc",
    "PAGRO",
    "Salzburg AG",
    "LINZ AG",
    "PACE Telematics",
    "ME Group Austria",
    "ATRIO Villach",
  ])("retains purchase review for the multipurpose reference %s", (name) => {
    expect(enrichTransaction(booking(name), index)).toMatchObject({
      merchantId: expect.any(String),
      requires_manual_review: true,
    });
  });

  it("keeps bank99 distinct from bank names and branch-number cleanup", () => {
    expect(normalizeMerchantText("bank99")).toBe("bank99");
    expect(normalizeMerchantText("BILLA12345")).toBe("billa");
    expect(index.match("bank99 AG")).toMatchObject({
      merchant: { id: "at-bank99" },
    });
    for (const name of [
      "Erste Bank",
      "Bank Austria",
      "BKS Bank",
      "DADAT Bank",
    ]) {
      expect(index.match(name), name).toMatchObject({
        method: "exact",
        merchant: { defaultCategory: null },
      });
      expect(enrichTransaction(booking(name), index)).toMatchObject({
        requires_manual_review: true,
      });
    }
    expect(index.match("bank").merchant).toBeUndefined();
  });

  it.each(["at-erste-bank", "at-bank-austria"])(
    "preserves compatible OSM bank identities and explicit fee purpose for %s",
    (id) => {
      const seed = seedMerchants.find((merchant) => merchant.id === id);
      if (!seed || !seed.wikidataId)
        throw new Error("Missing reviewed bank seed");
      const [osm] = parseOsmMerchants(
        {
          version: 0.6,
          osm3s: { copyright: "OpenStreetMap contributors" },
          elements: [
            {
              type: "node",
              id: 1,
              tags: {
                name: seed.canonicalName,
                brand: seed.canonicalName,
                "brand:wikidata": seed.wikidataId,
                amenity: "bank",
              },
            },
          ],
        },
        1,
      ).merchants;
      expect(osm.requiresCategoryEvidence).toBe(true);
      const banks = new MerchantIndex([...seedMerchants, osm]);
      expect(
        enrichTransaction(booking(osm.canonicalName), banks)
          .requires_manual_review,
      ).toBe(true);
      const fee = enrichTransaction(
        booking(`${osm.canonicalName} Kontoführungsgebühr`),
        banks,
      );
      expect(fee).toMatchObject({
        category: "Bankgebühren",
        merchantLogo: false,
        requires_manual_review: false,
      });
      expect(fee.merchantId).toBeUndefined();
    },
  );

  it.each(["Porsche Bank", "MPREIS Baguette", "Müller Glas"])(
    "does not silently prefer a nested identity for %s",
    (name) => {
      expect(index.match(name)).toEqual({
        method: "exact",
        requiresManualReview: true,
      });
    },
  );

  // "Trafik Haas" is deliberately a high-confidence silent rule (precise-import.test.ts).
  it.each([
    "NYX MyElite",
    "Kärnten Stand",
    "KaffeeMacher",
    "CTS Eventima",
    "Kinguindigi",
    "OCH Auto Dus",
    "GeneralLogi",
    "Bäckerei Schwarz",
    "Jones Fashion",
  ])(
    "does not turn an unverified public fragment into an exact identity: %s",
    (name) => {
      expect(index.match(name).merchant).toBeUndefined();
      expect(
        enrichTransaction(booking(name), index).requires_manual_review,
      ).toBe(true);
    },
  );

  it("does not change manual corrections or promote fuzzy and conflicting identities", () => {
    const locked = {
      ...booking("Humanic"),
      is_locked: true,
      category: "Geschenke & Spenden" as const,
    };
    expect(enrichTransaction(locked, index)).toEqual(locked);
    expect(
      enrichTransaction(booking("Humanic Palmers"), index)
        .requires_manual_review,
    ).toBe(true);
    expect(
      enrichTransaction(booking("Humannic"), index).requires_manual_review,
    ).toBe(true);
  });
});
