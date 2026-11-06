import type { AssistantWhatIf } from "@/lib/types";

const cents = (value: number) => Math.round(value * 100) / 100;
const addMonth = (month: string, count: number) => {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + count, 1));
  return date.toISOString().slice(0, 7);
};
const HORIZON = 600;

export const whatIfQuestion = (lower: string) =>
  (/was w(?:ä|ae)re,? (?:denn )?wenn|was passiert,? wenn|angenommen,? (?:ich|wir)\b|\bszenario\b|gedankenspiel|\bwenn ich\b/.test(lower) &&
    /kündig|kuendig|streich|weglass|abbestell|weniger ausgeb|\b(?:mehr|zusätzlich|zusaetzlich|extra)\b.{0,25}\b(?:spar|zur seite|zurück|zurueck)|\bspar\w*\b.{0,25}\b(?:mehr|zusätzlich|zusaetzlich|extra)\b/.test(lower) &&
    (/was w(?:ä|ae)re|was passiert|angenommen|szenario|gedankenspiel/.test(lower) || /\bwann\b|wie (?:viel|schnell|lange)|früher|frueher|erreich|schaff|hätte|haette|bringt|spar(?:e|t) ich/.test(lower)) ||
    /(?:kündig|kuendig)\w*\b.{0,60}\b(?:wann erreich|wie viel früher|wie viel frueher)/.test(lower)) &&
  !/\betfs?\b|\bdepot\b|aktien|rendite|zinseszins|kredit|leasing|leisten|leistbar|lösch|loesch/.test(lower);

// First month in which the goal balance reaches its target; undefined when it never does within 50 years.
export function reachMonth(input: Pick<AssistantWhatIf, "start" | "rates" | "tail">, saved: number, target: number, added = 0): string | undefined {
  let balance = saved;
  if (balance >= target - 0.005) return addMonth(input.start, -1);
  for (let index = 0; index < HORIZON; index++) {
    balance += (input.rates[index] ?? input.tail) + added;
    if (balance >= target - 0.005) return addMonth(input.start, index);
  }
  return undefined;
}

export const monthsBetween = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));

export type WhatIfOutcome = { cancelled: number; extra: number; freed: number; yearly: number;
  before?: string; after?: string; earlier?: number; onTime?: boolean; beforeOnTime?: boolean };

// Pure and synchronous so the chat card can recompute on every slider move.
export function computeWhatIf(input: AssistantWhatIf, extra = input.extra, cancel = input.subscriptions.map((item) => item.cancel)): WhatIfOutcome {
  const cancelled = cents(input.subscriptions.reduce((sum, item, index) => sum + (cancel[index] ? item.monthly : 0), 0));
  const freed = cents(cancelled + Math.max(0, extra));
  const result: WhatIfOutcome = { cancelled, extra: Math.max(0, extra), freed, yearly: cents(freed * 12) };
  if (!input.goal) return result;
  const before = reachMonth(input, input.goal.saved, input.goal.target);
  const after = reachMonth(input, input.goal.saved, input.goal.target, freed);
  const due = input.goal.date.slice(0, 7);
  return { ...result, ...(before ? { before, beforeOnTime: before <= due } : {}), ...(after ? { after, onTime: after <= due } : {}),
    ...(before && after ? { earlier: monthsBetween(after, before) } : {}) };
}
