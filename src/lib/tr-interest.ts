import { bankOperation } from "@/lib/bank-operation";
import { TRADE_REPUBLIC_BANK } from "@/lib/import/trade-republic";
import type { AppState, Settings, Transaction } from "@/lib/types";

/** Austrian KESt Trade Republic withholds from interest; the dashboard pays out interest net of it as well. */
export const INTEREST_TAX = 0.275;
const WINDOW_MONTHS = 3;
const MAX_PLAUSIBLE_RATE = 0.2;
const DAY_MS = 86_400_000;

export type TrInterestRate =
  | {
    source: "credits";
    /** Gross rate per year, e.g. 0.0225 for 2.25 %. */
    rate: number;
    credits: number;
    /** Gross interest credited in the window. */
    interest: number;
    averageBalance: number;
    from: string;
    to: string;
  }
  | { source: "stored"; rate: number; date?: string };

const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function monthsBefore(date: string, months: number) {
  const index = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 - months;
  const year = Math.floor(index / 12), month = index % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(Number(date.slice(8, 10)), last)).padStart(2, "0")}`;
}

const germanAmount = (text: string) => {
  const value = Number(text.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/** True for a Trade Republic interest credit ("Zinsgutschrift"), from the bank API or the CSV export. */
export function isTradeRepublicInterest(row: Transaction) {
  return row.bank === TRADE_REPUBLIC_BANK && row.amount > 0 && !row.ignored && bankOperation(row)?.kind === "interest";
}

// The CSV export names the gross amount; a bank API booking is the net credit after KESt.
function grossInterest(row: Transaction) {
  for (const detail of row.rawDetails ?? []) {
    const gross = /^brutto:\s*([\d.]+(?:,\d+)?)/i.exec(detail.trim());
    const value = gross ? germanAmount(gross[1]) : undefined;
    if (value !== undefined) return value;
  }
  return row.amount / (1 - INTEREST_TAX);
}

// Day-weighted balance; days before the first known balance count with that first balance.
function averageBalance(balances: { date: string; balance: number }[], from: string, to: string) {
  const sorted = [...balances].sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length || to <= from) return undefined;
  let total = 0, days = 0, index = 0;
  for (let day = time(from); day < time(to); day += DAY_MS) {
    const date = iso(day);
    while (index + 1 < sorted.length && sorted[index + 1].date <= date) index++;
    total += sorted[index].balance;
    days++;
  }
  return days ? total / days : undefined;
}

function creditedRate(state: AppState, asOf: string): TrInterestRate | undefined {
  const start = monthsBefore(asOf, WINDOW_MONTHS);
  const credits = state.transactions.filter((row) => row.date > start && row.date <= asOf && isTradeRepublicInterest(row))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!credits.length) return undefined;
  const months = new Set(credits.map((row) => row.date.slice(0, 7))).size;
  // Each monthly credit pays the month before it.
  const from = monthsBefore(credits[0].date, 1), to = credits[credits.length - 1].date;
  const balance = averageBalance((state.trBalances ?? []).filter((entry) => entry.date <= asOf), from, to);
  if (balance === undefined || balance <= 0) return undefined;
  const interest = credits.reduce((sum, row) => sum + grossInterest(row), 0);
  const rate = Math.round(interest * 12 / months / balance * 10_000) / 10_000;
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_PLAUSIBLE_RATE) return undefined;
  return { source: "credits", rate, credits: credits.length, interest: Math.round(interest * 100) / 100, averageBalance: Math.round(balance * 100) / 100, from, to };
}

// Without a stored history the settings' rate before and after the rate change apply, as they always did.
function storedRate(settings: Settings, asOf: string): TrInterestRate | undefined {
  const saved = settings.interestRates?.filter((entry) => entry.date <= asOf).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (saved) return { source: "stored", rate: saved.rate, date: saved.date };
  return asOf < settings.rateChangeDate
    ? { source: "stored", rate: settings.oldRate }
    : { source: "stored", rate: settings.newRate, date: settings.rateChangeDate };
}

/**
 * Trade Republic interest rate p.a.: derived from the interest credits of the last three months against the average
 * balance the bank reported, otherwise the latest stored rate.
 */
export function trInterestRate(state: AppState, asOf = state.settings.asOf): TrInterestRate | undefined {
  return creditedRate(state, asOf) ?? storedRate(state.settings, asOf);
}
