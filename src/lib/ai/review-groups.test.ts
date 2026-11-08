import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { classify } from "@/lib/calc";
import { commitStatementImport, queueLedgerReview } from "@/lib/import/review";
import { appStateSchema, transactionSchema, type AppState, type Transaction } from "@/lib/types";
import type { Category } from "@/lib/categories";
import { groupReviews, reviewSuggestion, suggestedDraft } from "./review-groups";
import { recordAiSuggestions } from "./suggestions";

const booking = (id: string, overrides: Partial<Transaction> = {}): Transaction => ({
  id, date: "2026-09-03", bank: "Raiffeisen", pocket: "Testkonto",
  description: "Nordlicht Laden 4711", amount: -24, category: "Prüfen", includeInPlan: true, ...overrides,
});

function withOpen(open: Transaction[]): AppState {
  const state = queueLedgerReview(appStateSchema.parse({
    ...createSeed(), transactions: open, merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
    ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [],
  }));
  return {
    ...state,
    reviewQueue: open.map((draft) => ({ kind: "booking" as const, id: draft.id, draft, message: "Händlerzuordnung unsicher – bitte prüfen." })),
  };
}

describe("review groups", () => {
  const state = withOpen([
    booking("a", { date: "2026-09-01" }), booking("b", { amount: -12, date: "2026-09-10" }),
    booking("refund", { amount: 12 }), booking("other", { description: "Sonnenhof Café 12" }),
  ]);

  it("groups open bookings of one merchant and direction", () => {
    const { groups, singles } = groupReviews(state.reviewQueue!, []);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ total: -36 });
    expect(groups[0].items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(singles.map((item) => item.id)).toEqual(["refund", "other"]);
  });

  it("stores proposals per open review and pre-fills the dialog", () => {
    const recorded = recordAiSuggestions(state, [
      { reviewId: "a", reason: "Sicherheit 80 %", suggestion: { category: "Shopping", merchantAlias: "Nordlicht", source: "KI" } },
      { reviewId: "gone", reason: "x", suggestion: { category: "Shopping", source: "KI" } },
    ]);
    expect(recorded.aiSuggestions).toEqual([{ id: "a", category: "Shopping", merchantAlias: "Nordlicht", reason: "Sicherheit 80 %", source: "KI" }]);
    expect(recordAiSuggestions(recorded, [])).toBe(recorded);
    const draft = suggestedDraft(state.reviewQueue![0].kind === "booking" ? state.reviewQueue![0].draft : booking("x"), recorded.aiSuggestions![0]);
    expect(draft).toMatchObject({ category: "Shopping", merchantAlias: "Nordlicht" });
    expect(draft.merchantNameConfirmed).toBeUndefined();
    expect(groupReviews(recorded.reviewQueue!, recorded.aiSuggestions).groups[0].suggestion?.category).toBe("Shopping");
    const settled = recordAiSuggestions({ ...recorded, reviewQueue: recorded.reviewQueue!.filter((item) => item.id !== "a") }, []);
    expect(settled.aiSuggestions).toEqual([]);
  });

  it("settles a whole group with one commit", () => {
    const group = groupReviews(state.reviewQueue!, []).groups[0];
    const rows = group.items.map((item) => {
      const row = transactionSchema.parse({
        ...item.draft, category: "Shopping", categoryOverride: true, manualCategory: true, reviewed: true, includeInPlan: true, fixedCost: false,
      });
      return { ...row, includeInPlan: classify(row).includeInPlan };
    });
    const unrelated = { ...state, transactions: [...state.transactions, booking("zz", { description: "Qwertz Zufall 77" })] };
    const base = queueLedgerReview(unrelated);
    expect(base.reviewQueue?.some((item) => item.id === "zz")).toBe(true);
    const next = queueLedgerReview(commitStatementImport(base, rows, [], {}).state);
    const open = next.reviewQueue?.map((item) => item.id) ?? [];
    expect(open).not.toContain("a");
    expect(open).not.toContain("b");
    expect(open).toContain("zz");
    expect(next.transactions.filter((row) => ["a", "b"].includes(row.id)).map((row) => classify(row).category))
      .toEqual(["Shopping", "Shopping"]);
  });
});

describe("review suggestions", () => {
  const review = (description: string, amount = -20) =>
    ({ kind: "booking" as const, id: "r", draft: booking("r", { description, amount }), message: "Händlerzuordnung unsicher – bitte prüfen." });
  const guess = (category: Category, source: "KI" | "Historie" = "KI") => ({ id: "r", category, reason: "unsicher", source });

  it("lets a merchant rule replace an older model guess and fill in missing ones", () => {
    expect(reviewSuggestion(review("BLUMEN B B FILNR902 VILLACH 9500", -34), guess("Gesundheit"))).toMatchObject({ category: "Geschenke & Spenden", source: "Regel" });
    expect(reviewSuggestion(review("MPG MÄRZPARKGARAGE WIEN", -12), undefined)).toMatchObject({ category: "Parken & Maut" });
    expect(reviewSuggestion(review("ZAHLUNG/UBERWEISUNG ERHALTEN BESTEN DANK", 1446.65), undefined)).toMatchObject({ category: "Transfer intern" });
  });

  it("keeps the household's history and drops bank-fee guesses without a rule", () => {
    expect(reviewSuggestion(review("BLUMEN B B 9500"), guess("Freizeit", "Historie"))).toMatchObject({ category: "Freizeit" });
    expect(reviewSuggestion(review("ANDREA RUPP 2363", -3.4), guess("Rücklastschriftgebühren"))).toBeUndefined();
    expect(reviewSuggestion(review("SP SMILEUNION GMBH", -9), guess("Freizeit"))).toMatchObject({ category: "Freizeit", source: "KI" });
  });
});
