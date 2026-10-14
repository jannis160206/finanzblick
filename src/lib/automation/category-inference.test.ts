import { expect, it } from "vitest";
import { blankTestState } from "@/lib/server/test-support";
import { transactionSchema, type Transaction } from "@/lib/types";
import { MerchantIndex, seedMerchants } from "./merchants";
import { backfillBatch, enrichTransaction } from "./pipeline";
import { createHistoryResolver } from "./aliases";
import { openReviewCount } from "@/lib/import/review";

const index = new MerchantIndex(seedMerchants);
const booking = (id: string, description: string, extra: Partial<Transaction> = {}) =>
  transactionSchema.parse({
    id,
    description,
    bank: "Erste",
    pocket: "Erste",
    date: "2026-10-08",
    amount: -18.5,
    category: "Prüfen",
    includeInPlan: true,
    ...extra,
  });
const settled = (id: string, description: string, category: Transaction["category"]) =>
  booking(id, description, {
    category,
    categoryOverride: true,
    requires_manual_review: false,
    automaticCategoryEvidence: { method: "purpose", category },
  });

it("uses a concrete source category when nothing else identifies the booking", () => {
  const row = enrichTransaction(
    booking("a", "Kirchenwirt Zell", { sourceCategory: "Restaurants" }),
    index,
  );
  expect(row).toMatchObject({
    category: "Restaurants",
    requires_manual_review: false,
    automaticCategoryEvidence: { method: "source", category: "Restaurants" },
  });
});

it.each(["Prüfen", "Sonstiges", "Transfer", "Urlaub", "Gehalt"])(
  "keeps a %s source category open",
  (sourceCategory) => {
    const row = enrichTransaction(
      booking("a", "Kirchenwirt Zell", { sourceCategory }),
      index,
    );
    expect(row.requires_manual_review).toBe(true);
  },
);

it("does not override a contradicting merchant signal with the source category", () => {
  const row = enrichTransaction(
    booking("a", "Spar Zell", { sourceCategory: "Entertainment" }),
    index,
  );
  expect(row.category).not.toBe("Entertainment");
});

it("learns a descriptor from two consistent settled bookings", () => {
  const state = {
    ...blankTestState(),
    transactions: [
      settled("h1", "Bäckerei Moser Zell", "Cafés & Snacks"),
      settled("h2", "Bäckerei Moser Zell", "Cafés & Snacks"),
    ],
  };
  const resolve = createHistoryResolver(state);
  const row = enrichTransaction(
    booking("n", "Bäckerei Moser Zell"),
    index,
    undefined,
    resolve,
  );
  expect(row).toMatchObject({
    category: "Cafés & Snacks",
    requires_manual_review: false,
    automaticCategoryEvidence: { method: "history" },
  });
});

it("needs more than one automatic booking and no contradiction", () => {
  const one = createHistoryResolver({
    ...blankTestState(),
    transactions: [settled("h1", "Bäckerei Moser Zell", "Cafés & Snacks")],
  });
  const mixed = createHistoryResolver({
    ...blankTestState(),
    transactions: [
      settled("h1", "Bäckerei Moser Zell", "Cafés & Snacks"),
      settled("h2", "Bäckerei Moser Zell", "Cafés & Snacks"),
      settled("h3", "Bäckerei Moser Zell", "Lebensmittel"),
    ],
  });
  const row = booking("n", "Bäckerei Moser Zell");
  expect(one(row)).toBeUndefined();
  expect(mixed(row)).toBeUndefined();
});

it("never counts earlier inferences as history", () => {
  const inferred = booking("h1", "Bäckerei Moser Zell", {
    category: "Cafés & Snacks",
    categoryOverride: true,
    requires_manual_review: false,
    automaticCategoryEvidence: { method: "history", category: "Cafés & Snacks" },
  });
  const resolve = createHistoryResolver({
    ...blankTestState(),
    transactions: [inferred, { ...inferred, id: "h2" }],
  });
  expect(resolve(booking("n", "Bäckerei Moser Zell"))).toBeUndefined();
});

it("resolves existing open bookings during a backfill and shrinks the count", () => {
  const history = [
    settled("h1", "Bäckerei Moser Zell", "Cafés & Snacks"),
    settled("h2", "Bäckerei Moser Zell", "Cafés & Snacks"),
  ];
  const open = [
    booking("o1", "Bäckerei Moser Zell", { requires_manual_review: true }),
    booking("o2", "Kirchenwirt Zell", {
      sourceCategory: "Restaurants",
      requires_manual_review: true,
    }),
    booking("o3", "Xyz 123 unbekannt", { requires_manual_review: true }),
  ];
  const state = {
    ...blankTestState(),
    transactions: [...history, ...open],
    reviewQueue: open.map((draft) => ({
      kind: "booking" as const,
      id: draft.id,
      draft,
      message: "Händlerzuordnung unsicher – bitte prüfen.",
    })),
  };
  expect(openReviewCount(state.reviewQueue)).toBe(3);
  const next = backfillBatch(state, new Set(open.map((row) => row.id)), index);
  expect(openReviewCount(next.reviewQueue ?? [])).toBe(1);
  expect(next.reviewQueue?.[0]).toMatchObject({ draft: { id: "o3" } });
});

it("never touches user-confirmed bookings", () => {
  const locked = booking("l", "Kirchenwirt Zell", {
    sourceCategory: "Restaurants",
    category: "Shopping",
    categoryOverride: true,
    manualCategory: true,
    is_locked: true,
  });
  expect(enrichTransaction(locked, index).category).toBe("Shopping");
});
