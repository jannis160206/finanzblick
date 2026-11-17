import { classify } from "@/lib/calc";
import { amexEntertainmentCredit } from "@/lib/ai/booking-matchers";
import { isAmexCard, isAmexPartnerCard } from "@/lib/amex-balance";
import { canonicalCategory, type Category } from "@/lib/categories";
import { isIncomeCategory } from "@/lib/fixed";
import { merchantAliasSourceKey } from "@/lib/import/merchant-rules";
import { isRaphaelPayment } from "@/lib/shared-holiday";
import { isNamedTransfer } from "@/lib/transfers";
import type { AppState, Transaction } from "@/lib/types";

/**
 * Which purchase a credit refunds. The search starts where the credit arrived – the same card or account – and looks for
 * purchases with the credit's amount or a little less to a little more (exchange rates, a capped benefit, a tip); they are
 * offered for selection, the clearest one preselected. Amex benefit credits ("Gourmet-Gutschrift") never name the restaurant,
 * so purchases of the kind the benefit pays for come first; a merchant's own credit prefers that merchant's purchases, also a
 * larger one for a partial return. A linked credit counts against the purchase's category (see `reconcileSharedHoliday`).
 */

export const REFUND_REVIEW_MESSAGE = "Gutschrift – für welche Buchung war die Erstattung?";
/** Only recent credits are asked about, and purchases this far back are searched; a merchant's own ones up to half a year. */
const RECENT_DAYS = 60;
const MERCHANT_DAYS = 180;
const MAX_CANDIDATES = 6;
const DAY_MS = 86_400_000;

export type RefundCandidate = {
  booking: Transaction;
  /** Charged amount, positive. */
  paid: number;
  /** Already refunded by other linked credits, positive. */
  refunded: number;
  exact: boolean;
  /** What is left of the purchase minus the credit: positive when the purchase was a little more. */
  difference: number;
  sameMerchant: boolean;
};
export type RefundQuestion = {
  /** benefit: an Amex benefit credit; merchant: a credit naming its merchant; refund: any other refund. */
  kind: "benefit" | "merchant" | "refund";
  label: string;
  candidates: RefundCandidate[];
  /** The purchase the credit clearly belongs to, if any. */
  suggested?: string;
};

type Credit = Pick<Transaction, "id" | "date" | "amount" | "bank" | "description"> &
  Partial<Pick<Transaction, "pocket" | "merchantAlias" | "rawDescription" | "rawDetails" | "category" | "categoryOverride" |
    "sharedRefundFor" | "sharedRefundUnlinked" | "sharedRepaymentFor" | "ignored">> &
  { holidayRefundFor?: string; holidayReimbursementFor?: string; holidayRefundPending?: boolean };

const cents = (value: number) => Math.round(Math.abs(value) * 100);
const ageDays = (from: string, to: string) => (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS;

/** "A little less to a little more" than the credit, in cents: 10 % (at least 1 €) below, 30 % (at least 2 €) above. */
export function nearAmount(purchase: number, credit: number) {
  return purchase >= credit - Math.max(100, Math.round(credit * 0.1)) && purchase <= credit + Math.max(200, Math.round(credit * 0.3));
}

/** The card or account of a booking: the Amex main and partner card apart, other banks by account. */
export function refundAccount(row: Pick<Transaction, "bank" | "pocket">) {
  const booking = row as Transaction;
  if (isAmexCard(booking)) return isAmexPartnerCard(booking) ? "amex:partner" : "amex";
  return `${row.bank.trim().toLowerCase()}|${(row.pocket ?? "").trim().toLowerCase()}`;
}

// What an Amex benefit is meant for; `unknown`: a purchase still without category may be one (a restaurant abroad).
const benefitFits: { pattern: RegExp; categories: Category[]; unknown: boolean }[] = [
  { pattern: /gourmet|dining/i, categories: ["Restaurants", "Cafés & Snacks", "Mittagessen", "Lieferdienste"], unknown: true },
  { pattern: /entertainment|digital/i, categories: ["Entertainment", "Abonnements"], unknown: false },
  { pattern: /hotel|reise|travel/i, categories: ["Urlaub"], unknown: true },
  { pattern: /uber/i, categories: ["Mobilität", "Lieferdienste"], unknown: false },
];

/** Refund credits linked to each purchase so far, in cents. */
function refundedSoFar(transactions: readonly Transaction[], creditId: string) {
  const refunded = new Map<string, number>();
  for (const row of transactions) {
    if (row.id === creditId || row.amount <= 0 || !row.sharedRefundFor) continue;
    refunded.set(row.sharedRefundFor, (refunded.get(row.sharedRefundFor) ?? 0) + cents(row.amount));
  }
  return refunded;
}

/** The question for a credit, or nothing: not a refund, already decided, too old, or no purchase it could belong to. */
export function refundQuestion(state: AppState, credit: Credit, asOf = state.settings.asOf): RefundQuestion | undefined {
  // Settled with Raphael already, or waiting for that decision in the shared costs.
  if (credit.amount <= 0 || !credit.date || credit.ignored || credit.sharedRefundFor || credit.sharedRefundUnlinked ||
    credit.sharedRepaymentFor || credit.holidayRefundFor || credit.holidayReimbursementFor || credit.holidayRefundPending) return undefined;
  if (ageDays(credit.date, asOf) > RECENT_DAYS) return undefined;
  const row = { ...credit, pocket: credit.pocket ?? null, category: credit.category ?? "Prüfen", includeInPlan: true } as Transaction;
  if (isRaphaelPayment(row) || isNamedTransfer(row)) return undefined;
  const benefit = amexEntertainmentCredit(row);
  if (!benefit && canonicalCategory(classify(row).category) !== "Rückerstattungen") return undefined;
  const merchant = benefit ? undefined : merchantAliasSourceKey(row);

  const refunded = refundedSoFar(state.transactions, credit.id);
  const amount = cents(credit.amount);
  const account = refundAccount(row);
  const fit = benefit ? benefitFits.find((item) => item.pattern.test(benefit.detail)) : undefined;
  const scored: (RefundCandidate & { tier: number })[] = [];
  for (const purchase of state.transactions) {
    if (purchase.amount >= 0 || purchase.ignored || purchase.id === credit.id || purchase.date > credit.date) continue;
    if (refundAccount(purchase) !== account) continue;
    const same = !!merchant && merchantAliasSourceKey(purchase) === merchant;
    if (ageDays(purchase.date, credit.date) > (same ? MERCHANT_DAYS : RECENT_DAYS)) continue;
    const remaining = cents(purchase.amount) - (refunded.get(purchase.id) ?? 0);
    if (remaining <= 0) continue;
    const exact = remaining === amount;
    const near = !exact && nearAmount(remaining, amount);
    const larger = !exact && !near && remaining > amount;
    if (!exact && !near && !(larger && (same || fit))) continue;
    if (isNamedTransfer(purchase)) continue;
    const result = classify(purchase);
    const category = canonicalCategory(result.category);
    if (result.isTransfer || isIncomeCategory(category)) continue;
    // What speaks for the purchase besides the amount: the kind the benefit pays for, or the credit's own merchant.
    const preferred = fit ? fit.categories.includes(category) || (fit.unknown && category === "Prüfen") : merchant ? same : true;
    // A larger purchase only as a partial refund of a preferred one (a returned item, a capped benefit).
    if (larger && !preferred) continue;
    const tier = preferred ? exact ? 0 : near ? 1 : 2 : exact ? 3 : 4;
    scored.push({ booking: purchase, paid: cents(purchase.amount) / 100, refunded: (refunded.get(purchase.id) ?? 0) / 100, exact,
      difference: (remaining - amount) / 100, sameMerchant: same, tier });
  }
  if (!scored.length) return undefined;
  // Preferred purchases close to the amount; else a larger preferred one (partial refund); else those matching only by amount.
  const top = Math.min(...scored.map((item) => item.tier));
  const relevant = scored.filter((item) => top <= 1 ? item.tier <= 1 : top === 2 ? item.tier === 2 : true);
  relevant.sort((a, b) => a.tier - b.tier || Math.abs(a.difference) - Math.abs(b.difference) || b.booking.date.localeCompare(a.booking.date));
  // Preselected: the best match when nothing else is as good – never one that matches only roughly by amount.
  const best = relevant[0];
  const suggested = best.tier !== 4 && relevant.filter((item) => item.tier === best.tier).length === 1 ? best.booking.id : undefined;
  return { kind: benefit ? "benefit" : merchant ? "merchant" : "refund", label: benefit?.detail ?? "Rückerstattung",
    candidates: relevant.slice(0, MAX_CANDIDATES).map(({ tier: _tier, ...item }) => item), ...(suggested ? { suggested } : {}) };
}

/** What stays the user's own cost of a purchase after this credit. */
export const ownCostAfterRefund = (candidate: RefundCandidate, credit: number) =>
  Math.max(0, Math.round((candidate.paid - candidate.refunded - Math.abs(credit)) * 100) / 100);

/** The credit saved as a refund of the chosen purchase. */
export function linkedRefund<T extends Transaction>(credit: T, purchaseId: string): T {
  const { sharedRefundUnlinked: _unlinked, ...rest } = credit;
  return { ...rest, category: "Rückerstattungen", categoryOverride: true, manualCategory: true, reviewed: true, sharedRefundFor: purchaseId } as T;
}
