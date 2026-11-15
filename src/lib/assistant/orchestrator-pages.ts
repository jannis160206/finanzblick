/** The subpages of the orchestrator admin view, in the order of its navigation and of the settings' sub-links. */
export const orchestratorPages = [
  { slug: "uebersicht", label: "Übersicht", description: "Kennzahlen, Modelle und Kosten" },
  { slug: "topologie", label: "Topologie", description: "Orchestrator, Agenten, Werkzeuge und Datenquellen als Graph" },
  { slug: "daten", label: "Daten", description: "Datenkatalog: was die Agenten lesen" },
  { slug: "wissen", label: "Wissen", description: "Dokumente, die ein Agent in jedem Lauf liest" },
  { slug: "laeufe", label: "Läufe", description: "Fragen mit Delegationen, Werkzeugen, Modellen und Dauer" },
  { slug: "evals", label: "Evals", description: "Gold-Eval starten und Ergebnisse vergleichen" },
  { slug: "agenten", label: "Agenten", description: "Agent-Repo: Prompts, Modelle, Limits und Verlauf" },
  { slug: "werkzeuge", label: "Werkzeuge", description: "Werkzeug-Repo: die Beschreibungen, die das Modell liest" },
  { slug: "feedback", label: "Feedback & Prüfung", description: "Feedback-Datei und Prüfungs-Agent" },
] as const;

export type OrchestratorView = (typeof orchestratorPages)[number]["slug"];

export const orchestratorHref = (slug: OrchestratorView) => `/einstellungen/orchestrator/${slug}`;
/** The detail page of one agent in the agent repo. */
export const agentHref = (agent: string) => `${orchestratorHref("agenten")}/${agent}`;