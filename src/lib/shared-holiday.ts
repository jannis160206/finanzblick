import type { AppState, Transaction } from "@/lib/types";

export const alwaysLunch = (text: string) => /bipa|hotspot|mensa|mensen/i.test(text);
const travelMerchant = /\bswiss(?:\s*(?:air|international))?\b|\bryanair\b|\beasy\s*jet\b|booking\s*\.\s*com|\bairbnb\b|\blufthansa\b|\baustrian(?:\s*airlines)?\b|\beurowings\b|\bwizz\s*air\b|\bcondor\b|\b(?:klm|airfrance|iberia|vueling|transavia|finnair|norwegian|emirates|qatar\s*airways|turkish\s*airlines|british\s*airways|tap\s*air|delta\s*airlines|united\s*airlines)\b|\bair\s*france\b|\b(?:expedia|bravofly|lastminute|agoda|hotels\.com|trip\.com|opodo|edreams)\b/i;
export const isTravelMerchant = (description: string) => travelMerchant.test(description);
export function isSharedHoliday(row: Pick<Transaction, "amount"> & Partial<Pick<Transaction, "sharedWithRaphael">>) {
  return row.amount < 0 && row.sharedWithRaphael === true;
}
export const isRaphaelPayment = (row: Pick<Transaction, "description" | "amount"> & Partial<Pick<Transaction, "rawDescription" | "rawDetails">>) =>
  row.amount > 0 && /\b(?:raphael|piber)\b/i.test([row.description, row.rawDescription, ...(row.rawDetails ?? [])].join(" "));
export type AccountedTransaction = Transaction & { holidayReimbursementFor?: string; holidayRange?: boolean };
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
};
const cents = (value: number) => Math.round(Math.abs(value) * 100);

// Recompute from immutable bank bookings: imports, deletion and reload cannot
// leave stale matches behind. One incoming booking clears at most one half.
export function reconcileSharedHoliday(rows: Transaction[], asOf = "9999-12-31") {
  const receivables = rows.filter(isSharedHoliday).map((row): HolidayReceivable => {
    const total = cents(row.amount);
    const own = Math.round(total / 2);
    return { bookingId: row.id, date: row.date, description: row.description, fullAmount: total / 100,
      status: row.sharedPaidManually ? "Bezahlt" : "Offen",
      ownSpend: own / 100, amount: (total - own) / 100, outstanding: row.sharedPaidManually ? 0 : (total - own) / 100 };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.bookingId.localeCompare(b.bookingId));
  const repayments = new Map<string, string>();
  const incoming = rows.filter((row) => row.date <= asOf && isRaphaelPayment(row))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const row of incoming) {
    // No arbitrary expiry: his transfer may arrive weeks after the charge.
    const match = receivables.find((item) => item.status === "Offen" && item.date <= row.date &&
      Math.abs(cents(item.amount) - cents(row.amount)) <= Math.max(500, cents(item.amount) * 0.03));
    if (!match) continue;
    match.repaymentId = row.id;
    match.repaymentAmount = row.amount;
    match.outstanding = 0;
    match.status = "Bezahlt";
    repayments.set(row.id, match.bookingId);
  }
  const bookings: AccountedTransaction[] = rows.map((row) => {
    const bankRow: AccountedTransaction = { ...row };
    delete bankRow.holidayReimbursementFor;
    const bookingId = repayments.get(row.id);
    return bookingId ? { ...bankRow, holidayReimbursementFor: bookingId } : bankRow;
  });
  return { bookings, receivables };
}

export function personalAmount(row: AccountedTransaction): number {
  if (row.holidayReimbursementFor) return 0;
  return isSharedHoliday(row) ? -Math.round(cents(row.amount) / 2) / 100 : row.amount;
}

// Only selection/status changes are persisted; bank date and full amount never change.
export function selectSharedBookings(state: AppState, ids: string[], paid = false): AppState {
  const selected = new Set(ids);
  const apply = (row: Transaction, id = row.id): Transaction => selected.has(id) && row.amount < 0
    ? { ...row, sharedWithRaphael: true, ...(paid ? { sharedPaidManually: true } : {}) } : row;
  return { ...state,
    transactions: state.transactions.map((row) => apply(row)),
    ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((receipt) => {
      if (!selected.has(receipt.key)) return receipt;
      const booking = receipt.booking ?? { id: receipt.key, description: receipt.category, date: receipt.date,
        amount: receipt.amount, category: receipt.category, bank: "Auszugsbeleg", pocket: null, includeInPlan: false };
      return { ...receipt, booking: apply(booking, receipt.key) };
    }) } : {}),
  };
}
