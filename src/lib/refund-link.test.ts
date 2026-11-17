import { describe, expect, it } from "vitest";
import { createSeed } from "./seed";
import { bookingReviewReason } from "./import/review";
import { linkedRefund, ownCostAfterRefund, REFUND_REVIEW_MESSAGE, refundQuestion } from "./refund-link";
import { personalAmount, reconcileSharedHoliday } from "./shared-holiday";
import type { AppState, Transaction } from "./types";

const row = (id: string, date: string, amount: number, description: string, patch: Partial<Transaction> = {}): Transaction => ({
  id, date, amount, description, bank: "Amex", pocket: "Amex", category: "Prüfen", includeInPlan: true, ...patch,
});
const restaurant = (id: string, amount: number, patch: Partial<Transaction> = {}) =>
  row(id, "2026-10-28", amount, `Restaurant ${id}`, { category: "Restaurants", categoryOverride: true, ...patch });
const trattoria = row("trattoria", "2026-10-30", -48, "TRATTORIA SOLE");
const pizzeria = restaurant("pizzeria", -52.5);
const sushi = restaurant("sushi", -68.9);
const shopping = row("shopping", "2026-10-29", -48, "Elektronikmarkt", { category: "Shopping", categoryOverride: true });
const gourmet = row("gourmet", "2026-11-02", 48, "Gourmet Gutschrift");
const giro = { bank: "Raiffeisen", pocket: "Raiffeisen Giro" };
const shop = row("shop", "2026-09-21", -64.2, "Baumarkt Nord", { ...giro, category: "Wohnen & Haushalt", categoryOverride: true });
const shopRefund = row("shop-back", "2026-10-02", 24.8, "Baumarkt Nord", { ...giro, category: "Rückerstattungen", categoryOverride: true });

function state(transactions: Transaction[]): AppState {
  const seed = createSeed();
  return { ...seed, settings: { ...seed.settings, asOf: "2026-11-17" }, transactions, reviewQueue: [] };
}
const ids = (question?: ReturnType<typeof refundQuestion>) => question?.candidates.map((item) => item.booking.id);

describe("refund questions", () => {
  it("searches the card the credit arrived on for the same amount or a little less to a little more, preferring what the benefit pays for", () => {
    // Other card, other account and a restaurant far above the amount stay out while closer ones exist; shopping of the same amount too.
    const partner = restaurant("partner", -48, { pocket: "AMEX Raphael" });
    const elsewhere = restaurant("elsewhere", -48, giro);
    const question = refundQuestion(state([trattoria, pizzeria, sushi, shopping, partner, elsewhere]), gourmet)!;
    expect(question).toMatchObject({ kind: "benefit", label: "Amex Gourmet-Gutschrift", suggested: "trattoria" });
    expect(ids(question)).toEqual(["trattoria", "pizzeria"]);
    expect(question.candidates[1]).toMatchObject({ exact: false, difference: 4.5 });
    expect(ownCostAfterRefund(question.candidates[1], 48)).toBe(4.5);
    // A little less than the credit fits as well (exchange rate); nothing is preselected that is only close.
    const less = restaurant("less", -47.2);
    expect(refundQuestion(state([less, pizzeria]), gourmet)).toMatchObject({ candidates: [{ booking: { id: "less" }, difference: -0.8 }, { booking: { id: "pizzeria" } }] });
    expect(refundQuestion(state([less, pizzeria]), gourmet)?.suggested).toBeUndefined();
    // Without a close restaurant a larger one (capped benefit) comes before shopping that matches only by amount.
    expect(refundQuestion(state([sushi, shopping]), gourmet)).toMatchObject({ suggested: "sushi", candidates: [{ booking: { id: "sushi" } }] });
    expect(refundQuestion(state([shopping]), gourmet)).toMatchObject({ suggested: "shopping", candidates: [{ booking: { id: "shopping" } }] });
  });

  it("prefers the merchant's own purchase, also for a partial refund, and asks only about undecided recent credits", () => {
    const nearby = row("drogerie", "2026-09-30", -25.3, "Drogerie Mitte", { ...giro, category: "Drogerie", categoryOverride: true });
    const question = refundQuestion(state([shop, nearby]), shopRefund)!;
    expect(question).toMatchObject({ kind: "merchant", suggested: "shop", candidates: [{ sameMerchant: true }] });
    expect(ids(question)).toEqual(["shop"]);
    expect(ownCostAfterRefund(question.candidates[0], 24.8)).toBe(39.4);
    // Without the merchant's purchase only amount matches are left: offered, but not preselected.
    expect(refundQuestion(state([nearby]), shopRefund)).toMatchObject({ candidates: [{ booking: { id: "drogerie" } }] });
    expect(refundQuestion(state([nearby]), shopRefund)?.suggested).toBeUndefined();
    // An earlier linked refund of the same purchase counts.
    const earlier = { ...shopRefund, id: "shop-first", date: "2026-09-25", amount: 30, sharedRefundFor: "shop" };
    expect(ownCostAfterRefund(refundQuestion(state([shop, earlier]), shopRefund)!.candidates[0], 24.8)).toBe(9.4);
    expect(refundQuestion(state([shop]), { ...shopRefund, sharedRefundFor: "shop" })).toBeUndefined();
    expect(refundQuestion(state([shop]), { ...shopRefund, sharedRefundUnlinked: true })).toBeUndefined();
    expect(refundQuestion(state([shop]), { ...shopRefund, date: "2026-09-10" })).toBeUndefined();
    expect(refundQuestion(state([shop]), { ...shopRefund, description: "Gehalt Oktober", category: "Gehalt" })).toBeUndefined();
  });

  it("puts a booked credit in the review list until it is linked, and then counts it against the purchase's category", () => {
    const less = restaurant("less", -47.2);
    const ledger = state([less, gourmet]);
    expect(bookingReviewReason(ledger, gourmet, undefined, true)).toBe(REFUND_REVIEW_MESSAGE);
    // An imported credit is booked first; the question follows from the ledger.
    expect(bookingReviewReason(ledger, gourmet)).not.toBe(REFUND_REVIEW_MESSAGE);
    const linked = linkedRefund(gourmet, "less");
    expect(linked).toMatchObject({ category: "Rückerstattungen", reviewed: true, sharedRefundFor: "less" });
    expect(bookingReviewReason(state([less, linked]), linked, undefined, true)).not.toBe(REFUND_REVIEW_MESSAGE);
    // The credit may be a little larger than the purchase it refunds.
    const accounted = reconcileSharedHoliday([less, linked]).bookings.find((item) => item.id === "gourmet")!;
    expect(accounted).toMatchObject({ category: "Restaurants", holidayRefundFor: "less" });
    expect(personalAmount(accounted)).toBe(48);
  });
});
