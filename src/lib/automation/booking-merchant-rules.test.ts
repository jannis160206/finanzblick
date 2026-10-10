import { describe, expect, it, vi } from "vitest";
import { categories } from "@/lib/categories";
import { transactionSchema } from "@/lib/types";
import { reviewedBookingMerchants } from "./booking-merchant-rules";
import { merchantCatalogueReferences } from "./merchant-catalogue-completion";
import { MerchantIndex, merchantSchema, seedMerchants } from "./merchants";
import { enrichTransaction } from "./pipeline";
import type { AutomationStore } from "./store";

const index = new MerchantIndex(seedMerchants);
const booking = (description: string) =>
  transactionSchema.parse({
    id: "reviewed-public-merchant",
    description,
    date: "2026-10-10",
    bank: "Amex",
    pocket: "Amex",
    amount: -10,
    category: "Prüfen",
    includeInPlan: true,
  });

describe("booking-derived public merchant references", () => {
  it("matches every reviewed canonical name and alias to its own exact identity", () => {
    for (const review of reviewedBookingMerchants) {
      for (const name of [review.canonicalName, ...review.aliases]) {
        expect(index.match(name), name).toMatchObject({
          method: "exact",
          merchant: { id: review.id },
        });
      }
    }
  });

  it("seeds unique verified public references with existing categories and no embedded artwork or finance data", () => {
    const ids = new Set<string>();
    const seeds = new Map(
      seedMerchants.map((merchant) => [merchant.id, merchant]),
    );
    for (const review of reviewedBookingMerchants) {
      expect(ids.has(review.id)).toBe(false);
      ids.add(review.id);
      if (review.category !== null)
        expect(categories).toContain(review.category);
      expect(review.evidenceUrl).toMatch(/^https:\/\//);
      const seed = seeds.get(review.id);
      expect(seed).toMatchObject({
        defaultCategory: review.category,
        source: "local",
        wikidataId: review.wikidataId,
        requiresCategoryEvidence: review.requiresCategoryEvidence ?? false,
        logo: null,
      });
      expect(seed?.attribution).toContain(review.evidenceUrl);
      expect(merchantSchema.safeParse(seed).success).toBe(true);
    }
  });

  it.each([
    ["Zara", "Shopping"],
    ["New Yorker", "Shopping"],
    ["Fielmann", "Gesundheit"],
    ["ASFINAG", "Parken & Maut"],
    ["ALDI", "Lebensmittel"],
    ["Dunkin Donuts", "Cafés & Snacks"],
    ["Taco Bell", "Restaurants"],
    ["Sklavenitis", "Lebensmittel"],
    ["AlphaMega", "Lebensmittel"],
    ["Mercadona", "Lebensmittel"],
    ["Ubigi", "Telefon & Internet"],
    ["Jacques Lemans", "Shopping"],
    ["Farmacia Caffarena", "Gesundheit"],
    ["Renfe Cercanías", "Öffentliche Verkehrsmittel"],
  ])(
    "categorizes the verified specific merchant %s without source-data mutation",
    (name, category) => {
      const row = booking(name);
      const next = enrichTransaction(row, index);
      expect(next).toMatchObject({
        id: row.id,
        description: row.description,
        amount: row.amount,
        category,
        requires_manual_review: false,
      });
      expect(next.merchantId).toBeDefined();
    },
  );

  it("retains manual choices, refunds, conflicts, fuzzy review and transfer suppression", () => {
    const locked = {
      ...booking("Taco Bell"),
      is_locked: true,
      category: "Shopping" as const,
    };
    expect(enrichTransaction(locked, index)).toEqual(locked);
    expect(
      enrichTransaction({ ...booking("ALDI Refund"), amount: 10 }, index),
    ).toMatchObject({ category: "Rückerstattungen", merchantAlias: "ALDI" });
    expect(enrichTransaction(booking("Taco Bell BILLA"), index)).toMatchObject({
      requires_manual_review: true,
      category: "Prüfen",
    });
    expect(enrichTransaction(booking("Tacoo Bell"), index)).toMatchObject({
      requires_manual_review: true,
    });
    expect(
      enrichTransaction(booking("SEPA Überweisung an Taco Bell"), index),
    ).toMatchObject({ merchantLogo: false });
  });

  it.each([
    "Amazon",
    "G2A.com",
    "Glovo",
    "Transak",
    "Coral Gas Cyprus",
    "Too Good To Go",
    "Petrol Group",
    "Petrolina",
    "MOL",
    "Galp",
    "Avanti",
    "Der Gams",
    "Falkensteiner Schlosshotel Velden",
  ])(
    "does not turn the multipurpose identity %s into an unproved purchase category",
    (name) => {
      expect(enrichTransaction(booking(name), index)).toMatchObject({
        merchantId: expect.any(String),
        requires_manual_review: true,
      });
    },
  );

  it.each([
    "Hotspot",
    "Mensa",
    "Mensen",
    "NYX MyEl",
    "C2C",
    "Avant",
    "OCH Auto Dus",
    "Kanzianus Ap",
    "Farmacia Central",
    "Best Buy Cyprus",
    "Freddo's Coffee",
    "Spiritual",
    "Duca d'Aosta",
    "Farmacia Las Flores",
    "DIA",
    "Petrol",
    "com",
  ])(
    "does not globally adopt the unresolved or shortened identity %s",
    (name) => {
      const match = index.match(name);
      expect(["exact", "regex"]).not.toContain(match.method);
    },
  );

  it("uses foreign regions for new references without changing an existing grant identity region", () => {
    const seeds = new Map(
      seedMerchants.map((merchant) => [merchant.id, merchant]),
    );
    expect(seeds.get("cy-roof-burger-bar")?.region).toBe("CY");
    expect(seeds.get("es-farmacia-mata")?.region).toBe("ES");
    expect(seeds.get("pegasus-airlines")?.region).toBe("AT");
  });
});

it("fills only missing imported categories with exact reviewed public identity, name and region proof", () => {
  const zara = seedMerchants.find((merchant) => merchant.id === "zara")!;
  const make = (id: string) => ({
    ...zara,
    id,
    source: "osm",
    defaultCategory: null,
    attribution: "© OpenStreetMap contributors",
    updatedAt: 1,
  });
  const refs = [
    make("same-brand"),
    { ...make("other-name"), canonicalName: "Different retailer" },
    { ...make("other-region"), region: "DE" },
    { ...make("other-entity"), wikidataId: "Q123" },
    {
      ...make("conflicting-purpose"),
      defaultCategory: "Geschenke & Spenden" as const,
    },
  ];
  const store = { loadMerchants: vi.fn(() => refs) } satisfies Pick<
    AutomationStore,
    "loadMerchants"
  >;
  const completed = merchantCatalogueReferences(store);
  expect(completed.get("same-brand")).toMatchObject({
    defaultCategory: "Shopping",
    source: "osm",
    canonicalName: "Zara",
    wikidataId: zara.wikidataId,
  });
  expect(completed.get("same-brand")?.attribution).toContain(
    "© OpenStreetMap contributors",
  );
  for (const ref of refs.slice(1)) expect(completed.get(ref.id)).toEqual(ref);
  const matched = new MerchantIndex([zara, completed.get("same-brand")!]).match(
    "Zara",
  );
  expect(matched.merchant?.defaultCategory).toBe("Shopping");
});
