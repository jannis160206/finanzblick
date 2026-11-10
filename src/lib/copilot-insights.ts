import { addMonths, round, type Dashboard } from "@/lib/calc";
import { budgetPace, unusualCategories } from "@/lib/assistant/pulse";
import { addDays, contractReminders, daysBetween, perYear, type Contract } from "@/lib/contracts";
import { currency, dateLabel } from "@/lib/format";
import { openReviewCount } from "@/lib/import/review";
import { detectDuplicateCharges } from "@/lib/insights";
import { ledgerHref } from "@/lib/ledger-link";
import type { MonthEndForecast } from "@/lib/month-forecast";
import { MAX_DISMISSED_INSIGHTS, type AppState, type DismissedInsight } from "@/lib/types";

export type CopilotInsightKind = "forecast" | "budget" | "deadline" | "goal" | "price" | "duplicate" | "unusual" | "unclear";
export type CopilotInsight = {
  /** Stable per occurrence, so a dismissed hint stays away until something new happens. */
  id: string;
  kind: CopilotInsightKind;
  severity: "high" | "medium" | "low";
  title: string;
  text: string;
  amount?: number;
  href: string;
  /** Question that opens the chat with exactly this topic. */
  prompt: string;
};

const severityRank = { high: 0, medium: 1, low: 2 } as const;
const kindRank: Record<CopilotInsightKind, number> = { forecast: 0, budget: 1, deadline: 2, goal: 3, price: 4, duplicate: 5, unusual: 6, unclear: 7 };
const DAY_MS = 86_400_000;
const roundUp = (value: number, step = 10) => Math.max(step, Math.ceil(value / step) * step);

function budgetInsights(dashboard: Dashboard, today: string): CopilotInsight[] {
  const month = today.slice(0, 7);
  if (dashboard.plan.currentMonth !== month) return [];
  const pace = budgetPace(dashboard, today);
  const donors = pace.filter((item) => item.status === "ok").map((item) => ({ ...item, spare: round(item.total - Math.max(item.actual, item.expected)) }))
    .filter((item) => item.spare >= 10).sort((a, b) => b.spare - a.spare);
  return pace.filter((item) => item.status !== "ok").slice(0, 2).map((item) => {
    const over = item.status === "over";
    const gap = over ? item.actual - item.total : item.actual - item.expected;
    const donor = donors.find((candidate) => candidate.id !== item.id);
    const amount = donor ? Math.min(roundUp(gap), Math.floor(donor.spare / 10) * 10) : roundUp(gap);
    const suggestion = donor && amount >= 10 ? `Vorschlag: ${currency(amount)} aus ${donor.label} umschichten.` : `Vorschlag: Plan um ${currency(amount)} erhöhen oder bis Monatsende bremsen.`;
    return {
      id: `budget:${month}:${item.id}:${item.status}`, kind: "budget" as const, severity: over ? "high" as const : "medium" as const,
      title: over ? `Budget überschritten: ${item.label}` : `${item.label} läuft schneller als geplant`,
      text: `${currency(item.actual)} von ${currency(item.total)} ausgegeben${over ? "" : `, üblich wären bis heute ${currency(item.expected)}`}. ${suggestion}`,
      amount: round(gap), href: ledgerHref({ month }),
      prompt: donor && amount >= 10 ? `${amount} € von ${donor.label} zu ${item.label} umschichten` : `Plan für ${item.label} um ${amount} € erhöhen`,
    };
  });
}

function goalInsights(dashboard: Dashboard, today: string): CopilotInsight[] {
  return dashboard.goals.filter((goal) => !goal.completedAt && goal.date >= today).flatMap((goal) => {
    const goalMonth = goal.date.slice(8, 10) === "01" ? addMonths(goal.date.slice(0, 7), -1) : goal.date.slice(0, 7);
    const projected = dashboard.timeline.find((row) => row.month === goalMonth)?.goalEnd[goal.id];
    if (projected === undefined || projected === null || projected + 0.5 >= goal.target) return [];
    const missing = round(goal.target - projected);
    const soon = daysBetween(today, goal.date) <= 92;
    return [{
      id: `goal:${goal.id}:${today.slice(0, 7)}`, kind: "goal" as const, severity: soon ? "high" as const : "medium" as const,
      title: `Sparziel ${goal.name} in Gefahr`,
      text: `Bis ${dateLabel(goal.date)} fehlen voraussichtlich ${currency(missing)}. Mehr sparen, das Ziel verschieben oder den Betrag anpassen?`,
      amount: missing, href: "/sparen", prompt: `Wie weit bin ich bei ${goal.name}?`,
    }];
  });
}

function contractInsights(contracts: Contract[], today: string): CopilotInsight[] {
  return contractReminders(contracts, today).flatMap((reminder): CopilotInsight[] => {
    const contract = contracts.find((item) => item.id === reminder.contractId);
    if (!contract) return [];
    if (reminder.kind === "deadline") return [{
      id: `deadline:${contract.id}:${reminder.date}`, kind: "deadline", severity: reminder.tone === "bad" ? "high" : "medium",
      title: reminder.title, text: reminder.body, amount: contract.yearly, href: "/vertraege", prompt: `Kündige ${contract.name}`,
    }];
    if (reminder.kind === "price" && contract.priceChange) return [{
      id: `price:${contract.id}:${contract.priceChange.date}`, kind: "price", severity: "medium",
      title: `${contract.name} ist teurer geworden`, text: reminder.body,
      amount: round((contract.priceChange.to - contract.priceChange.from) * perYear[contract.interval]),
      href: "/vertraege", prompt: `Was kostet mich ${contract.name} im Jahr?`,
    }];
    return [];
  });
}

function duplicateInsights(state: AppState, today: string): CopilotInsight[] {
  return detectDuplicateCharges(state, addDays(today, -30)).filter((item) => item.dates[1] <= today).slice(0, 2).map((item) => ({
    id: `duplicate:${item.ids.join(":")}`, kind: "duplicate" as const, severity: "medium" as const,
    title: `Mögliche Doppelbuchung: ${item.merchant}`,
    text: `2 × ${currency(item.amount)} am ${dateLabel(item.dates[0])}${item.dates[1] !== item.dates[0] ? ` und ${dateLabel(item.dates[1])}` : ""}. Bitte prüfen, ob beides gewollt war.`,
    amount: item.amount, href: ledgerHref({ month: item.dates[1].slice(0, 7) }), prompt: `Wurde ich bei ${item.merchant} doppelt abgebucht?`,
  }));
}

function unusualInsights(state: AppState, today: string): CopilotInsight[] {
  const month = today.slice(0, 7);
  return unusualCategories(state, today).slice(0, 2).map((item) => ({
    id: `unusual:${month}:${item.category}`, kind: "unusual" as const, severity: item.now > item.usual * 2.5 ? "medium" as const : "low" as const,
    title: `${item.category}: deutlich mehr als sonst`,
    text: `${currency(item.now)} bis heute, üblich sind bis zum ${Number(today.slice(8, 10))}. etwa ${currency(item.usual)}.`,
    amount: round(item.now - item.usual), href: ledgerHref({ month }), prompt: `Wie viel habe ich diesen Monat für ${item.category} ausgegeben?`,
  }));
}

function unclearInsights(state: AppState, today: string): CopilotInsight[] {
  const open = openReviewCount(state.reviewQueue ?? []);
  if (!open) return [];
  return [{
    id: `unclear:${today.slice(0, 7)}`, kind: "unclear", severity: open >= 10 ? "medium" : "low",
    title: `${open} ${open === 1 ? "Buchung" : "Buchungen"} ohne klare Kategorie`,
    text: "Ich kann sie für dich zuordnen – du siehst vorher, was sich ändert, und bestätigst.",
    href: "/umsaetze?pruefen=1", prompt: "Ordne alle offenen Buchungen zu",
  }];
}

function forecastInsights(forecast: MonthEndForecast | undefined): CopilotInsight[] {
  if (!forecast || forecast.status !== "ok" || forecast.tone !== "negative") return [];
  return [{
    id: `forecast:${forecast.month}`, kind: "forecast", severity: "high", title: "Monatsende wird knapp",
    text: `Bis ${dateLabel(forecast.monthEnd)} fehlen voraussichtlich ${currency(-forecast.free)}. Der tiefste Stand ist am ${dateLabel(forecast.lowestCommitted.date)}.`,
    amount: round(-forecast.free), href: "/", prompt: "Wie viel kann ich bis Monatsende noch ausgeben?",
  }];
}

/** Proactive hints from the user's own data, most important first; dismissed ones are left out. */
export function buildCopilotInsights(
  state: AppState, dashboard: Dashboard, today: string,
  derived: { contracts?: Contract[]; forecast?: MonthEndForecast } = {},
): CopilotInsight[] {
  const all = [
    ...forecastInsights(derived.forecast),
    ...budgetInsights(dashboard, today),
    ...(derived.contracts ? contractInsights(derived.contracts, today) : []),
    ...goalInsights(dashboard, today),
    ...duplicateInsights(state, today),
    ...unusualInsights(state, today),
    ...unclearInsights(state, today),
  ];
  const dismissed = new Set((state.dismissedInsights ?? []).map((entry) => entry.id));
  return all.filter((item) => !dismissed.has(item.id))
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || kindRank[a.kind] - kindRank[b.kind]);
}

/** Remembers a dismissed hint; entries older than half a year are dropped because their ids no longer occur. */
export function dismissInsight(current: DismissedInsight[] | undefined, id: string, at = Date.now()): DismissedInsight[] {
  const fresh = (current ?? []).filter((entry) => entry.id !== id && at - entry.at < 183 * DAY_MS);
  return [...fresh, { id, at }].slice(-MAX_DISMISSED_INSIGHTS);
}

export const importantInsights = (insights: CopilotInsight[]) => insights.filter((item) => item.severity !== "low");
