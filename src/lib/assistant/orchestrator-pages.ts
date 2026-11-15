/** The subpages of the orchestrator admin view, in the order of its navigation and of the settings' sub-links. */
export const orchestratorPages = [
  { slug: "aufbau", label: "Aufbau & Topologie", description: "Struktur, Modelle und Kosten" },
  { slug: "agenten", label: "Agenten & Prompts", description: "Spezialisten und ihre System-Prompts bearbeiten" },
  { slug: "laeufe", label: "Letzte Läufe", description: "Fragen mit Agent, Werkzeugen, Modellen und Dauer" },
  { slug: "werkzeuge", label: "Werkzeuge", description: "Welche Werkzeuge jeder Spezialist hat" },
  { slug: "feedback", label: "Feedback & Prüfung", description: "Feedback-Datei und Prüfungs-Agent" },
] as const;

export type OrchestratorView = (typeof orchestratorPages)[number]["slug"];

export const orchestratorHref = (slug: OrchestratorView) => `/einstellungen/orchestrator/${slug}`;
