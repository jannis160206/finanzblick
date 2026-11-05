import { actualBookings, classify } from "@/lib/calc";
import { canonicalCategory, type Category } from "@/lib/categories";
import { isIncomeCategory } from "@/lib/fixed";
import { isRaphaelPayment, reconcileSharedHoliday } from "@/lib/shared-holiday";
import { transactionSchema, type AppState, type Transaction } from "@/lib/types";

export type MatcherDraft = Pick<Transaction, "id" | "amount" | "description"> &
  Partial<Pick<Transaction, "date" | "bank" | "pocket" | "rawDescription" | "rawDetails" | "merchantAlias">>;
export type MatchedCategory = { category: Category; detail: string; merchantAlias?: string; refund?: boolean };

const DAY_MS = 86_400_000;
const cents = (value: number) => Math.round(Math.abs(value) * 100);
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS;
const isAmex = (bank?: string) => /^(?:amex|american\s+express)$/i.test(bank?.trim() ?? "");
const fullText = (row: MatcherDraft) =>
  [row.merchantAlias, row.description, row.rawDescription, ...(row.rawDetails ?? [])].filter(Boolean).join(" ");

type Dated = MatcherDraft & { date: string };
// Ledger rows and open review drafts, so pairs are found even when both sides still wait for review.
function bookingsAndDrafts(state: AppState): (Dated & { open: boolean })[] {
  const drafts = (state.reviewQueue ?? []).flatMap((item) =>
    item.kind === "booking" && item.draft.amount !== null && item.draft.date
      ? [{ ...item.draft, amount: item.draft.amount, open: true }] : []);
  return [...state.transactions.map((row) => ({ ...row, open: false })), ...drafts];
}

// Amex reimburses benefit purchases ("Entertainment", "Gourmet", …) with a credit of that name.
const AMEX_BENEFIT = /\b(entertainment|gourmet|hotel|reise|travel|uber|digital|dining|lifestyle)[-\s]+gutschrift\b/i;
export function amexEntertainmentCredit(draft: MatcherDraft): MatchedCategory | undefined {
  const benefit = draft.amount > 0 && isAmex(draft.bank) ? draft.description.match(AMEX_BENEFIT)?.[1] : undefined;
  if (!benefit) return;
  return { category: "Rückerstattungen", detail: `Amex ${benefit[0].toUpperCase()}${benefit.slice(1).toLowerCase()}-Gutschrift` };
}

const RETURNED_DEBIT = /\br(?:ü|ue|u)cklastschrift\b/i;
const RETURNED_FEE = /geb(?:ü|ue|u)hr|entgelt|kosten/i;
const PAYMENT_RECEIVED = /\bzahlung\s+erhalten\b/i;
const isReturnedDebit = (row: MatcherDraft) =>
  row.amount < 0 && RETURNED_DEBIT.test(row.description) && !RETURNED_FEE.test(row.description);
const isPaymentReceived = (row: MatcherDraft) => row.amount > 0 && PAYMENT_RECEIVED.test(row.description);

// A bounced card payment and the payment that replaced it cancel each other out.
export function returnedDebitPair(state: AppState, draft: MatcherDraft): MatchedCategory | undefined {
  if (!draft.date || !isAmex(draft.bank)) return;
  const returned = isReturnedDebit(draft);
  if (!returned && !isPaymentReceived(draft)) return;
  const partner = bookingsAndDrafts(state).filter((row) => row.id !== draft.id && isAmex(row.bank) &&
    cents(row.amount) === cents(draft.amount) && (returned ? isPaymentReceived(row) : isReturnedDebit(row)))
    .map((row) => ({ row, gap: returned ? daysBetween(draft.date!, row.date) : daysBetween(row.date, draft.date!) }))
    .filter(({ gap }) => gap >= 0 && gap <= 14)
    .sort((left, right) => left.gap - right.gap)[0]?.row;
  if (!partner) return;
  return { category: "Transfer intern",
    detail: returned ? `Rücklastschrift, ausgeglichen am ${partner.date}` : `gleicht Rücklastschrift vom ${partner.date} aus` };
}

// "SONSTIGE GUTSCHRIFT 145,71" reverses the one Amex charge of exactly that amount shortly before.
const AMEX_GENERIC_CREDIT = /^\s*(?:sonstige\s+gutschrift|umbuchung\s+der\s+belastung|gutschrift)\s*$/i;
export function amexReversalPair(state: AppState, draft: MatcherDraft): MatchedCategory | undefined {
  if (draft.amount <= 0 || !draft.date || !isAmex(draft.bank) || !AMEX_GENERIC_CREDIT.test(draft.description)) return;
  const charges = bookingsAndDrafts(state).filter((row) => row.id !== draft.id && row.amount < 0 && isAmex(row.bank) &&
    cents(row.amount) === cents(draft.amount) && daysBetween(row.date, draft.date!) >= 0 && daysBetween(row.date, draft.date!) <= 30);
  if (charges.length !== 1) return;
  return { category: "Rückerstattungen", refund: true, detail: `storniert „${charges[0].description.slice(0, 40)}“ vom ${charges[0].date}` };
}

const PAYPAL = /pay\s*pal/i;
const isPaypal = (row: MatcherDraft) => PAYPAL.test(fullText(row));
// "1051861566294/PAYPAL": the bank shows only PayPal's mandate, not the shop.
export const isAnonymousPaypal = (row: MatcherDraft) => /^\s*[a-z]*\d{6,}\s*\/\s*pay\s*pal\s*$/i.test(row.description);

// A PayPal credit repays the latest PayPal debit of exactly that amount on the same account.
export function paypalCreditPair(state: AppState, draft: MatcherDraft): MatchedCategory | undefined {
  if (draft.amount <= 0 || !draft.date || !isPaypal(draft) || !isAnonymousPaypal(draft)) return;
  const origin = bookingsAndDrafts(state).filter((row) => row.id !== draft.id && row.amount < 0 &&
    cents(row.amount) === cents(draft.amount) && row.bank === draft.bank && isPaypal(row) &&
    daysBetween(row.date, draft.date!) >= 0 && daysBetween(row.date, draft.date!) <= 60)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  if (!origin) return;
  return { category: "Rückerstattungen", refund: true, detail: `PayPal-Abbuchung vom ${origin.date}`,
    ...(origin.merchantAlias && !isAnonymousPaypal({ ...origin, description: origin.merchantAlias }) ? { merchantAlias: origin.merchantAlias } : {}) };
}

// Identical anonymous PayPal debits in three or more months look like a subscription.
export function paypalRecurringMonths(state: AppState, draft: MatcherDraft) {
  // PayPal verifies accounts with tiny charges; those are no subscription.
  if (draft.amount > -1.5 || draft.merchantAlias || !isAnonymousPaypal(draft)) return 0;
  return new Set(bookingsAndDrafts(state).filter((row) => row.amount < 0 && row.bank === draft.bank &&
    cents(row.amount) === cents(draft.amount) && isAnonymousPaypal(row)).map((row) => row.date.slice(0, 7))).size;
}

// Keywords in the partner's transfer note name what the money was for.
const PARTNER_PURPOSES: [RegExp, Category][] = [
  [/tank/i, "Tanken"],
  [/k(?:ä|ae|a)ff|kaffee|coffee|\bcaf[eé]\b/i, "Cafés & Snacks"],
  [/flug|urlaub|hotel|reise|airbnb|unterkunft|ferien/i, "Urlaub"],
  [/vignette|\bmaut\b|parken|parkplatz|parkgeb/i, "Parken & Maut"],
  [/geburtstag|geschenk/i, "Geschenke & Spenden"],
  [/schmaus|restaurant|abendessen|dinner|pizza|sushi/i, "Restaurants"],
  [/lebensmittel|supermarkt|wocheneinkauf/i, "Lebensmittel"],
  [/shopping|\bkaufi\b|kleid|klamotte|\bhosi\b|\bhose\b/i, "Shopping"],
  [/\bstrom\b|heizung|nebenkosten/i, "Energie & Nebenkosten"],
];
const PARTNER_NOISE = /\b(?:auftraggeber|zahlungsreferenz|verwendungszweck|raphael|piber|iban|bic)\b[:\s]*/gi;

export function partnerPurpose(note: string): Category | undefined {
  const text = note.replace(PARTNER_NOISE, " ");
  const matches = new Set(PARTNER_PURPOSES.filter(([pattern]) => pattern.test(text)).map(([, category]) => category));
  return matches.size === 1 ? [...matches][0] : undefined;
}

// The partner's share of a purchase reduces that category's own spending.
export function partnerContribution(state: AppState, draft: MatcherDraft): MatchedCategory | undefined {
  if (!isRaphaelPayment(draft)) return;
  const category = partnerPurpose(draft.description);
  if (!category) return;
  const row = transactionSchema.safeParse(draft);
  if (!row.success) return;
  // A repayment of a shared booking already settles that receivable; categorizing would detach it.
  const settled = reconcileSharedHoliday([...actualBookings(state), row.data], state.settings.asOf, state.plannedOneOffs)
    .bookings.find((item) => item.id === draft.id);
  if (settled?.holidayReimbursementFor) return;
  return { category, detail: `Kostenbeteiligung von Raphael („${draft.description.slice(0, 60)}“)` };
}

const isSpending = (row: Transaction) => {
  const result = classify(row);
  const category = canonicalCategory(result.category);
  return !result.isTransfer && category !== "Prüfen" && !category.startsWith("Transfer") && !isIncomeCategory(category);
};
export { isSpending as isRefundableSpending };
