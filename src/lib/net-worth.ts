/**
 * Net worth ("Vermögen") per month, as far as the app actually knows balances.
 *
 * For each month from the first month with ledger/balance data (never before the
 * baseline month) up to the asOf month, the reference date is the month's last day
 * (or asOf for the current month). Net worth on that date is:
 *
 *   + every Revolut pocket / physical balance known by `physicalPocketBalances`
 *     (savings pockets, Amex repayment pocket, Notgroschen = Trade Republic balance);
 *     the Revolut main account is excluded there and added via its account snapshot;
 *   + the latest other account snapshots (e.g. Revolut main account) not already a pocket;
 *   + the Girokonto balance from the assistant note (`giroNote`) – undated, so current month only;
 *   − the open Amex balance (`amexFunding(...).outstanding`, the dashboard value for the
 *     current month, recomputed with the month end as asOf for past months).
 *
 * Unknown or conflicting balances are left out (not counted as 0); months without any
 * known part are dropped. Part keys are pocket keys (see `pocketKey`), plus
 * "girokonto" and "amex". Amounts are rounded to cents.
 */
import { amexFunding } from "@/lib/amex-balance";
import { giroNote } from "@/lib/assistant/forecast";
import { actualBookings, actualPockets, addMonths, daysInMonth, monthKey, round, sum, type Dashboard } from "@/lib/calc";
import { physicalPocketBalances, pocketKey } from "@/lib/goals";
import type { AppState } from "@/lib/types";

export type NetWorthPoint = { month: string; total: number; parts: Record<string, number> };

function firstDataMonth(state: AppState): string | undefined {
  const dates = [
    ...state.transactions.map((row) => row.date),
    ...(state.pocketSnapshots ?? []).map((item) => item.date),
    ...(state.accountSnapshots ?? []).map((item) => item.date),
    ...(state.trBalances ?? []).map((item) => item.date),
    ...(state.amexBalanceSnapshots ?? []).map((item) => item.date),
  ].filter((date) => date <= state.settings.asOf).sort();
  if (!dates.length) return undefined;
  const first = monthKey(dates[0]);
  const baseline = monthKey(state.settings.baselineDate);
  return first < baseline ? baseline : first;
}

function accountParts(state: AppState, date: string, pockets: Set<string>): Record<string, number> {
  const latest = new Map<string, { date: string; balance: number }>();
  for (const item of state.accountSnapshots ?? []) {
    const key = pocketKey(item.name);
    if (item.date > date || pockets.has(key)) continue;
    const previous = latest.get(key);
    if (!previous || item.date > previous.date) latest.set(key, item);
  }
  return Object.fromEntries([...latest].map(([key, item]) => [key, round(item.balance)]));
}

export function netWorthHistory(state: AppState, dashboard: Dashboard): NetWorthPoint[] {
  const first = firstDataMonth(state);
  if (!first) return [];
  const current = monthKey(state.settings.asOf);
  const bookings = actualBookings(state);
  const hasAmex = (date: string) => (state.amexBalanceSnapshots ?? []).some((item) => item.date <= date) ||
    bookings.some((row) => row.date <= date && /^(?:amex|american express)$/i.test(row.bank.trim()));
  const points: NetWorthPoint[] = [];
  for (let month = first; month <= current; month = addMonths(month, 1)) {
    const isCurrent = month === current;
    const date = isCurrent ? state.settings.asOf : `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
    const physical = physicalPocketBalances(state, actualPockets(state, date), date);
    const parts: Record<string, number> = {};
    for (const [key, balance] of Object.entries(physical)) if (balance.amount !== null) parts[key] = round(balance.amount);
    Object.assign(parts, accountParts(state, date, new Set(Object.keys(physical))));
    const giro = isCurrent ? giroNote(state) : undefined;
    if (giro !== undefined) parts.girokonto = round(giro);
    if (hasAmex(date)) {
      const outstanding = isCurrent ? dashboard.amex.outstanding
        : amexFunding({ ...state, settings: { ...state.settings, asOf: date } }, bookings).outstanding;
      if (outstanding) parts.amex = round(-outstanding);
    }
    if (Object.keys(parts).length) points.push({ month, total: round(sum(Object.values(parts))), parts });
  }
  return points;
}

export function netWorthNow(state: AppState, dashboard: Dashboard): NetWorthPoint | undefined {
  return netWorthHistory(state, dashboard).at(-1);
}
