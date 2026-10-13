import { expect, it } from "vitest";
import { transactionSchema } from "@/lib/types";
import { blankTestState } from "@/lib/server/test-support";
import { classify } from "@/lib/calc";
import { bookingReviewReason } from "@/lib/import/review";
import { MerchantIndex, seedMerchants } from "./merchants";
import { backfillBatch, enrichTransaction } from "./pipeline";
import { parseOsmMerchants } from "./merchant-import";

const index = new MerchantIndex(seedMerchants);
const row = (description: string) =>
  transactionSchema.parse({
    id: "purpose",
    description,
    amount: -42,
    date: "2026-10-08",
    bank: "Amex",
    pocket: "Amex",
    category: "Prüfen",
    includeInPlan: true,
  });

it("uses unanimously corroborated public shop types without guessing a duplicate outlet identity", () => {
  const imported = parseOsmMerchants({
    version: 0.6,
    osm3s: { copyright: "OpenStreetMap contributors" },
    elements: [
      { type: "node", id: 1, tags: { name: "BIPA", shop: "chemist" } },
      { type: "node", id: 2, tags: { name: "BIPA", shop: "chemist" } },
    ],
  }).merchants;
  const corroborated = new MerchantIndex([...seedMerchants, ...imported]);
  expect(corroborated.match("BIPA").requiresManualReview).toBe(true);
  const result = enrichTransaction(row("BIPA"), corroborated);
  expect(result).toMatchObject({
    category: "Mittagessen",
    requires_manual_review: false,
  });
  expect(result.merchantId).toBeUndefined();
  expect(result.merchantAlias).toBeUndefined();
  expect(
    enrichTransaction(
      { ...row("BIPA"), rawDetails: ["MCC: 5541"] },
      corroborated,
    ).requires_manual_review,
  ).toBe(true);
  expect(
    enrichTransaction(row("BIPAA"), corroborated).requires_manual_review,
  ).toBe(true);
  const contradictory = new MerchantIndex([
    ...seedMerchants,
    { ...imported[0], defaultCategory: "Shopping" },
  ]);
  expect(
    enrichTransaction(row("BIPA"), contradictory).requires_manual_review,
  ).toBe(true);
});

it("uses a clear dining purpose across compatible restaurant/cafe types but not conflicting bank MCCs", () => {
  const imported = parseOsmMerchants({
    version: 0.6,
    osm3s: { copyright: "OpenStreetMap contributors" },
    elements: [
      { type: "node", id: 3, tags: { name: "McDonalds", amenity: "cafe" } },
    ],
  }).merchants;
  const compatible = new MerchantIndex([...seedMerchants, ...imported]);
  expect(compatible.match("McDonalds Villach").merchant).toBeUndefined();
  const result = enrichTransaction(row("McDonalds Villach"), compatible);
  expect(result).toMatchObject({
    category: "Restaurants",
    requires_manual_review: false,
  });
  expect(result.merchantId).toBeUndefined();
  expect(
    enrichTransaction(
      { ...row("McDonalds Villach"), rawDetails: ["MCC: 5541"] },
      compatible,
    ).requires_manual_review,
  ).toBe(true);
});

it("assigns a clear purpose without inventing a merchant identity and clears the review queue", () => {
  const original = row("Nova Supermarket");
  const state = blankTestState();
  state.transactions = [original];
  state.reviewQueue = [
    {
      kind: "booking",
      id: original.id,
      draft: original,
      message: "Händler fehlt",
    },
  ];
  const result = backfillBatch(state, new Set([original.id]), index);
  expect(result.transactions[0]).toMatchObject({
    category: "Lebensmittel",
    requires_manual_review: false,
    automaticCategoryEvidence: { method: "purpose", category: "Lebensmittel" },
  });
  expect(result.transactions[0].merchantId).toBeUndefined();
  expect(result.transactions[0].merchantAlias).toBeUndefined();
  expect(result.reviewQueue).toHaveLength(0);
  expect(bookingReviewReason(result, result.transactions[0])).toBeUndefined();
});

it("uses explicit bank MCC for previously unknown merchants", () => {
  const result = enrichTransaction(
    { ...row("Nova Outlet"), rawDetails: ["MCC: 5411"] },
    index,
  );
  expect(result).toMatchObject({
    category: "Lebensmittel",
    requires_manual_review: false,
  });
  expect(result.automaticCategoryEvidence).toEqual({
    method: "mcc",
    category: "Lebensmittel",
    mcc: "5411",
  });
});

it.each([
  { ...row("Nova Pharmacy"), rawDetails: ["MCC: 5411"] },
  { ...row("BILLA"), rawDetails: ["MCC: 5812"] },
  row("Unknown Entity"),
])(
  "keeps unresolved or contradictory evidence for manual review",
  (original) => {
    expect(enrichTransaction(original, index).requires_manual_review).toBe(
      true,
    );
  },
);

it.each([
  "Cyprus Duty Free",
  "Heinemann Duty Free Frankfurt",
  "Airport Duty-Free",
])(
  "displays %s as Shopping, not Urlaub, and retains holiday budget exclusions",
  (description) => {
    const original = {
      ...row(description),
      category: "Urlaub" as const,
      sourceCategory: "Urlaub",
      holidayRange: "2026-10-01..2026-10-12",
    };
    const result = enrichTransaction(original, index);
    expect(result).toMatchObject({
      category: "Shopping",
      requires_manual_review: false,
    });
    expect(classify(result)).toMatchObject({
      category: "Shopping",
      includeInPlan: false,
    });
  },
);

it("never overwrites a manually chosen duty-free category", () => {
  const original = {
    ...row("Cyprus Duty Free"),
    category: "Geschenke & Spenden" as const,
    manualCategory: true,
  };
  expect(enrichTransaction(original, index)).toEqual({
    ...original,
    is_locked: true,
  });
  expect(classify(original).category).toBe("Geschenke & Spenden");
});

it.each([
  ["Cyprus Duty Free", -42],
  ["Airport Duty-Free", -42],
  ["Cyprus Duty Free", 42],
  ["Airport Duty-Free", 42],
])(
  "retains holiday budget exclusion across repeated enrichment: %s %s",
  (description, amount) => {
    const original = {
      ...row(description),
      amount,
      category: "Urlaub" as const,
    };
    expect(classify(original).includeInPlan).toBe(false);
    const result = enrichTransaction(original, index);
    expect(result.automaticCategoryEvidence?.budgetExcluded).toBe(true);
    const expected = amount < 0 ? "Shopping" : "Rückerstattungen";
    expect(classify(result)).toMatchObject({
      category: expected,
      includeInPlan: false,
    });
    expect(classify(enrichTransaction(result, index))).toMatchObject({
      category: expected,
      includeInPlan: false,
    });
  },
);
