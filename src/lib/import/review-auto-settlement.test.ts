import { describe, expect, it } from "vitest";
import { blankTestState } from "@/lib/server/test-support";
import { transactionSchema, type AppState, type Transaction } from "@/lib/types";
import { merchantRuleKey } from "./merchant-rules";
import { bookingReviewReason, queueLedgerReview } from "./review";

const booking = (id: string, patch: Partial<Transaction> = {}) =>
  transactionSchema.parse({
    id,
    date: "2026-09-05",
    bank: "Revolut",
    pocket: null,
    description: "BILLA Wien",
    amount: -30,
    category: "Lebensmittel",
    includeInPlan: true,
    ...patch,
  });
const stateWith = (transactions: Transaction[], patch: Partial<AppState> = {}): AppState => ({
  ...blankTestState(),
  transactions,
  ...patch,
});

describe("automatic ledger review settlement", () => {
  it("removes ledger bookings with a concrete category from the open reviews", () => {
    const uncertain = booking("uncertain", { requires_manual_review: true, merchantId: "synthetic" });
    const named = booking("named", { merchantAlias: "BILLA", merchantNameConfirmed: true, description: "BILLA Graz" });
    const result = queueLedgerReview(stateWith([uncertain, named]));
    expect(result.reviewQueue ?? []).toEqual([]);
    expect(result.transactions.map((row) => row.category)).toEqual(["Lebensmittel", "Lebensmittel"]);
  });

  it("keeps rows without any category evidence and conflicting merchant rules open", () => {
    const unknown = booking("unknown", { category: "Prüfen", description: "Zzz Unknown Entity" });
    const conflicted = booking("conflict", { description: "Amazon", category: "Shopping" });
    const result = queueLedgerReview(
      stateWith([unknown, conflicted], {
        merchantRules: [{ key: merchantRuleKey(conflicted), category: "Freizeit" }],
      }),
    );
    expect(result.reviewQueue?.map((item) => item.id).sort()).toEqual(["conflict", "unknown"]);
  });

  it("still asks about uncertain import drafts before they become bookings", () => {
    const draft = booking("draft", { requires_manual_review: true, merchantId: "synthetic" });
    const state = stateWith([]);
    expect(bookingReviewReason(state, draft)).toBe("Händlerzuordnung unsicher – bitte prüfen.");
    expect(bookingReviewReason(state, draft, undefined, true)).toBeUndefined();
  });
});
