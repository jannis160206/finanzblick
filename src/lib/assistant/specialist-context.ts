import type { Dashboard } from "@/lib/calc";
import type { AppState } from "@/lib/types";
import type { AgentResult } from "./agent";
import { evidenceText } from "./conversation";
import { contractsAnswer } from "./copilot";
import { monthReview } from "./essentials";
import { assistantFacts, type AssistantFacts } from "./facts";
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

/** Only the facts the agent needs. The general chat gets none when the question is not about the user's money. */
export function agentFacts(agent: AgentId, state: AppState, dashboard: Dashboard, today: string, question: string): Record<string, unknown> {
  if (agent === "general" && (!aboutMoney(question) || generalQuestion(question.toLowerCase()))) return { today };
  const all = assistantFacts(state, dashboard, today);
  const facts: Record<string, unknown> = Object.fromEntries(factKeys[agent].map((key) => [key, all[key]]));
  if (agent === "payroll") facts.payroll = payrollFacts(state, today);
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
