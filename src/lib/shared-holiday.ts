import type { Transaction } from "@/lib/types";

export const alwaysLunch = (text: string) => /bipa|hotspot|mensa|mensen/i.test(text);
const travelMerchant = /\bswiss(?:\s*(?:air|international))?\b|\bryanair\b|\beasy\s*jet\b|booking\s*\.\s*com|\bairbnb\b|\blufthansa\b|\baustrian(?:\s*airlines)?\b|\beurowings\b|\bwizz\s*air\b|\bcondor\b|\b(?:klm|airfrance|iberia|vueling|transavia|finnair|norwegian|emirates|qatar\s*airways|turkish\s*airlines|british\s*airways|tap\s*air|delta\s*airlines|united\s*airlines)\b|\bair\s*france\b|\b(?:expedia|bravofly|lastminute|agoda|hotels\.com|trip\.com|opodo|edreams)\b/i;
export function isSharedHoliday(row: Pick<Transaction, "description" | "amount">) {
  return row.amount < 0 && !alwaysLunch(row.description) && travelMerchant.test(row.description);
}
export type AccountedTransaction = Transaction & { holidayReimbursementFor?: string };
export type HolidayReceivable = {
  bookingId: string;
  date: string;
  description: string;
  ownSpend: number;
  amount: number;
  outstanding: number;
  repaymentId?: string;
  repaymentAmount?: number;
};
const cents = (value: number) => Math.round(Math.abs(value) * 100);

// Recompute from immutable bank bookings: imports, deletion and reload cannot
// leave stale matches behind. One incoming booking clears at most one half.
export function reconcileSharedHoliday(rows: Transaction[]) {
  const receivables: HolidayReceivable[] = rows.filter(isSharedHoliday).map((row) => {
    const total = cents(row.amount);
    const own = Math.round(total / 2);
    return { bookingId: row.id, date: row.date, description: row.description,
      ownSpend: own / 100, amount: (total - own) / 100, outstanding: (total - own) / 100 };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.bookingId.localeCompare(b.bookingId));
  const repayments = new Map<string, string>();
  const incoming = rows.filter((row) => row.amount > 0 &&
    /\bpiber\b/i.test(row.description) && /\braphael\b/i.test(row.description)
  ).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const row of incoming) {
    // No arbitrary expiry: his transfer may arrive weeks after the charge.
    const match = receivables.filter((item) => !item.repaymentId && item.date <= row.date &&
      Math.abs(cents(item.amount) - cents(row.amount)) <= 500
    ).sort((a, b) => Math.abs(a.amount - row.amount) - Math.abs(b.amount - row.amount) ||
      a.date.localeCompare(b.date) || a.bookingId.localeCompare(b.bookingId))[0];
    if (!match) continue;
    match.repaymentId = row.id;
    match.repaymentAmount = row.amount;
    match.outstanding = 0;
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
