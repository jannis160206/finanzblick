import type { AppState, PlannedOneOff, Transaction } from "@/lib/types";
import { hasManualCategory } from "@/lib/manual-category";
import { matchPlannedOneOffs, plannedOccurrences } from "@/lib/planned-one-offs";
import { isNamedTransfer } from "@/lib/transfers";
import { merchantAliasSourceKey } from "@/lib/import/merchant-rules";
import type { SharedSettlementFields } from "@/lib/shared-refund-schema";

export const alwaysLunch = (text: string) => /bipa|hotspot|mensa|mensen/i.test(text);
const travelMerchant = /\bswiss(?:\s*(?:air|international))?\b|\bryanair\b|\beasy\s*jet\b|booking\s*\.\s*com|\bairbnb\b|\blufthansa\b|\baustrian(?:\s*airlines)?\b|\beurowings\b|\bwizz\s*air\b|\bcondor\b|\b(?:klm|airfrance|iberia|vueling|transavia|finnair|norwegian|emirates|qatar\s*airways|turkish\s*airlines|british\s*airways|tap\s*air|delta\s*airlines|united\s*airlines)\b|\bair\s*france\b|\b(?:expedia|bravofly|lastminute|agoda|hotels\.com|trip\.com|opodo|edreams)\b/i;
export const isTravelMerchant = (description: string) => travelMerchant.test(description);
export function isSharedHoliday(row: Pick<Transaction, "amount"> & Partial<Pick<Transaction, "sharedWithRaphael" | "description" | "rawDescription" | "merchantAlias">>) {
  return row.amount < 0 && row.sharedWithRaphael === true && !isNamedTransfer({ ...row, description: row.description ?? "" });
}
export const isRaphaelPayment = (row: Pick<Transaction, "description" | "amount"> & Partial<Pick<Transaction, "rawDescription" | "rawDetails">>) =>
  row.amount > 0 && /\b(?:raphael|piber)\b/i.test([row.description, row.rawDescription, ...(row.rawDetails ?? [])].join(" "));
export type AccountedTransaction = Transaction & SharedSettlementFields & {
  holidayReimbursementFor?: string;
  holidayRefundFor?: string;
  holidayPersonalRefund?: number;
  holidayRefundPending?: boolean;
  holidayRange?: boolean;
};
export type HolidayReceivable = {
  bookingId: string;
  date: string;
  description: string;
  fullAmount: number;
  status: "Offen" | "Bezahlt";
  ownSpend: number;
  amount: number;
  outstanding: number;
  repaymentId?: string;
  repaymentAmount?: number;
  refundedAmount: number;
  partnerPaid: number;
  overpaid: number;
};
const cents = (value: number) => Math.round(Math.abs(value) * 100);
export type SharedRefundReview = { refundId: string; candidateIds: string[]; reason: "ambiguous" | "invalid-link" };

// All settlement annotations are derived from immutable bank bookings.
export function reconcileSharedHoliday(rows: (Transaction & SharedSettlementFields)[], asOf = "9999-12-31", planned: PlannedOneOff[] = [],
  categoryFor: (row: Transaction) => Transaction["category"] = (row) => row.category) {
  rows = [...new Map(rows.map((row) => [row.id, row])).values()];
  const occurrences = matchPlannedOneOffs(planned, rows);
  const matched = new Map(occurrences.filter((item) => item.bookingId && item.sharedWithRaphael).map((item) => [item.bookingId, item]));
  rows = rows.map((row) => {
    const item = matched.get(row.id);
    return item ? { ...row, sharedWithRaphael: true, sharedPaidManually: row.sharedPaidManually || item.sharedPaidManually } : row;
  });
  const pending: Transaction[] = occurrences.filter((item) => !item.bookingId && item.sharedWithRaphael).map((item) => ({
    id: item.id, description: item.name, date: item.date, amount: -item.amount,
    bank: "Geplant", pocket: item.pocket, category: "Shopping", includeInPlan: false,
    sharedWithRaphael: true, sharedPaidManually: item.sharedPaidManually,
  }));
  const receivables = [...rows.filter(isSharedHoliday), ...pending].map((row): HolidayReceivable => {
    const total = cents(row.amount);
    const own = Math.round(total / 2);
    return { bookingId: row.id, date: row.date, description: row.description, fullAmount: total / 100,
      status: row.sharedPaidManually ? "Bezahlt" : "Offen",
      ownSpend: own / 100, amount: (total - own) / 100, outstanding: row.sharedPaidManually ? 0 : (total - own) / 100,
      refundedAmount: 0, partnerPaid: 0, overpaid: 0 };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.bookingId.localeCompare(b.bookingId));
  const byId = new Map(receivables.map((item) => [item.bookingId, item]));
  const manualPaid = new Map([...rows.filter(isSharedHoliday), ...pending].filter((row) => row.sharedPaidManually)
    .map((row) => [row.id, row.sharedPaidAmount === undefined
      ? cents(row.amount) - Math.round(cents(row.amount) / 2) : cents(row.sharedPaidAmount)]));
  const purchases = rows.filter((row) => row.amount < 0 && !isNamedTransfer(row));
  const purchaseById = new Map(purchases.map((row) => [row.id, row]));
  const merchantPurchases = new Map<string, Transaction[]>();
  const refundKey = (row: Transaction) => {
    const merchant = merchantAliasSourceKey(row);
    return merchant ? `${merchant}|${(row.pocket ?? "").toLocaleLowerCase("de-AT")}` : undefined;
  };
  for (const purchase of purchases) {
    const key = refundKey(purchase);
    if (key) merchantPurchases.set(key, [...(merchantPurchases.get(key) ?? []), purchase]);
  }
  const returned = new Map<string, number>();
  const refunds = new Map<string, { bookingId: string; personal: number }>();
  const refundReviews: SharedRefundReview[] = [];
  const repayments = new Map<string, string>();
  const accepted = new Map<string, number>();
  const incoming = rows.filter((row) => row.date <= asOf && row.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const updateBalance = (item: HolidayReceivable) => {
    const paid = Math.max(cents(item.partnerPaid), manualPaid.get(item.bookingId) ?? 0);
    item.outstanding = Math.max(0, cents(item.amount) - Math.max(paid, accepted.get(item.bookingId) ?? 0)) / 100;
    item.overpaid = Math.max(0, paid - cents(item.amount)) / 100;
    item.status = item.outstanding ? "Offen" : "Bezahlt";
  };
  for (const row of incoming) {
    const partnerPayment = row.sharedRepaymentFor || (!row.sharedRefundFor && !row.sharedRefundUnlinked && isRaphaelPayment(row) &&
      (!hasManualCategory(row) || row.category === "Transfer" || row.category === "Transfer intern"));
    if (partnerPayment) {
      // Keep the existing near-full-payment policy; partial payments require a source decision.
      const match = row.sharedRepaymentFor ? byId.get(row.sharedRepaymentFor) : receivables.find((item) => {
        if (!(item.date <= row.date || item.bookingId.startsWith("planned:") || matched.has(item.bookingId))) return false;
        const originalShare = cents(item.fullAmount) - Math.round(cents(item.fullAmount) / 2);
        const near = (amount: number) => Math.abs(amount - cents(row.amount)) <= Math.max(500, amount * 0.03);
        return (item.status === "Offen" && near(cents(item.outstanding))) ||
          (item.refundedAmount > 0 && item.partnerPaid === 0 && !manualPaid.has(item.bookingId) && near(originalShare));
      });
      if (!match) continue;
      match.repaymentId ??= row.id;
      match.repaymentAmount = (cents(match.repaymentAmount ?? 0) + cents(row.amount)) / 100;
      match.partnerPaid = (cents(match.partnerPaid) + cents(row.amount)) / 100;
      if (!row.sharedRepaymentFor) accepted.set(match.bookingId, cents(match.amount));
      updateBalance(match);
      repayments.set(row.id, match.bookingId);
      continue;
    }
    if (row.sharedRefundUnlinked || isNamedTransfer(row)) continue;
    const merchant = refundKey(row);
    const available = (purchase: Transaction) => purchase.date <= row.date &&
      cents(purchase.amount) - (returned.get(purchase.id) ?? 0) >= cents(row.amount);
    const related = (merchant ? merchantPurchases.get(merchant) ?? [] : []).filter((purchase) => purchase.date <= row.date);
    const candidates = related.filter(available);
    const explicit = row.sharedRefundFor ? purchaseById.get(row.sharedRefundFor) : undefined;
    const source = row.sharedRefundFor
      ? explicit && byId.has(explicit.id) && available(explicit) ? explicit : undefined
      : candidates.length === 1 ? candidates[0] : undefined;
    if (!source) {
      if (row.sharedRefundFor || related.some((purchase) => byId.has(purchase.id)))
        refundReviews.push({ refundId: row.id, candidateIds: related.filter((purchase) => byId.has(purchase.id)).map((purchase) => purchase.id),
          reason: row.sharedRefundFor ? "invalid-link" : "ambiguous" });
      continue;
    }
    const before = returned.get(source.id) ?? 0;
    const after = before + cents(row.amount);
    returned.set(source.id, after);
    const item = byId.get(source.id);
    if (!item) continue;
    const gross = cents(source.amount);
    const own = Math.round(gross / 2);
    const ownReturned = Math.round(after * own / gross);
    const personal = ownReturned - Math.round(before * own / gross);
    item.refundedAmount = after / 100;
    item.ownSpend = (own - ownReturned) / 100;
    item.amount = (gross - own - (after - ownReturned)) / 100;
    updateBalance(item);
    refunds.set(row.id, { bookingId: source.id, personal: personal / 100 });
  }
  for (const item of receivables) {
    item.partnerPaid = Math.max(cents(item.partnerPaid), manualPaid.get(item.bookingId) ?? 0) / 100;
    updateBalance(item);
  }
  const pendingRefunds = new Set(refundReviews.map((item) => item.refundId));
  const bookings: AccountedTransaction[] = rows.map((row) => {
    const bankRow: AccountedTransaction = { ...row };
    delete bankRow.holidayReimbursementFor;
    delete bankRow.holidayRefundFor;
    delete bankRow.holidayPersonalRefund;
    delete bankRow.holidayRefundPending;
    const bookingId = repayments.get(row.id);
    if (bookingId) return { ...bankRow, holidayReimbursementFor: bookingId };
    const refund = refunds.get(row.id);
    if (refund) {
      const source = purchaseById.get(refund.bookingId)!;
      return { ...bankRow, category: categoryFor(source), categoryOverride: true, manualCategory: source.manualCategory,
        includeInPlan: source.includeInPlan, fixedCost: source.fixedCost,
        holidayRefundFor: refund.bookingId, holidayPersonalRefund: refund.personal };
    }
    return pendingRefunds.has(row.id) ? { ...bankRow, holidayRefundPending: true } : bankRow;
  });
  return { bookings, receivables, refundReviews };
}

export function personalAmount(row: AccountedTransaction): number {
  if (row.holidayReimbursementFor && (row.sharedRepaymentFor || !hasManualCategory(row) || row.category === "Transfer" || row.category === "Transfer intern")) return 0;
  if (row.holidayRefundFor) return row.holidayPersonalRefund ?? row.amount;
  return isSharedHoliday(row) ? -Math.round(cents(row.amount) / 2) / 100 : row.amount;
}

export function decideSharedSettlement(state: AppState, incomingId: string, sourceId: string | null, kind: "refund" | "repayment" = "refund"): AppState {
  const apply = (row: Transaction, id = row.id): Transaction => {
    if (id !== incomingId || row.amount <= 0) return row;
    const next: Transaction & SharedSettlementFields = { ...row };
    delete next.sharedRefundFor;
    delete next.sharedRefundUnlinked;
    delete next.sharedRepaymentFor;
    if (kind === "repayment" && sourceId) next.sharedRepaymentFor = sourceId;
    else if (sourceId) next.sharedRefundFor = sourceId;
    else next.sharedRefundUnlinked = true;
    return next;
  };
  return { ...state, transactions: state.transactions.map((row) => apply(row)),
    ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((receipt) =>
      receipt.booking ? { ...receipt, booking: apply(receipt.booking, receipt.key) } : receipt) } : {}) };
}

// Only selection/status changes are persisted; bank date and full amount never change.
export function selectSharedBookings(state: AppState, ids: string[], paid = false): AppState {
  const selected = new Set(ids);
  const confirmedAmounts = new Map<string, number>();
  if (paid) {
    const rows = [...state.transactions, ...(state.fixedReceipts ?? []).flatMap((receipt) =>
      receipt.booking ? [{ ...receipt.booking, id: receipt.key, date: receipt.date, amount: receipt.amount }] : [])];
    for (const item of reconcileSharedHoliday(rows, state.settings.asOf, state.plannedOneOffs).receivables) {
      if (selected.has(item.bookingId) && item.refundedAmount > 0)
        confirmedAmounts.set(item.bookingId, Math.max(item.partnerPaid, item.amount));
    }
  }
  const apply = (row: Transaction, id = row.id): Transaction => selected.has(id) && row.amount < 0
    ? { ...row, sharedWithRaphael: true, ...(paid ? { sharedPaidManually: true,
      ...(confirmedAmounts.has(id) ? { sharedPaidAmount: confirmedAmounts.get(id) } : {}) } : {}) } : row;
  return { ...state,
    ...(state.plannedOneOffs && paid ? { plannedOneOffs: state.plannedOneOffs.map((item) => {
      const dates = plannedOccurrences([item]).filter((occurrence) => selected.has(occurrence.id)).map((occurrence) => occurrence.date);
      return dates.length ? { ...item, paidOccurrences: [...new Set([...(item.paidOccurrences ?? []), ...dates])] } : item;
    }) } : {}),
    transactions: state.transactions.map((row) => apply(row)),
    ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((receipt) => {
      if (!selected.has(receipt.key)) return receipt;
      const booking = receipt.booking ?? { id: receipt.key, description: receipt.category, date: receipt.date,
        amount: receipt.amount, category: receipt.category, bank: "Auszugsbeleg", pocket: null, includeInPlan: false };
      return { ...receipt, booking: apply(booking, receipt.key) };
    }) } : {}),
  };
}
