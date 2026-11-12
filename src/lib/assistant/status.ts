import type { AgentId } from "./orchestrator";
import type { AssistantTool } from "./tools";

/**
 * What the assistant is doing right now, shown live while a message is answered. Every tool names its own step, so the
 * line changes as the work moves from understanding to computing to writing.
 */
export const workStatus = {
  read: "Lese deine Nachricht…",
  route: "Verstehe deine Frage…",
  knowledge: "Suche passendes Wissen…",
  market: "Hole aktuelle Marktdaten…",
  answer: "Formuliere die Antwort…",
  contract: "Prüfe deine Verträge…",
} as const;

const toolStatus: Record<AssistantTool, string> = {
  query: "Analysiere deine Buchungen…", month_review: "Analysiere deine Buchungen…", review: "Gehe offene Buchungen durch…",
  cleanup: "Analysiere deine Buchungen…", why: "Analysiere deine Buchungen…", security: "Prüfe auf doppelte Buchungen…",
  refunds: "Suche Rückerstattungen…", orders: "Suche offene Bestellungen…", shared: "Rechne geteilte Kosten nach…", context: "Lese die angezeigten Buchungen…",
  booking: "Bereite die Änderung vor…", rule: "Bereite die Regel vor…", batch: "Bereite die Änderungen vor…", edit: "Bereite die Änderung vor…",
  contracts: "Prüfe deine Verträge…", cancel: "Prüfe deine Verträge…", contract_new: "Prüfe deine Verträge…", contract_edit: "Prüfe deine Verträge…",
  budget: "Berechne dein freies Budget…", pulse: "Berechne dein freies Budget…", funds: "Prüfe, was sich ausgeht…", affordability: "Prüfe, was sich ausgeht…",
  budget_plan: "Rechne den Monatsplan durch…", check: "Prüfe deine Finanzen…", briefing: "Stelle deinen Überblick zusammen…",
  insights: "Suche Auffälligkeiten…", accounts: "Lese deine Kontostände…", amex: "Rechne die Amex-Abrechnung…", networth: "Rechne dein Vermögen zusammen…",
  forecast: "Rechne die Prognose durch…", whatif: "Rechne die Prognose durch…", loan: "Rechne den Kredit durch…", depot: "Rechne den Sparplan durch…",
  coach: "Suche Sparpotenzial…", savings_goal: "Plane mit deinem Monatsplan…", expense: "Plane mit deinem Monatsplan…",
  account_rule: "Prüfe deine Kontoregeln…", payroll: "Lese deine Lohnabrechnungen…", tax: "Prüfe Absetzmöglichkeiten…", homeoffice: "Prüfe Absetzmöglichkeiten…",
  knowledge: workStatus.knowledge, market: workStatus.market, explain: "Schlage in der App nach…", help: "Einen Moment…",
  memory: "Schaue in mein Gedächtnis…", remember: "Merke mir das…", forget: "Lösche den Eintrag…", changes: "Lese das Änderungsprotokoll…",
  undo: "Mache die Änderung rückgängig…", reminder: "Lege die Erinnerung an…", ask: "Verstehe deine Frage…",
};

const agentStatus: Record<AgentId, string> = {
  transactions: "Analysiere deine Buchungen…", contracts: "Prüfe deine Verträge…", budget: "Berechne dein freies Budget…",
  payroll: "Lese deine Lohnabrechnungen…", general: workStatus.route,
};

/** The status line for the chosen tool, or for the agent when it answers in words. */
export const statusFor = (tool: AssistantTool | undefined, agent: AgentId) => tool ? toolStatus[tool] : agentStatus[agent];
