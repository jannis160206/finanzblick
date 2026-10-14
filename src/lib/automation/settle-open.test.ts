import { expect, it } from "vitest";
import { blankTestState } from "@/lib/server/test-support";
import { transactionSchema, type Transaction } from "@/lib/types";
import { openReviewCount } from "@/lib/import/review";
import { settleOpenReviews } from "./settle-open";

const booking = (id: string, description: string, extra: Partial<Transaction> = {}) =>
  transactionSchema.parse({
    id, description, bank: "Erste", pocket: "Erste", date: "2026-10-08",
    amount: -18.5, category: "Prüfen", includeInPlan: true,
    requires_manual_review: true, ...extra,
  });
const withQueue = (rows: Transaction[]) => ({
  ...blankTestState(),
  transactions: rows,
  reviewQueue: rows.map((draft) => ({
    kind: "booking" as const, id: draft.id, draft, message: "Händlerzuordnung unsicher – bitte prüfen.",
  })),
});

it("closes open entries that have source evidence and keeps the rest", () => {
  const state = withQueue([
    booking("a", "Kirchenwirt Zell", { sourceCategory: "Restaurants" }),
    booking("b", "Xyz 123 unbekannt"),
  ]);
  const next = settleOpenReviews(state);
  expect(openReviewCount(next.reviewQueue ?? [])).toBe(1);
  expect(next.transactions.find((row) => row.id === "a")?.category).toBe("Restaurants");
});

it("returns the same state when nothing can be settled", () => {
  const state = withQueue([booking("b", "Xyz 123 unbekannt")]);
  expect(settleOpenReviews(state)).toBe(state);
  const empty = blankTestState();
  expect(settleOpenReviews(empty)).toBe(empty);
});
