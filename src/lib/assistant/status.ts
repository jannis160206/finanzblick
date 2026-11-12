import type { AgentId } from "./orchestrator";
import type { AssistantTool } from "./tools";

/**
 * What the assistant is doing right now, shown live while a message is answered: a short text, the kind of work
 * (it picks the animation of the thinking orb) and, once the orchestrator has decided, the agent doing it.
 */
export type WorkActivity = "listening" | "connecting" | "searching" | "working" | "solving" | "shaping" | "weaving" | "composing";
export type WorkStatus = { text: string; activity: WorkActivity; agent?: AgentId };

const step = (text: string, activity: WorkActivity): WorkStatus => ({ text, activity });

export const workStatus = {
  read: step("Lese deine Nachricht…", "listening"),
  route: step("Verstehe deine Frage…", "connecting"),
  knowledge: step("Suche passendes Wissen…", "searching"),
  market: step("Hole aktuelle Marktdaten…", "searching"),
  web: step("Suche aktuelle Informationen…", "searching"),
  compare: step("Vergleiche Quellen…", "weaving"),
  recall: step("Prüfe mein gelerntes Wissen…", "searching"),
  answer: step("Formuliere die Antwort…", "composing"),
} satisfies Record<string, WorkStatus>;

const analyse = (text: string) => step(text, "working");
const search = (text: string) => step(text, "searching");
const compute = (text: string) => step(text, "solving");
const prepare = (text: string) => step(text, "shaping");

const toolStatus: Record<AssistantTool, WorkStatus> = {
  query: analyse("Analysiere deine Buchungen…"), month_review: analyse("Analysiere deine Buchungen…"), review: analyse("Gehe offene Buchungen durch…"),
  cleanup: analyse("Analysiere deine Buchungen…"), why: analyse("Analysiere deine Buchungen…"), context: analyse("Lese die angezeigten Buchungen…"),
  security: search("Prüfe auf doppelte Buchungen…"), refunds: search("Suche Rückerstattungen…"), orders: search("Suche offene Bestellungen…"),
  shared: compute("Rechne geteilte Kosten nach…"),
  booking: prepare("Bereite die Änderung vor…"), rule: prepare("Bereite die Regel vor…"), batch: prepare("Bereite die Änderungen vor…"), edit: prepare("Bereite die Änderung vor…"),
  contracts: analyse("Prüfe deine Verträge…"), cancel: analyse("Prüfe deine Verträge…"), contract_new: prepare("Bereite den Vertrag vor…"), contract_edit: prepare("Bereite die Änderung vor…"),
  budget: compute("Berechne dein freies Budget…"), pulse: compute("Berechne dein freies Budget…"), funds: compute("Prüfe, was sich ausgeht…"), affordability: compute("Prüfe, was sich ausgeht…"),
  budget_plan: compute("Rechne den Monatsplan durch…"), check: analyse("Prüfe deine Finanzen…"), briefing: step("Stelle deinen Überblick zusammen…", "weaving"),
  insights: search("Suche Auffälligkeiten…"), accounts: analyse("Lese deine Kontostände…"), amex: compute("Rechne die Amex-Abrechnung…"), networth: compute("Rechne dein Vermögen zusammen…"),
  forecast: compute("Rechne die Prognose durch…"), whatif: compute("Rechne die Prognose durch…"), loan: compute("Rechne den Kredit durch…"), depot: compute("Rechne den Sparplan durch…"),
  coach: search("Suche Sparpotenzial…"), savings_goal: prepare("Plane mit deinem Monatsplan…"), expense: prepare("Plane mit deinem Monatsplan…"),
  account_rule: prepare("Prüfe deine Kontoregeln…"), payroll: compute("Lese deine Lohnabrechnungen…"), tax: search("Prüfe Absetzmöglichkeiten…"), homeoffice: compute("Prüfe Absetzmöglichkeiten…"),
  knowledge: workStatus.knowledge, market: workStatus.market, explain: search("Schlage in der App nach…"), help: step("Einen Moment…", "connecting"),
  memory: search("Schaue in mein Gedächtnis…"), remember: prepare("Merke mir das…"), forget: prepare("Lösche den Eintrag…"), changes: search("Lese das Änderungsprotokoll…"),
  undo: prepare("Mache die Änderung rückgängig…"), reminder: prepare("Lege die Erinnerung an…"), ask: workStatus.route,
};

const agentStatus: Record<AgentId, WorkStatus> = {
  transactions: analyse("Analysiere deine Buchungen…"), contracts: analyse("Prüfe deine Verträge…"), budget: compute("Berechne dein freies Budget…"),
  payroll: compute("Lese deine Lohnabrechnungen…"), general: workStatus.route,
};

/** The status for the chosen tool, or for the agent when it answers in words; the agent's avatar shows who is at work. */
export const statusFor = (tool: AssistantTool | undefined, agent: AgentId): WorkStatus => ({ ...(tool ? toolStatus[tool] : agentStatus[agent]), agent });
