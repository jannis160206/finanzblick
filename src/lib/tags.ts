import { classify } from "@/lib/calc";
import { personalAmount } from "@/lib/shared-holiday";
import type { AppState, Category } from "@/lib/types";

export const MAX_TAGS = 10;
const cleanTag = (tag: string) => tag.replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, 40);

/** Adds or removes one tag on the given bookings; returns the same state when nothing changes. */
export function setTag(state: AppState, ids: ReadonlySet<string>, rawTag: string, remove = false): AppState {
  const tag = cleanTag(rawTag);
  if (!tag) return state;
  const key = tag.toLocaleLowerCase("de");
  let changed = false;
  const transactions = state.transactions.map((row) => {
    if (!ids.has(row.id)) return row;
    const current = row.tags ?? [];
    const has = current.some((entry) => entry.toLocaleLowerCase("de") === key);
    if (remove ? !has : has || current.length >= MAX_TAGS) return row;
    changed = true;
    const tags = remove ? current.filter((entry) => entry.toLocaleLowerCase("de") !== key) : [...current, tag];
    if (tags.length) return { ...row, tags };
    const { tags: _removed, ...rest } = row;
    void _removed;
    return rest as typeof row;
  });
  return changed ? { ...state, transactions } : state;
}

export type TagSummary = {
  tag: string;
  count: number;
  /** Net personal spending (positive = spent). */
  spent: number;
  from: string;
  to: string;
  categories: { category: Category; amount: number }[];
};

/** Spending per tag across categories, e.g. everything for "Malaga 2026". Ignored bookings and transfers do not count. */
export function tagSummaries(state: AppState): TagSummary[] {
  const byTag = new Map<string, TagSummary & { parts: Map<Category, number> }>();
  for (const row of state.transactions) {
    if (!row.tags?.length || row.ignored) continue;
    const result = classify(row);
    if (result.isTransfer) continue;
    const amount = -personalAmount(row);
    for (const tag of row.tags) {
      const key = tag.toLocaleLowerCase("de");
      const entry = byTag.get(key) ?? { tag, count: 0, spent: 0, from: row.date, to: row.date, categories: [], parts: new Map() };
      entry.count += 1;
      entry.spent += amount;
      if (row.date < entry.from) entry.from = row.date;
      if (row.date > entry.to) entry.to = row.date;
      entry.parts.set(result.category, (entry.parts.get(result.category) ?? 0) + amount);
      byTag.set(key, entry);
    }
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  return [...byTag.values()].map(({ parts, ...entry }) => ({
    ...entry,
    spent: round(entry.spent),
    categories: [...parts].map(([category, amount]) => ({ category, amount: round(amount) }))
      .filter((part) => part.amount !== 0).sort((a, b) => b.amount - a.amount),
  })).sort((a, b) => b.to.localeCompare(a.to) || a.tag.localeCompare(b.tag, "de"));
}

export function allTags(state: AppState): string[] {
  const tags = new Map<string, string>();
  for (const row of state.transactions) for (const tag of row.tags ?? []) {
    const key = tag.toLocaleLowerCase("de");
    if (!tags.has(key)) tags.set(key, tag);
  }
  return [...tags.values()].sort((a, b) => a.localeCompare(b, "de"));
}
