import type { AssistantMessage } from "@/lib/types";
import { changingTools } from "./conversation";
import { agentIds, agentTools, specialistIds, type AgentId, type RouteVia } from "./orchestrator";
import type { AssistantTool } from "./tools";

/** What each agent is for, in the words of the admin view (read-only). */
export const agentInfo: Record<AgentId, { summary: string; scope: string }> = {
  transactions: { summary: "Buchungen, Ausgaben und Einnahmen",
    scope: "Vergangene Buchungen, Händler und Kategorien, Monats- und Jahresrückblick, doppelte oder verdächtige Buchungen, Rückerstattungen, offene Bestellungen; Buchungen bearbeiten, löschen und taggen" },
  contracts: { summary: "Abos und Verträge", scope: "Welche Verträge es gibt, Kosten pro Monat und Jahr, Laufzeit, Kündigungsfrist und Kündigen; Verträge Schritt für Schritt anlegen, ändern, bestätigen, ausblenden und als gekündigt markieren" },
  budget: { summary: "Monatsplan, Konten und Ziele",
    scope: "Was übrig bleibt, Kontostände, Prognose, Sparziele und geplante Ausgaben, ob sich ein Kauf ausgeht, Spartipps, Anlegen und Kredite; Budgets, Monatsplan-Positionen und Kontoregeln ändern" },
  payroll: { summary: "Gehalt und Steuern",
    scope: "Lohnabrechnung, netto und brutto, Sonderzahlungen mit Anteil zu 6 % und voll versteuert, Jahressechstel, Arbeitnehmerveranlagung" },
  general: { summary: "Allgemeiner Chat, Rückfall bei Unklarheit",
    scope: "Begrüßung, allgemeine Geldfragen, Finanzbegriffe, Bedienung der App, Marktdaten und Gedächtnis; fachfremde Themen lehnt er höflich ab" },
};

/** Short names for the tool list. */
export const toolLabel: Record<AssistantTool, string> = {
  query: "Ausgaben & Einnahmen", booking: "Buchung bearbeiten", rule: "Kategorie-Regel", cleanup: "Offene Buchungen zuordnen",
  why: "Warum diese Kategorie?", security: "Sicherheits-Check", refunds: "Rückerstattungen", context: "Angezeigte Buchungen",
  orders: "Offene Bestellungen", shared: "Geteilte Kosten", month_review: "Monatsbericht", review: "Jahresrückblick",
  contracts: "Vertragsordner", cancel: "Kündigungshilfe", contract_new: "Vertrag anlegen", contract_edit: "Vertrag ändern",
  budget: "Monatsplan", budget_plan: "Budget anpassen", pulse: "Monats-Puls", forecast: "Kontoprognose", funds: "Leistbarkeit",
  account_rule: "Kontoregeln", affordability: "Kauf durchrechnen", savings_goal: "Sparziel anlegen", expense: "Ausgabe planen",
  edit: "Ziel, Ausgabe oder Planposition ändern", batch: "Mehrere Änderungen", whatif: "Was wäre wenn", coach: "Spar-Coach", check: "Finanz-Check",
  briefing: "Wochenüberblick", insights: "Hinweise", accounts: "Kontostände", amex: "Amex-Abrechnung", networth: "Vermögen",
  depot: "Depot-Rechner", loan: "Kreditrechner",
  payroll: "Gehaltsübersicht", tax: "Arbeitnehmerveranlagung", homeoffice: "Home-Office-Rechner",
  help: "Hilfe", explain: "App erklären", knowledge: "Begriffe nachschlagen", market: "Marktdaten", memory: "Gedächtnis",
  remember: "Merken", forget: "Vergessen", changes: "Änderungsprotokoll", undo: "Rückgängig", reminder: "Erinnerungen", ask: "Freie Antwort",
};

/** Tools that change data; they only run after the user confirms. */
export const changesData = (tool: AssistantTool) => changingTools.includes(tool);

export const viaLabel: Record<RouteVia, string> = { rule: "Regel", signal: "Signalwort", model: "Modell", fallback: "Rückfall" };

/** The orchestrator's decision steps, in the order it tries them. */
export const orchestratorSteps: { title: string; detail: string; calls: string }[] = [
  { title: "Regeln", detail: "Begrüßung, fachfremde Themen, klare Befehle, Folgefragen", calls: "0 KI" },
  { title: "Signalwörter", detail: "Genau ein Spezialist passt, oder gar kein Geldthema", calls: "0 KI" },
  { title: "Modell-Rückfall", detail: "Ein Wort, höchstens 8 Token – im Zweifel Chat", calls: "1 KI" },
];

export const agentOrder: readonly AgentId[] = [...specialistIds, "general"];
export const agentToolList = (agent: AgentId) => agentTools(agent).filter((tool) => tool !== "ask" || agent === "general");

export type RunStatus = "answered" | "question" | "unclear" | "error";
export const runStatusLabel: Record<RunStatus, string> = {
  answered: "Beantwortet", question: "Rückfrage", unclear: "Nicht verstanden", error: "Fehler",
};
export type AssistantRun = {
  id: string;
  at: number;
  question: string;
  agent?: AgentId;
  via?: RouteVia;
  status: RunStatus;
  /** Roughly from sending the question to the answer, in milliseconds. */
  ms?: number;
};

const isAgent = (value: unknown): value is AgentId => typeof value === "string" && (agentIds as readonly string[]).includes(value);

function statusOf(reply: AssistantMessage): RunStatus {
  if (reply.correcting) return "unclear";
  if (/^Dabei ist etwas schiefgegangen/.test(reply.text)) return "error";
  if (reply.draft && reply.status === "question" || reply.clarify) return "question";
  return "answered";
}

/** The latest runs, newest first: each question with the first answer that followed it. */
export function assistantRuns(chat: readonly AssistantMessage[], limit = 50): AssistantRun[] {
  const runs: AssistantRun[] = [];
  chat.forEach((message, index) => {
    if (message.role !== "user") return;
    const reply = chat.slice(index + 1).find((item) => item.role === "assistant");
    const next = chat.slice(index + 1).findIndex((item) => item.role === "user");
    if (!reply || next >= 0 && chat.indexOf(reply) > index + 1 + next) return;
    const ms = reply.ms ?? (reply.at >= message.at ? reply.at - message.at : undefined);
    runs.push({
      id: message.id, at: message.at, question: message.text, status: statusOf(reply),
      ...(isAgent(reply.agent) ? { agent: reply.agent } : {}), ...(reply.via ? { via: reply.via } : {}),
      ...(ms !== undefined ? { ms } : {}),
    });
  });
  return runs.reverse().slice(0, limit);
}
