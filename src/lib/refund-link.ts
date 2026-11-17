import { classify } from "@/lib/calc";
import { amexEntertainmentCredit } from "@/lib/ai/booking-matchers";
import { canonicalCategory, type Category } from "@/lib/categories";
import { isIncomeCategory } from "@/lib/fixed";
import { merchantAliasSourceKey } from "@/lib/import/merchant-rules";
import { isRaphaelPayment } from "@/lib/shared-holiday";
import { isNamedTransfer } from "@/lib/transfers";
import type { AppState, Transaction } from "@/lib/types";

/**
 * Which purchase a credit refunds. Amex benefit credits ("Gourmet-Gutschrift") never name the restaurant, so the user picks
 * the purchase; a merchant's credit usually points to one purchase there, which only needs a confirmation. A linked credit
 * counts against the purchase's category (see `reconcileSharedHoliday`), so the purchase shows what was really paid.
 */

export const REFUND_REVIEW_MESSAGE = "Gutschrift – für welche Buchung war die Erstattung?";
/** Only recent credits are asked about; older ones stay as they are. */
const RECENT_DAYS = 60;
const MAX_CANDIDATES = 8;
const DAY_MS = 86_400_000;

export type RefundCandidate = {
  booking: Transaction;
  /** Charged amount, positive. */
  paid: number;
  /** Already refunded by other linked credits, positive. */
  refunded: number;
  exact: boolean;
};
export type RefundQuestion = {
  /** benefit: an Amex benefit credit – the user picks the purchase; merchant: a refund of that merchant. */
  kind: "benefit" | "merchant";
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

function isPurchase(row: Transaction) {
  if (row.amount >= 0 || row.ignored || isNamedTransfer(row)) return false;
  const result = classify(row);
  return !result.isTransfer && !isIncomeCategory(canonicalCategory(result.category));
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
  const merchant = benefit ? undefined : merchantAliasSourceKey(row);
  if (!benefit && !(merchant && canonicalCategory(classify(row).category) === "Rückerstattungen")) return undefined;

  const refunded = refundedSoFar(state.transactions, credit.id);
  const amount = cents(credit.amount);
  const window = benefit ? RECENT_DAYS : 180;
  const fit = benefit ? benefitFits.find((item) => item.pattern.test(benefit.detail)) : undefined;
  const candidates = state.transactions.filter((purchase) => {
    if (purchase.id === credit.id || purchase.date > credit.date || ageDays(purchase.date, credit.date) > window) return false;
    if (purchase.bank !== credit.bank || cents(purchase.amount) - (refunded.get(purchase.id) ?? 0) < amount) return false;
    if (merchant && merchantAliasSourceKey(purchase) !== merchant) return false;
    return isPurchase(purchase);
  }).map((purchase): RefundCandidate & { rank: number } => {
    const exact = cents(purchase.amount) - (refunded.get(purchase.id) ?? 0) === amount;
    const category = canonicalCategory(classify(purchase).category);
    // A benefit is matched by what it pays for first: the same amount at the wrong kind of place is chance.
    const fits = !fit || fit.categories.includes(category) || (fit.unknown && category === "Prüfen");
    return { booking: purchase, paid: cents(purchase.amount) / 100, refunded: (refunded.get(purchase.id) ?? 0) / 100, exact,
      rank: fits ? exact ? 0 : 1 : 2 };
  });
  // A benefit credit lists the purchases it fits; only without any it offers every charge on the card.
  const relevant = candidates.some((item) => item.rank < 2) ? candidates.filter((item) => item.rank < 2) : candidates;
  if (!relevant.length) return undefined;
  relevant.sort((a, b) => a.rank - b.rank || b.booking.date.localeCompare(a.booking.date));
  // Suggested: the one purchase that fits and has the credit's amount (or a merchant's only purchase).
  const exact = relevant.filter((item) => item.rank === 0);
  const suggested = exact.length === 1 ? exact[0].booking.id : !benefit && relevant.length === 1 ? relevant[0].booking.id : undefined;
  const sorted = relevant.slice(0, MAX_CANDIDATES).map(({ rank: _rank, ...item }) => item);
  return { kind: benefit ? "benefit" : "merchant", label: benefit?.detail ?? "Rückerstattung", candidates: sorted,
    ...(suggested ? { suggested } : {}) };
}

/** What stays the user's own cost of a purchase after this credit. */
export const ownCostAfterRefund = (candidate: RefundCandidate, credit: number) =>
  Math.max(0, Math.round((candidate.paid - candidate.refunded - Math.abs(credit)) * 100) / 100);

/** The credit saved as a refund of the chosen purchase. */
export function linkedRefund<T extends Transaction>(credit: T, purchaseId: string): T {
  const { sharedRefundUnlinked: _unlinked, ...rest } = credit;
  return { ...rest, category: "Rückerstattungen", categoryOverride: true, manualCategory: true, reviewed: true, sharedRefundFor: purchaseId } as T;
}
