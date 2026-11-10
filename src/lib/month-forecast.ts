import { daysInMonth, round, type Dashboard } from "@/lib/calc";
import { buildForecastInput, GIRO, type ForecastKind } from "@/lib/assistant/forecast";
import { addDays, contractChargesBetween, detectContracts, type Contract } from "@/lib/contracts";
import { pocketKey } from "@/lib/goals";
import type { AppState } from "@/lib/types";

export type MonthEndEvent = { date: string; label: string; amount: number; kind: ForecastKind; contractId?: string };
export type MonthEndPoint = { date: string; balance: number; committed: number };

export type MonthEndForecast =
  | { status: "unknown"; month: string; monthEnd: string }
  | {
    status: "ok";
    month: string;
    today: string;
    monthEnd: string;
    daysLeft: number;
    start: number;
    source: { kind: "snapshot"; date: string } | { kind: "note" } | { kind: "mixed"; date: string };
    buffer: number;
    income: number;
    fixed: number;
    contracts: number;
    amex: number;
    transfers: number;
    planned: number;
    /** Everyday spending the plan still expects from the giro account this month. */
    spending: number;
    /** Balance at month end after everything, including expected everyday spending. */
    endBalance: number;
    /** Balance at month end from fixed and planned money flows only. */
    endCommitted: number;
    lowest: { date: string; balance: number };
    lowestCommitted: { date: string; balance: number };
    /** Held back because the balance dips before income arrives. */
    reserve: number;
    /** Can still be spent until month end without the balance falling below the buffer on any day. */
    free: number;
    perDay: number;
    tone: "ok" | "tight" | "negative";
    events: MonthEndEvent[];
    points: MonthEndPoint[];
  };

const isAmexBank = (bank = "") => /^(?:amex|american express)$/i.test(bank.trim());

// Contracts already covered by the fixed-cost schedule or settled through the Amex debit are not charged twice.
const giroContract = (contract: Contract) => !contract.fixedRowId && !isAmexBank(contract.booking?.bank);

function contractEvents(contracts: Contract[], today: string, monthEnd: string): MonthEndEvent[] {
  const monthStart = `${today.slice(0, 7)}-01`;
  return contractChargesBetween(contracts.filter(giroContract), monthStart, monthEnd, today)
    .filter(({ contract, date }) => date >= today || !contract.missed)
    .map(({ contract, date, amount }) => ({
      date: date < today ? today : date, label: contract.name, amount: -round(amount), kind: "subscription" as const, contractId: contract.id,
    }));
}

const sumOf = (events: MonthEndEvent[], kind: ForecastKind) => round(-events.filter((event) => event.kind === kind).reduce((sum, event) => sum + event.amount, 0));

/**
 * Expected giro balance at the end of the current month and the amount that is freely available until then.
 * Builds on the assistant's account forecast and replaces its subscription heuristic with the contract folder.
 */
export function monthEndForecast(state: AppState, dashboard: Dashboard, today: string, contracts: Contract[] = detectContracts(state, today)): MonthEndForecast {
  const month = today.slice(0, 7);
  const monthEnd = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const { input, meta } = buildForecastInput(state, dashboard, today, 1);
  if (!meta.giroKnown && Math.abs(meta.snapshots) < 0.005) return { status: "unknown", month, monthEnd };

  const events: MonthEndEvent[] = [
    ...input.events.filter((event) => event.account === GIRO && event.date >= today && event.date <= monthEnd && event.kind !== "subscription"),
    ...contractEvents(contracts, today, monthEnd),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  const start = input.accounts.find((account) => account.name === GIRO)?.start ?? 0;

  const byDate = new Map<string, MonthEndEvent[]>();
  for (const event of events) byDate.set(event.date, [...(byDate.get(event.date) ?? []), event]);
  let balance = start;
  let committed = start;
  let lowest = { date: today, balance: round(start) };
  let lowestCommitted = { date: today, balance: round(start) };
  const points: MonthEndPoint[] = [];
  for (let date = today; date <= monthEnd; date = addDays(date, 1)) {
    for (const event of byDate.get(date) ?? []) {
      balance += event.amount;
      if (event.kind !== "spending") committed += event.amount;
    }
    const point = { date, balance: round(balance), committed: round(committed) };
    points.push(point);
    if (point.balance < lowest.balance) lowest = { date, balance: point.balance };
    if (point.committed < lowestCommitted.balance) lowestCommitted = { date, balance: point.committed };
  }

  const income = round(events.filter((event) => event.amount > 0 && event.kind !== "spending").reduce((sum, event) => sum + event.amount, 0));
  const endCommitted = round(committed);
  const free = round(lowestCommitted.balance - meta.buffer);
  const daysLeft = Number(monthEnd.slice(8)) - Number(today.slice(8)) + 1;
  const spending = sumOf(events, "spending");
  const snapshotDate = (state.accountSnapshots ?? []).filter((item) => item.date <= today && !dashboard.physical[pocketKey(item.name)])
    .map((item) => item.date).sort().at(-1);
  const source = snapshotDate ? meta.giroKnown ? { kind: "mixed" as const, date: snapshotDate } : { kind: "snapshot" as const, date: snapshotDate } : { kind: "note" as const };
  return {
    status: "ok", month, today, monthEnd, daysLeft, start: round(start), source, buffer: meta.buffer,
    income, fixed: sumOf(events, "fixed"), contracts: sumOf(events, "subscription"), amex: sumOf(events, "amex"),
    transfers: sumOf(events, "transfer"),
    planned: sumOf(events, "planned"), spending,
    endBalance: round(balance), endCommitted, lowest, lowestCommitted,
    reserve: round(endCommitted - lowestCommitted.balance),
    free, perDay: round(Math.max(0, free) / Math.max(1, daysLeft)),
    tone: free < 0 ? "negative" : free < spending ? "tight" : "ok",
    events: events.filter((event) => event.kind !== "spending"),
    points,
  };
}
