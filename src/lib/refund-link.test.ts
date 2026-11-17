import { describe, expect, it } from "vitest";
import { createSeed } from "./seed";
import { bookingReviewReason } from "./import/review";
import { linkedRefund, ownCostAfterRefund, REFUND_REVIEW_MESSAGE, refundQuestion } from "./refund-link";
import { personalAmount, reconcileSharedHoliday } from "./shared-holiday";
import type { AppState, Transaction } from "./types";

const row = (id: string, date: string, amount: number, description: string, patch: Partial<Transaction> = {}): Transaction => ({
  id, date, amount, description, bank: "Amex", pocket: "Amex", category: "Prüfen", includeInPlan: true, ...patch,
});
const restaurant = row("trattoria", "2026-10-30", -48, "TRATTORIA SOLE");
const sushi = row("sushi", "2026-10-25", -68.9, "Sushi Bar Mond", { category: "Restaurants", categoryOverride: true });
const hotel = row("hotel", "2026-10-23", -79.5, "HOTEL AM SEE", { category: "Urlaub", categoryOverride: true });
const gourmet = row("gourmet", "2026-11-02", 48, "Gourmet Gutschrift");
const shop = row("shop", "2026-09-21", -64.2, "Baumarkt Nord", { bank: "Raiffeisen", pocket: "Raiffeisen Giro", category: "Wohnen & Haushalt", categoryOverride: true });
const shopRefund = row("shop-back", "2026-10-02", 24.8, "Baumarkt Nord", { bank: "Raiffeisen", pocket: "Raiffeisen Giro", category: "Rückerstattungen", categoryOverride: true });

function state(transactions: Transaction[]): AppState {
  const seed = createSeed();
  return { ...seed, settings: { ...seed.settings, asOf: "2026-11-17" }, transactions, reviewQueue: [] };
}

describe("refund questions", () => {
  it("lets the user pick the restaurant of an Amex Gourmet credit and suggests the one with the same amount", () => {
    const question = refundQuestion(state([restaurant, sushi, hotel]), gourmet)!;
    expect(question).toMatchObject({ kind: "benefit", label: "Amex Gourmet-Gutschrift", suggested: "trattoria" });
    // Restaurants and purchases still without category; a hotel of a similar amount is no restaurant.
    expect(question.candidates.map((item) => item.booking.id)).toEqual(["trattoria", "sushi"]);
    expect(ownCostAfterRefund(question.candidates[0], 48)).toBe(0);
    expect(ownCostAfterRefund(question.candidates[1], 48)).toBe(20.9);
    expect(refundQuestion(state([restaurant, sushi]), gourmet)?.suggested).toBe("trattoria");
    expect(refundQuestion(state([sushi, hotel]), gourmet)).toMatchObject({ candidates: [{ booking: { id: "sushi" } }] });
    expect(refundQuestion(state([sushi, hotel]), gourmet)?.suggested).toBeUndefined();
  });

  it("asks only to confirm a merchant's refund of one purchase there, and not again once decided or when old", () => {
    const question = refundQuestion(state([shop]), shopRefund)!;
    expect(question).toMatchObject({ kind: "merchant", suggested: "shop" });
    expect(ownCostAfterRefund(question.candidates[0], 24.8)).toBe(39.4);
    // An earlier linked refund of the same purchase counts.
    const earlier = { ...shopRefund, id: "shop-first", date: "2026-09-25", amount: 30, sharedRefundFor: "shop" };
    expect(ownCostAfterRefund(refundQuestion(state([shop, earlier]), shopRefund)!.candidates[0], 24.8)).toBe(9.4);
    expect(refundQuestion(state([shop]), { ...shopRefund, sharedRefundFor: "shop" })).toBeUndefined();
    expect(refundQuestion(state([shop]), { ...shopRefund, sharedRefundUnlinked: true })).toBeUndefined();
    expect(refundQuestion(state([shop]), { ...shopRefund, date: "2026-09-10" })).toBeUndefined();
    expect(refundQuestion(state([shop]), { ...shopRefund, description: "Gehalt Oktober", category: "Gehalt" })).toBeUndefined();
  });

  it("puts the credit in the review list until it is linked, and then counts it against the purchase's category", () => {
    const ledger = state([restaurant, sushi, gourmet]);
    expect(bookingReviewReason(ledger, gourmet, undefined, true)).toBe(REFUND_REVIEW_MESSAGE);
    // An imported credit is booked first; the question follows from the ledger.
    expect(bookingReviewReason(ledger, gourmet)).not.toBe(REFUND_REVIEW_MESSAGE);
    const linked = linkedRefund(gourmet, "sushi");
    expect(linked).toMatchObject({ category: "Rückerstattungen", reviewed: true, sharedRefundFor: "sushi" });
    expect(bookingReviewReason(state([restaurant, sushi, linked]), linked, undefined, true)).not.toBe(REFUND_REVIEW_MESSAGE);
    const accounted = reconcileSharedHoliday([restaurant, sushi, linked]).bookings.find((item) => item.id === "gourmet")!;
    expect(accounted).toMatchObject({ category: "Restaurants", holidayRefundFor: "sushi" });
    expect(personalAmount(accounted)).toBe(48);
  });
});
