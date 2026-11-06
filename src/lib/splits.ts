import { canonicalCategory, type Category } from "@/lib/categories";
import type { Transaction } from "@/lib/types";

export type TransactionSplit = NonNullable<Transaction["splits"]>[number];
export type CategoryPart = { category: Category; amount: number; share: number; note?: string };

const cents = (value: number) => Math.round(value * 100);

/** Splits count only when every part has the booking's sign and all parts add up to the booking to the cent. */
export function validSplits(transaction: Pick<Transaction, "amount" | "splits">): transaction is Pick<Transaction, "amount"> & { splits: TransactionSplit[] } {
  const splits = transaction.splits;
  if (!splits || splits.length < 2) return false;
  const sign = Math.sign(transaction.amount);
  if (splits.some((part) => Math.sign(part.amount) !== sign)) return false;
  return splits.reduce((total, part) => total + cents(part.amount), 0) === cents(transaction.amount);
}

/**
 * The single place that decides how a booking is spread across categories.
 * Without (valid) splits the booking is one part in `fallback`, usually `classify(tx).category`.
 * `share` lets callers scale derived amounts such as the personal share of a shared booking.
 */
export function categoryParts(
  transaction: Pick<Transaction, "amount" | "splits">,
  fallback: Category,
): CategoryPart[] {
  if (!validSplits(transaction)) return [{ category: fallback, amount: transaction.amount, share: 1 }];
  const merged = new Map<Category, CategoryPart>();
  for (const part of transaction.splits) {
    const category = canonicalCategory(part.category);
    const existing = merged.get(category);
    if (existing) existing.amount = Math.round((existing.amount + part.amount) * 100) / 100;
    else merged.set(category, { category, amount: part.amount, share: 0, ...(part.note ? { note: part.note } : {}) });
  }
  return [...merged.values()].map((part) => ({ ...part, share: part.amount / transaction.amount }));
}

export type SplitGroup = { category: Category; amount: number; note?: string };
export type SplitPlan = {
  /** Parts with the booking's sign that add up exactly to the booking amount. */
  splits: TransactionSplit[];
  /** Sum of the receipt groups (positive = spent). */
  receiptTotal: number;
  /** Booking amount minus receipt total, both as positive spending; 0 when they match. */
  difference: number;
};

/**
 * Scales receipt category totals to the booking amount and rounds them with the largest-remainder
 * method, so the stored splits always add up to the booking to the cent.
 */
export function buildSplits(groups: SplitGroup[], bookingAmount: number): SplitPlan {
  const target = Math.abs(cents(bookingAmount));
  const merged = new Map<Category, { amount: number; notes: string[] }>();
  for (const group of groups) {
    const category = canonicalCategory(group.category);
    const entry = merged.get(category) ?? { amount: 0, notes: [] };
    entry.amount += cents(group.amount);
    if (group.note && !entry.notes.includes(group.note)) entry.notes.push(group.note);
    merged.set(category, entry);
  }
  // Discounts can leave a category negative; fold such leftovers into the largest category.
  let entries = [...merged].map(([category, entry]) => ({ category, ...entry }));
  const negative = entries.filter((entry) => entry.amount <= 0);
  entries = entries.filter((entry) => entry.amount > 0).sort((a, b) => b.amount - a.amount);
  if (entries.length && negative.length) entries[0].amount += negative.reduce((total, entry) => total + entry.amount, 0);
  entries = entries.filter((entry) => entry.amount > 0);
  const receipt = entries.reduce((total, entry) => total + entry.amount, 0);
  const receiptTotal = receipt / 100;
  if (!target || !receipt) return { splits: [], receiptTotal, difference: target / 100 - receiptTotal };
  const raw = entries.map((entry) => (entry.amount * target) / receipt);
  const floors = raw.map(Math.floor);
  let rest = target - floors.reduce((total, value) => total + value, 0);
  const order = raw.map((value, index) => ({ index, remainder: value - floors[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (rest <= 0) break;
    floors[index]++;
    rest--;
  }
  const sign = bookingAmount < 0 ? -1 : 1;
  const splits = entries
    .map((entry, index) => ({
      category: entry.category,
      amount: (sign * floors[index]) / 100,
      ...(entry.notes.length ? { note: entry.notes.join(", ").slice(0, 120) } : {}),
    }))
    .filter((part) => part.amount !== 0);
  return { splits, receiptTotal, difference: Math.round(target - receipt) / 100 };
}
