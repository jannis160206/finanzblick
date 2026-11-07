import { isBankSyncRow } from "@/lib/import/bank-identity";
import type { Transaction } from "@/lib/types";

const DAY = 86_400_000;
const DATE_TOLERANCE_DAYS = 2;
const MIN_HITS = 2;
const MIN_SHARE = 0.5;

export type PocketMatchInput = { id: string; bank: string; turnovers: { booking_date: string; amount: number }[] };
export type PocketMatch = { pocket: string; hits: number; total: number };

/**
 * Finds the existing CSV pocket for each bank account by comparing its bank bookings
 * (amount exact, date ±2 days) with already imported rows of the same bank. Every pocket
 * is assigned at most once, best match first.
 */
export function matchPockets(
  accounts: PocketMatchInput[],
  existing: Pick<Transaction, "bank" | "pocket" | "date" | "amount" | "bankReference">[],
): Map<string, PocketMatch> {
  const byBank = new Map<string, { pocket: string; day: number; cents: number }[]>();
  for (const row of existing) {
    if (!row.pocket || isBankSyncRow(row)) continue;
    const day = Date.parse(row.date.slice(0, 10));
    if (!Number.isFinite(day)) continue;
    const list = byBank.get(row.bank) ?? [];
    list.push({ pocket: row.pocket, day, cents: Math.round(row.amount * 100) });
    byBank.set(row.bank, list);
  }
  const candidates: { account: string; pocket: string; hits: number; total: number }[] = [];
  for (const account of accounts) {
    const rows = byBank.get(account.bank) ?? [];
    const scores = new Map<string, number>();
    for (const turnover of account.turnovers) {
      const day = Date.parse(turnover.booking_date.slice(0, 10));
      const cents = Math.round(turnover.amount * 100);
      if (!Number.isFinite(day) || cents === 0) continue;
      const pockets = new Set<string>();
      for (const row of rows) if (row.cents === cents && Math.abs(row.day - day) <= DATE_TOLERANCE_DAYS * DAY) pockets.add(row.pocket);
      for (const pocket of pockets) scores.set(pocket, (scores.get(pocket) ?? 0) + 1);
    }
    const total = account.turnovers.length;
    for (const [pocket, hits] of scores)
      if (hits >= MIN_HITS && hits >= total * MIN_SHARE) candidates.push({ account: account.id, pocket, hits, total });
  }
  candidates.sort((a, b) => b.hits / b.total - a.hits / a.total || b.hits - a.hits);
  const result = new Map<string, PocketMatch>();
  const taken = new Set<string>();
  for (const candidate of candidates) {
    if (result.has(candidate.account) || taken.has(candidate.pocket)) continue;
    result.set(candidate.account, { pocket: candidate.pocket, hits: candidate.hits, total: candidate.total });
    taken.add(candidate.pocket);
  }
  return result;
}
