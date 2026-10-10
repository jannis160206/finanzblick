import { describe, expect, it } from "vitest";
import { categories } from "@/lib/categories";
import type { Transaction } from "@/lib/types";
import { merchantEvidence } from "./evidence";
import { expandedMerchantIdentities } from "./merchant-expansion";
import {
  MerchantIndex,
  merchantSchema,
  normalizeMerchantText,
  seedMerchants,
} from "./merchants";

const definitions = expandedMerchantIdentities.map((identity) => ({
  ...identity,
  aliases: [...identity.aliases],
  regexPatterns: [],
  region: "AT",
  source: "local",
  requiresCategoryEvidence: true,
  updatedAt: 0,
}));

describe("expanded verified public merchant identities", () => {
  it("keeps exhausted fuzzy evidence ambiguous instead of accepting a conflicting named merchant", () => {
    const index = new MerchantIndex(seedMerchants);
    const row: Transaction = {
      id: "expanded-budget-conflict",
      date: "2026-10-09",
      bank: "Amex",
      pocket: "Amex",
      description: "Marin Auer Wien",
      rawDetails: ["Merchant: BILLA"],
      amount: -10,
      category: "Prüfen",
      includeInPlan: true,
    };
    expect(index.match(row.description)).toEqual({
      method: "fuzzy",
      requiresManualReview: true,
    });
    expect(merchantEvidence(row, index)).toEqual({ kind: "conflict" });
  });

  it("wires every new identity into the existing single seed catalogue without category inference", () => {
    const seeds = new Map(
      seedMerchants.map((merchant) => [merchant.id, merchant]),
    );
    const index = new MerchantIndex(seedMerchants);
    for (const identity of expandedMerchantIdentities) {
      expect(seeds.get(identity.id)).toMatchObject({
        wikidataId: identity.wikidataId,
        source: "local",
        logo: null,
        defaultCategory: null,
        requiresCategoryEvidence: true,
      });
    }
    for (const name of [
      "LIBRO",
      "Hartlauer",
      "Hervis",
      "ASFINAG",
      "easybank",
      "JetBrains",
      "Levis",
      "DKB",
      "Hilton",
    ]) {
      expect(index.match(name).merchant?.id).toBe(
        expandedMerchantIdentities.find((identity) =>
          [identity.canonicalName, ...identity.aliases].includes(name),
        )?.id,
      );
    }
    expect(index.match("Apple Music").merchant).toBeUndefined();
    expect(index.match("Apple Music").requiresManualReview).toBe(true);
  });
  it("provides a bounded, immutable list of unique schema-safe identities", () => {
    expect(expandedMerchantIdentities.length).toBe(150);
    expect(Object.isFrozen(expandedMerchantIdentities)).toBe(true);
    const ids = new Set<string>();
    const entities = new Set<string>();
    const owners = new Map<string, string>();

    for (const identity of expandedMerchantIdentities) {
      expect(Object.isFrozen(identity)).toBe(true);
      expect(Object.isFrozen(identity.aliases)).toBe(true);
      expect(identity.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(identity.id.length).toBeLessThanOrEqual(80);
      expect(identity.wikidataId).toMatch(/^Q[1-9]\d{0,13}$/);
      expect(ids.has(identity.id)).toBe(false);
      expect(entities.has(identity.wikidataId)).toBe(false);
      ids.add(identity.id);
      entities.add(identity.wikidataId);

      for (const name of [identity.canonicalName, ...identity.aliases]) {
        expect(name.trim()).toBe(name);
        expect(name.length).toBeGreaterThanOrEqual(2);
        expect(name.length).toBeLessThanOrEqual(100);
        const normalized = normalizeMerchantText(name);
        expect(normalized).not.toBe("");
        expect(normalized.split(" ").length).toBeLessThanOrEqual(4);
        const owner = owners.get(normalized);
        expect(owner === undefined || owner === identity.id).toBe(true);
        owners.set(normalized, identity.id);
      }
      expect(identity.aliases.length).toBeLessThanOrEqual(32);
      if (identity.defaultCategory !== null) {
        expect(categories).toContain(identity.defaultCategory);
      }
    }
    for (const definition of definitions) {
      expect(merchantSchema.safeParse(definition).success).toBe(true);
    }
  });

  it("asserts neither purchase categories nor artwork or licence permissions", () => {
    for (const identity of expandedMerchantIdentities) {
      expect(Object.keys(identity).sort()).toEqual([
        "aliases",
        "canonicalName",
        "defaultCategory",
        "id",
        "wikidataId",
      ]);
      expect(identity.defaultCategory).toBeNull();
    }
    for (const definition of definitions) {
      expect(merchantSchema.parse(definition)).toMatchObject({
        defaultCategory: null,
        requiresCategoryEvidence: true,
        regexPatterns: [],
        logo: null,
        license: null,
        attribution: null,
      });
    }
  });

  it("preserves exact product, bank, retail and hotel identities", () => {
    const expected = {
      "at-libro": "Q1823138",
      "at-easybank": "Q15807172",
      "at-forstinger": "Q1438333",
      rossmann: "Q316004",
      carrefour: "Q217599",
      expedia: "Q1418432",
      "hilton-hotels": "Q598884",
      "marriott-hotels": "Q3918608",
      "apple-music": "Q20056642",
      icloud: "Q283469",
      "apple-tv-plus": "Q62446736",
      "google-one": "Q60617335",
      "google-play": "Q79576",
      "proton-mail": "Q17355735",
      vodafone: "Q122141",
      swisscom: "Q644324",
      "deutsche-telekom": "Q9396",
      dropbox: "Q142539",
      jetbrains: "Q1688472",
      figma: "Q96186334",
    };
    const byId = new Map(
      expandedMerchantIdentities.map((identity) => [identity.id, identity]),
    );
    for (const [id, wikidataId] of Object.entries(expected)) {
      expect(byId.get(id)?.wikidataId).toBe(wikidataId);
    }
    for (const incorrectEntity of [
      "Q6542768", // Japanese Libro, not the Austrian retailer.
      "Q1597448", // Rossmann disambiguation page.
      "Q147614", // Zara disambiguation page.
      "Q270285", // Apple TV hardware, not the streaming service.
      "Q312", // Apple company, not Apple Music/iCloud/Apple TV.
      "Q2283", // Microsoft company, not an office subscription.
    ]) {
      expect(
        expandedMerchantIdentities.some(
          (identity) => identity.wikidataId === incorrectEntity,
        ),
      ).toBe(false);
    }
  });

  it("omits provider aliases, broad bank aliases and already-covered identities", () => {
    const excludedNames = [
      "PayPal",
      "Klarna",
      "Stripe",
      "Revolut",
      "Apple Pay",
      "Google Pay",
      "DB",
      "SP",
      "AP",
      "Raiffeisen",
      "Coop",
      "Netto",
      "Total",
      "App Store",
      "iTunes",
      "Amazon",
      "Microsoft",
      "Microsoft 365",
      "N26",
      "Apple TV",
      "Reserved",
      "About You",
      "Next",
      "Gap",
      "Only",
      "Wish",
    ].map(normalizeMerchantText);
    for (const identity of expandedMerchantIdentities) {
      for (const name of [identity.canonicalName, ...identity.aliases]) {
        expect(excludedNames).not.toContain(normalizeMerchantText(name));
      }
    }
  });

  it("does not duplicate the additional public OSM reference catalogue", () => {
    const existingPublicEntities = new Set([
      "Q573422",
      "Q671216",
      "Q1880676",
      "Q3645582",
      "Q136709653",
      "Q1287437",
      "Q3497483",
      "Q1355904",
      "Q645984",
      "Q218115",
      "Q1530892",
      "Q2422884",
      "Q603698",
      "Q894874",
      "Q649646",
      "Q542767",
      "Q3541852",
      "Q1066858",
      "Q696867",
      "Q74866",
      "Q2282172",
      "Q3835099",
      "Q191485",
      "Q379938",
      "Q147662",
      "Q60772401",
      "Q635484",
      "Q843887",
      "Q670154",
      "Q538587",
      "Q62288",
      "Q390107",
      "Q13882231",
      "Q665740",
      "Q1102389",
      "Q1654538",
      "Q705042",
      "Q1342350",
      "Q1869471",
      "Q21282762",
      "Q599545",
      "Q112157842",
      "Q110516413",
      "Q794636",
      "Q392755",
      "Q555861",
      "Q3196447",
      "Q19572998",
      "Q697619",
      "Q193136",
      "Q1136426",
      "Q4688560",
      "Q1151774",
      "Q3938666",
      "Q2533008",
      "Q788231",
      "Q106351886",
      "Q111923135",
      "Q178516",
      "Q926575",
      "Q1539185",
      "Q1892752",
      "Q2349550",
      "Q1030922",
    ]);
    for (const identity of expandedMerchantIdentities) {
      expect(existingPublicEntities.has(identity.wikidataId)).toBe(false);
    }
  });

  it("matches its specific names without cross-brand ambiguity or automatic categorisation", () => {
    const index = new MerchantIndex(
      definitions.map((definition) => merchantSchema.parse(definition)),
    );
    for (const identity of expandedMerchantIdentities) {
      for (const name of [identity.canonicalName, ...identity.aliases]) {
        expect(index.match(name)).toMatchObject({
          method: "exact",
          requiresManualReview: true,
          merchant: {
            id: identity.id,
            wikidataId: identity.wikidataId,
            defaultCategory: null,
            requiresCategoryEvidence: true,
            logo: null,
          },
        });
      }
    }
    expect(index.match("Apple TV").merchant).toBeUndefined();
    expect(index.match("Raiffeisen").merchant).toBeUndefined();
    expect(index.match("Netto").merchant).toBeUndefined();
  });
});
