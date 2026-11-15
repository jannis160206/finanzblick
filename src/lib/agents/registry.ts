import type { ModelTier } from "@/lib/ai/models";
import { changingTools } from "@/lib/assistant/conversation";
import { toolOwner, type AgentId } from "@/lib/assistant/orchestrator";
import { toolLabel } from "@/lib/assistant/orchestrator-info";
import { assistantTools, toolDescriptions, type AssistantTool } from "@/lib/assistant/tools";

/**
 * The agent platform as code defaults: which agents there are, what each may do, which tools read which data and what the
 * agents know. The agent repo (agent-repo-store) overrides prompts, models, limits, tool descriptions and knowledge; a save
 * applies to the next run. Pure, so the browser (runtime, admin view) and the server (agent steps) read the same registry.
 *
 * Shape (orchestrator-worker, "agents as tools"): the orchestrator, an LLM agent, delegates to subagents through tool calls
 * and writes the final answer. The subagents run their own tool loop over their reading tools – on the user's data in the
 * browser – and return findings. Changes are a code workflow with a fixed order that always asks first.
 */

export const subagentKeys = ["transactions", "contracts", "budget", "payroll", "research"] as const;
export type SubagentKey = typeof subagentKeys[number];
export const llmAgentKeys = ["orchestrator", ...subagentKeys] as const;
export type LlmAgentKey = typeof llmAgentKeys[number];
export const agentKeys = [...llmAgentKeys, "changes", "review", "fallback"] as const;
export type AgentKey = typeof agentKeys[number];
export const isSubagentKey = (value: unknown): value is SubagentKey => typeof value === "string" && (subagentKeys as readonly string[]).includes(value);
export const isLlmAgentKey = (value: unknown): value is LlmAgentKey => typeof value === "string" && (llmAgentKeys as readonly string[]).includes(value);
export const isAgentKey = (value: unknown): value is AgentKey => typeof value === "string" && (agentKeys as readonly string[]).includes(value);

/** llm: a model in a tool loop. workflow: code in a fixed order. background: works on feedback. fallback: without DeepSeek. */
export type AgentKind = "llm" | "workflow" | "background" | "fallback";
export type AgentLimits = { maxSteps: number; maxToolCalls: number; timeoutMs: number; maxTokens: number };
export type AgentConfig = AgentLimits & { tier: ModelTier };
export const modelTiers: readonly ModelTier[] = ["fast", "pro", "reasoning"];

export const agentLimitBounds: Record<keyof AgentLimits, { min: number; max: number }> = {
  maxSteps: { min: 1, max: 12 }, maxToolCalls: { min: 0, max: 24 }, timeoutMs: { min: 5_000, max: 300_000 }, maxTokens: { min: 200, max: 4000 },
};

export type AgentDef = {
  key: AgentKey;
  name: string;
  kind: AgentKind;
  /** One line for lists and the topology. */
  summary: string;
  config?: AgentConfig;
  /** How a workflow runs, e.g. "Code · feste Reihenfolge · fragt zuerst". */
  mode?: string;
};

const subagentConfig: AgentConfig = { tier: "fast", maxSteps: 4, maxToolCalls: 6, timeoutMs: 45_000, maxTokens: 700 };

export const agentDefs: AgentDef[] = [
  { key: "orchestrator", name: "Orchestrator", kind: "llm", summary: "Top-Agent: delegiert an die Spezialisten und schreibt die Antwort in Markdown",
    config: { tier: "pro", maxSteps: 5, maxToolCalls: 8, timeoutMs: 120_000, maxTokens: 900 } },
  { key: "transactions", name: "Umsätze", kind: "llm", summary: "Buchungen, Ausgaben, Händler, Rückblicke, Auffälligkeiten", config: subagentConfig },
  { key: "contracts", name: "Verträge", kind: "llm", summary: "Verträge und Abos, Kosten, Fristen, Kündigung", config: subagentConfig },
  { key: "budget", name: "Budget & Prognose", kind: "llm", summary: "Monatsplan, Konten, Prognose, Sparziele, Rechner", config: subagentConfig },
  { key: "payroll", name: "Gehalt & Steuern", kind: "llm", summary: "Lohnabrechnung, Lohnsteuer, Sonderzahlungen, Veranlagung", config: subagentConfig },
  { key: "research", name: "Recherche & Wissen", kind: "llm", summary: "Websuche, Finanzwissen, Marktdaten, App-Hilfe", config: subagentConfig },
  { key: "changes", name: "Änderungen", kind: "workflow", summary: "Liest den Änderungswunsch, zeigt eine Vorschau und ändert erst nach Bestätigung",
    mode: "Code · feste Reihenfolge · fragt zuerst" },
  { key: "review", name: "Prüfungs-Agent", kind: "background", summary: "Arbeitet 👍/👎 ab und passt Prompts an – nach Nachtest und Gold-Eval",
    config: { tier: "pro", maxSteps: 2, maxToolCalls: 0, timeoutMs: 300_000, maxTokens: 320 } },
  { key: "fallback", name: "Lokaler Rückfall", kind: "fallback", summary: "Ohne DeepSeek: feste Regeln, Signalwörter und Qwen auf der NPU",
    mode: "Regeln · Signalwörter · Qwen" },
];
export const agentDef = (key: AgentKey): AgentDef => agentDefs.find((agent) => agent.key === key) ?? agentDefs[0];
export const agentName = (key: AgentKey) => agentDef(key).name;

/** The app's agent name for a subagent's answers, chat history and feedback (research answers like the general chat). */
export const answerAgent = (key: SubagentKey): AgentId => key === "research" ? "general" : key;

export type DataSourceId = "buchungen" | "regeln" | "vertraege" | "plan" | "konten" | "ziele" | "gehalt" | "bestellungen" | "gedaechtnis" | "seite"
  | "app" | "rechner" | "web" | "wissen" | "markt";
export type DataSource = { id: DataSourceId; label: string; detail: string };
export const dataSources: DataSource[] = [
  { id: "buchungen", label: "Buchungen", detail: "SQLite · lokal" },
  { id: "regeln", label: "Kategorie-Regeln", detail: "SQLite · lokal" },
  { id: "vertraege", label: "Verträge & Abos", detail: "erkannt und eigene" },
  { id: "plan", label: "Monatsplan & Budgets", detail: "SQLite · lokal" },
  { id: "konten", label: "Konten & Pockets", detail: "Stände, Amex, Kontoregeln" },
  { id: "ziele", label: "Sparziele & Ausgaben", detail: "SQLite · lokal" },
  { id: "gehalt", label: "Lohnabrechnungen", detail: "PDF-Import · lokal" },
  { id: "bestellungen", label: "Bestellungen", detail: "Gmail · nur lesen" },
  { id: "gedaechtnis", label: "Gedächtnis", detail: "Gemerktes und Änderungen" },
  { id: "seite", label: "Aktuelle Seite", detail: "angezeigte Buchungen" },
  { id: "app", label: "App-Hilfe", detail: "Seiten und Funktionen" },
  { id: "rechner", label: "Rechner", detail: "Code, ohne Daten" },
  { id: "web", label: "Websuche", detail: "Bing · DuckDuckGo · Wikipedia" },
  { id: "wissen", label: "Finanzwissen", detail: "lokale Vektoren (RAG)" },
  { id: "markt", label: "Marktdaten", detail: "EZB · Eurostat · CoinGecko" },
];
export const dataSource = (id: DataSourceId): DataSource => dataSources.find((source) => source.id === id) ?? dataSources[0];

/** Where each tool reads from (or, for changes, writes to). */
const toolSource: Record<AssistantTool, DataSourceId> = {
  query: "buchungen", why: "regeln", security: "buchungen", refunds: "buchungen", context: "seite", orders: "bestellungen", shared: "buchungen",
  month_review: "buchungen", review: "buchungen", cleanup: "buchungen", booking: "buchungen", rule: "regeln",
  contracts: "vertraege", cancel: "vertraege", contract_new: "vertraege", contract_edit: "vertraege",
  budget: "plan", pulse: "plan", forecast: "konten", funds: "konten", whatif: "ziele", coach: "plan", check: "plan", briefing: "plan",
  insights: "plan", accounts: "konten", amex: "konten", networth: "konten", depot: "rechner", loan: "rechner", budget_plan: "plan",
  account_rule: "konten", affordability: "plan", savings_goal: "ziele", expense: "ziele", edit: "ziele", batch: "ziele",
  payroll: "gehalt", tax: "gehalt", homeoffice: "rechner", payroll_action: "gehalt",
  knowledge: "wissen", market: "markt", explain: "app", help: "app", memory: "gedaechtnis", changes: "gedaechtnis", remember: "gedaechtnis",
  forget: "gedaechtnis", undo: "gedaechtnis", reminder: "gedaechtnis", settings: "app", ask: "app",
};

/** The tools of the change workflow: everything that changes data (and the bulk assignment) – always a preview first. */
export const workflowTools: readonly AssistantTool[] = [...changingTools, "cleanup"];
const researchTools: readonly AssistantTool[] = ["knowledge", "market", "explain", "help", "memory", "changes"];
const subagentOf = (tool: AssistantTool): SubagentKey | undefined => {
  if (tool === "ask" || workflowTools.includes(tool)) return undefined;
  if (researchTools.includes(tool)) return "research";
  const owner: AgentId = toolOwner[tool];
  return owner === "general" ? undefined : owner;
};

/** Function names of the orchestrator's tools: one per subagent, plus the change workflow. */
export const delegateTool: Record<SubagentKey, string> = {
  transactions: "umsaetze", contracts: "vertraege", budget: "budget", payroll: "gehalt", research: "recherche",
};
export const CHANGE_TOOL = "aenderung";
export const WEB_TOOL_NAME = "web";
export const subagentForTool = (name: string): SubagentKey | undefined => subagentKeys.find((key) => delegateTool[key] === name);

export type ToolKind = "read" | "change" | "delegate" | "workflow";
export type ToolParam = { name: "frage" | "suche" | "aufgabe" | "auftrag"; description: string };
export type ToolSpec = {
  name: string;
  label: string;
  /** What the model reads to decide when to call the tool; editable in the tool repo. */
  description: string;
  source?: DataSourceId;
  /** The agents that may call it. */
  agents: AgentKey[];
  kind: ToolKind;
  /** The one argument the tool takes; its code stays in the app. */
  param: ToolParam;
};

const question: ToolParam = { name: "frage", description: "Die konkrete Teilfrage in der Ich-Form, vollständig ausgeschrieben – mit Zeitraum, Händler, Konto oder Betrag, wenn es darauf ankommt." };

export const subagentDescriptions: Record<SubagentKey, string> = {
  transactions: "Spezialist Umsätze: vergangene Buchungen, Ausgaben und Einnahmen nach Zeitraum, Händler, Konto oder Kategorie, Monats- und Jahresrückblick, " +
    "doppelte oder verdächtige Buchungen, Rückerstattungen, offene Online-Bestellungen, geteilte Kosten, warum eine Buchung in ihrer Kategorie steht. " +
    "Nicht für Kontostände, Amex-Abrechnung, Prognosen oder Rechner – das ist budget.",
  contracts: "Spezialist Verträge: Verträge und Abos mit Betrag, Jahreskosten, nächster Abbuchung, Kündigungsfrist und Preiserhöhung; Kündigungshilfe.",
  budget: "Spezialist Budget & Prognose: Kontostände und Pockets („Wie viel ist am Sparkonto?“), Amex-Abrechnung und was noch aufs Rückzahlungs-Pocket " +
    "muss, Monatsplan und was übrig bleibt, was heute noch sicher ausgegeben werden kann, Kontoprognose („Wird mein Konto knapp?“, „Mein Konto ist " +
    "leer“), Sparziele, Finanz-Check („Bin ich sparsam?“), Sparpotenzial, ob sich ein Kauf ausgeht, Was-wäre-wenn („Wenn ich Netflix kündige und " +
    "mehr spare, wann erreiche ich mein Ziel?“), Sparplan- und Kreditrechner („300 € im Monat 5 Jahre anlegen“ heißt investieren, nicht etwas " +
    "in der App anlegen), Vermögen.",
  payroll: "Spezialist Gehalt & Steuern (Österreich): Lohnabrechnung, netto und brutto, Lohnsteuer und Grenzsteuersatz, Sonderzahlungen und Jahressechstel, " +
    "Arbeitnehmerveranlagung, Home-Office-Absetzbeträge; auch wie Überstunden, Prämien und Sonderzahlungen versteuert werden.",
  research: "Spezialist Recherche & Wissen: Websuche für Begriffe, aktuelle Werte (Kurse, Zinsen, Preise, Steuersätze, Nachrichten), Angebote, Vergleiche " +
    "und Regeln in Österreich; lokales Finanzwissen, Marktdaten, Fragen zur App und was der Assistent sich gemerkt oder geändert hat. Steuerfragen " +
    "zum eigenen Lohn gehen an gehalt (aktuelle Grenzbeträge zusätzlich hierher).",
};

/** Every tool of the platform with its code default. */
export const toolSpecs: ToolSpec[] = [
  ...subagentKeys.map((key): ToolSpec => ({
    name: delegateTool[key], label: agentName(key), description: subagentDescriptions[key], agents: ["orchestrator"], kind: "delegate",
    param: { name: "aufgabe", description: "Die Aufgabe für den Spezialisten: Ziel, Zeitraum, Konto, Händler oder Betrag und was zurückkommen soll." },
  })),
  {
    name: CHANGE_TOOL, label: "Änderung vorbereiten", agents: ["orchestrator"], kind: "workflow",
    description: "Übergibt an den Änderungs-Workflow: Der Nutzer will etwas anlegen, ändern, löschen, umbenennen, taggen, zuordnen, abarbeiten, merken, " +
      "erinnern, einstellen oder rückgängig machen („nimm das zurück“) – Sparziel, geplante Ausgabe, Budget, Buchung, Kategorie-Regel, offene Buchungen, " +
      "Vertrag, Kontoregel, Lohnabrechnung, Erinnerung. Der Workflow zeigt eine Vorschau und ändert erst nach Bestätigung. Nie für Rat, Meinung oder " +
      "eine Korrektur deiner Antwort.",
    param: { name: "auftrag", description: "Der Änderungswunsch des Nutzers in seinen Worten, vollständig." },
  },
  { name: WEB_TOOL_NAME, label: "Websuche", source: "web", agents: ["research"], kind: "read",
    description: "Websuche: aktuelle Werte (Kurse, Preise, Zinsen, Steuersätze, Nachrichten), Begriffe, Angebote, Vergleiche, Regeln in Österreich und alles " +
      "außerhalb der App. Liefert Ausschnitte mit Quelle und Datum.",
    param: { name: "suche", description: "Kurze Suchanfrage wie in einer Suchmaschine, ohne persönliche Daten; erst allgemein, dann genauer." } },
  ...assistantTools.flatMap((tool): ToolSpec[] => {
    const owner = subagentOf(tool);
    const changes = workflowTools.includes(tool);
    if (!owner && !changes) return [];
    return [{ name: tool, label: toolLabel[tool] ?? tool, description: toolDescriptions[tool], source: toolSource[tool],
      agents: owner ? [owner] : ["changes"], kind: changes ? "change" : "read", param: question }];
  }),
];
export const toolSpec = (name: string): ToolSpec | undefined => toolSpecs.find((tool) => tool.name === name);
export const agentToolSpecs = (agent: AgentKey): ToolSpec[] => toolSpecs.filter((tool) => tool.agents.includes(agent));

/** Which data sources an agent reads, from its tools. */
export const agentSources = (agent: AgentKey): DataSourceId[] =>
  [...new Set(agentToolSpecs(agent).flatMap((tool) => tool.source ? [tool.source] : []))];

export type KnowledgeDoc = { id: string; title: string; text: string };
/** What an agent reads of its knowledge in every run, and the most one document may hold. */
export const MAX_KNOWLEDGE_CHARS = 12_000;
export const MAX_KNOWLEDGE_DOC = 6_000;

/** Knowledge the code ships per agent; read in every run of that agent. Admin edits and deletions are new versions. */
export const defaultKnowledge: Partial<Record<AgentKey, KnowledgeDoc[]>> = {
  payroll: [{ id: "lohnsteuer-oesterreich", title: "Lohnsteuer und Sonderzahlungen in Österreich",
    text: "Österreich hat keine Steuerklassen, sondern einen progressiven Tarif von 0 bis 55 % mit Absetzbeträgen. Sonderzahlungen (Urlaubs- und " +
      "Weihnachtsgeld) im Jahressechstel sind nach der Sozialversicherung bis 620 € frei und darüber mit 6 % begünstigt; was das Jahressechstel " +
      "übersteigt, wird wie laufender Bezug versteuert. Überstundenzuschläge sind nur bis zu einem Höchstbetrag steuerfrei. Nenne Grenzbeträge nur, " +
      "wenn sie in den Daten stehen oder die Recherche sie liefert." }],
  budget: [{ id: "begriffe-ueberblick", title: "Begriffe im Datenüberblick",
    text: "currentMonth.surplus ist der geplante Überschuss des Monats (negativ = Lücke). safeToSpendToday.perDay ist, was pro Tag bis zum Gehalt sicher " +
      "ausgegeben werden kann. amex.stillToTransfer ist, was noch auf das Amex-Rückzahlungs-Pocket überwiesen werden muss." }],
  transactions: [{ id: "begriffe-umsaetze", title: "Begriffe bei Umsätzen",
    text: "yearToDate.savedSinceJanuary ist Einnahmen minus Ausgaben seit Jänner, nicht der Kontostand. Umbuchungen zwischen eigenen Konten " +
      "(Transfer intern) sind weder Ausgabe noch Einnahme." }],
  research: [{ id: "quellen-oesterreich", title: "Gute Quellen in Österreich",
    text: "Für Steuern, Beihilfen und Regeln zuerst amtliche Quellen (oesterreich.gv.at, bmf.gv.at, usp.gv.at), für Verbraucherfragen und Vergleiche " +
      "die Arbeiterkammer und unabhängige Tests, für Zinsen und Inflation OeNB, EZB und Statistik Austria. Nenne immer Stand und Quelle; was " +
      "nicht gefunden wurde, sagst du ehrlich." }],
};

/** A data set of the app as the agents read it, for the data catalog. */
export type CatalogEntry = { id: DataSourceId; grain: string; description: string; fields: [string, string][]; related: DataSourceId[] };
export const dataCatalog: CatalogEntry[] = [
  { id: "buchungen", grain: "eine Zeile je Buchung eines Kontos oder Pockets", related: ["regeln", "vertraege", "plan", "konten", "seite"],
    description: "Alle importierten Umsätze (CSV, Excel, Amex, PayPal, Trade Republic, Revolut, Raiffeisen). Ausgaben sind negativ, Einnahmen positiv; " +
      "Umbuchungen zwischen eigenen Konten sind Transfer intern und zählen nicht als Ausgabe.",
    fields: [["date", "Buchungstag"], ["amount", "Betrag in €, negativ = Ausgabe"], ["bank / pocket", "Konto bzw. Pocket"], ["description", "Text der Bank"],
      ["merchantAlias", "erkannter Händler"], ["category", "Kategorie (Prüfen = offen)"], ["fixedCost", "Fixkosten ja/nein"]] },
  { id: "regeln", grain: "eine Zeile je Händler-Regel", related: ["buchungen"],
    description: "Gelernte und manuelle Zuordnungen von Händlern zu Kategorien; erklären, warum eine Buchung in ihrer Kategorie steht.",
    fields: [["key", "Händler-Schlüssel"], ["category", "Kategorie"], ["fixedCost", "als Fixkosten"], ["merchantAlias", "Anzeigename"]] },
  { id: "vertraege", grain: "ein Vertrag oder Abo", related: ["buchungen", "plan"],
    description: "Aus wiederkehrenden Abbuchungen erkannte und selbst angelegte Verträge mit Rhythmus, nächster Abbuchung, Frist und Preisänderung.",
    fields: [["name", "Anbieter"], ["amount / interval", "Betrag und Rhythmus"], ["nextDate", "nächste Abbuchung"], ["notice / termEnd", "Kündigungsfrist und Laufzeit"],
      ["status", "bestätigt, ausgeblendet, gekündigt"]] },
  { id: "plan", grain: "ein Monat mit Positionen und Budgets", related: ["buchungen", "ziele", "gehalt", "konten"],
    description: "Monatsplan: Einnahmen, Fixkosten, Budgets je Kategorie, Sparraten und was übrig bleibt; daraus Monats-Puls und Prognose.",
    fields: [["income", "Einnahmen"], ["fixed", "Fixkosten"], ["budgets", "Budgets je Kategorie"], ["surplus", "Überschuss oder Lücke"]] },
  { id: "konten", grain: "ein Konto oder Pocket mit Stand", related: ["buchungen", "plan", "ziele"],
    description: "Kontostände von Girokonto, Sparkonto, Pockets und Depot, Amex-Abrechnung und Kontoregeln (wofür ein Konto verwendet werden darf).",
    fields: [["name", "Konto oder Pocket"], ["balance", "Stand"], ["rules", "Kontoregeln"]] },
  { id: "ziele", grain: "ein Sparziel oder eine geplante Ausgabe", related: ["plan", "konten"],
    description: "Sparziele mit Zielbetrag, Datum und monatlicher Rate; geplante einmalige Ausgaben und Ratenkäufe.",
    fields: [["name", "Name"], ["target / amount", "Ziel- bzw. Ausgabebetrag"], ["date", "Zieldatum"], ["funding.monthly", "monatliche Rate"]] },
  { id: "gehalt", grain: "eine Lohnabrechnung je Monat", related: ["plan"],
    description: "Importierte Lohnabrechnungen mit Brutto, Netto, Lohnsteuer, Sozialversicherung, Sonderzahlungen und Jahressechstel.",
    fields: [["month", "Abrechnungsmonat"], ["gross / net", "Brutto und Netto"], ["tax / social", "Lohnsteuer und SV"], ["special", "Sonderzahlungen"]] },
  { id: "bestellungen", grain: "eine offene Bestellung", related: ["buchungen"],
    description: "Bestellbestätigungen aus Gmail (Klarna, PayPal, Kauf auf Rechnung), die noch nicht abgebucht wurden.",
    fields: [["shop", "Händler"], ["amount", "Betrag"], ["due", "Fälligkeit"]] },
  { id: "gedaechtnis", grain: "ein gemerkter Eintrag oder eine Änderung", related: ["plan"],
    description: "Was sich der Assistent gemerkt hat (Puffer, Gehaltstag, Erinnerungen) und welche Änderungen er gemacht hat (rückgängig machbar).",
    fields: [["text", "Eintrag"], ["key", "Art"], ["due", "Datum einer Erinnerung"]] },
];
