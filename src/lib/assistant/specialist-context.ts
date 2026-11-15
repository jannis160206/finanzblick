import type { Dashboard } from "@/lib/calc";
import type { AppState } from "@/lib/types";
import type { AgentResult } from "./agent";
import { evidenceText } from "./conversation";
import { contractsAnswer } from "./copilot";
import { monthReview } from "./essentials";
import { appOverview, assistantFacts, type AssistantFacts } from "./facts";
import { aboutMoney, generalQuestion, type AgentId } from "./orchestrator";
import { payrollAnswer, payrollFacts } from "./payroll";
import { pulseAnswer } from "./pulse";

// What each agent may see. Small, relevant context keeps the local model fast and on topic.
const factKeys: Record<AgentId, readonly (keyof AssistantFacts)[]> = {
  transactions: ["today", "spendingByMonthAndCategory", "yearToDate", "largestThisMonth", "largestLastMonth", "unusuallyHighThisMonth",
    "projectedSpendingThisMonth", "possibleDuplicateCharges", "memory"],
  contracts: ["today", "subscriptions", "priceIncreases", "possibleDuplicateFixedCosts", "memory"],
  budget: ["today", "currentMonth", "safeToSpendToday", "salary", "balances", "accountRules", "amex", "totalSavings", "goals", "upcoming",
    "giroForecast12Months", "healthCheck", "memory"],
  payroll: ["today", "salary", "memory"],
  general: ["today", "healthCheck", "totalSavings", "yearToDate", "goals", "memory"],
};

/** Whether the answer draws on the user's own figures; only the general chat on a general question does not. */
export const usesPersonalFacts = (agent: AgentId, question: string) =>
  !(agent === "general" && (!aboutMoney(question) || generalQuestion(question.toLowerCase())));

/**
 * The agent's own detailed facts plus a compact overview of all app data, so it can answer across topics. The general
 * chat gets none when the question is not about the user's money.
 */
export function agentFacts(agent: AgentId, state: AppState, dashboard: Dashboard, today: string, question: string): Record<string, unknown> {
  if (!usesPersonalFacts(agent, question)) return { today };
  const all = assistantFacts(state, dashboard, today);
  const facts: Record<string, unknown> = Object.fromEntries(factKeys[agent].map((key) => [key, all[key]]));
  facts.overview = appOverview(all, state, today);
  if (agent === "payroll") facts.payroll = payrollFacts(state, today);
  return facts;
}

// Dropped first when a combined context grows too large: details the overview already summarizes.
const expendable: readonly (keyof AssistantFacts)[] = ["possibleDuplicateFixedCosts", "possibleDuplicateCharges", "largestLastMonth", "accountRules",
  "healthCheck", "upcoming", "giroForecast12Months", "spendingByMonthAndCategory", "yearToDate", "largestThisMonth"];

/**
 * Context for an answer V4 Pro writes after the supervisor's plan: the detailed facts of the leading agent and of every
 * specialist whose tool ran, plus the overview of all app data. Rich enough for a personal answer; once it grows past the
 * limit, details of the helping specialists that the overview already summarizes are dropped, never the leading agent's own.
 */
export function contextFacts(agents: readonly AgentId[], state: AppState, dashboard: Dashboard, today: string, question: string, limit = 9000): Record<string, unknown> {
  const team = [...new Set(agents)].filter((agent) => usesPersonalFacts(agent, question));
  if (!team.length) return { today };
  const all = assistantFacts(state, dashboard, today);
  const facts: Record<string, unknown> = Object.fromEntries([...new Set(team.flatMap((agent) => factKeys[agent]))].map((key) => [key, all[key]]));
  facts.overview = appOverview(all, state, today);
  if (team.includes("payroll")) facts.payroll = payrollFacts(state, today);
  const own = new Set<string>(factKeys[team[0]]);
  for (const key of expendable) {
    if (JSON.stringify(facts).length <= limit) break;
    if (!own.has(key)) delete facts[key];
  }
  return facts;
}

// The read tool each specialist consults before it answers in words; its result is quoted, never recalculated.
const contextTools: Partial<Record<AgentId, (state: AppState, dashboard: Dashboard, today: string, question: string) => AgentResult>> = {
  transactions: (state, _dashboard, today, question) => monthReview(state, question, today),
  contracts: (state, _dashboard, today) => contractsAnswer(state, "Welche Abos habe ich?", today, () => ({ text: "" })),
  budget: (state, dashboard, today, question) => pulseAnswer(state, dashboard, today, question),
  payroll: (state) => payrollAnswer(state),
};

/** The specialist's own computed overview for a question no single tool answered. */
export function agentEvidence(agent: AgentId, state: AppState, dashboard: Dashboard, today: string, question: string): string | undefined {
  const tool = contextTools[agent];
  if (!tool) return undefined;
  try {
    return evidenceText(tool(state, dashboard, today, question), 900) || undefined;
  } catch {
    return undefined;
  }
}

/** Natural next questions per agent, shown under a written answer. */
export const agentSuggestions: Record<AgentId, string[]> = {
  transactions: ["Wie war mein Monat?", "Wofür gebe ich am meisten aus?", "Gibt es verdächtige Buchungen?"],
  contracts: ["Welche Abos habe ich?", "Welche Verträge kann ich kündigen?"],
  budget: ["Was bleibt mir diesen Monat?", "Wird mein Konto knapp?", "Wo kann ich sparen?"],
  payroll: ["Wie viel netto bekomme ich?", "Was bleibt von der nächsten Sonderzahlung?"],
  general: ["Was kannst du alles?", "Gib mir den Wochenüberblick", "Was bleibt mir diesen Monat?"],
};
