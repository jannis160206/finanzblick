// Which model answers which kind of work, and how a model is named in the UI. Pure: used by server and browser.

/** The kinds of model work; the orchestrator picks one per call. */
export const aiTasks = ["chat", "route", "action", "reasoning", "categorize", "web", "extract", "document", "suggest", "rule", "supervise", "synthesize",
  "orchestrate", "delegate"] as const;
export type AiTask = (typeof aiTasks)[number];
export type ModelTier = "fast" | "pro" | "reasoning";
export type AiProvider = "deepseek" | "local";

/**
 * Cloud tier per task: the orchestrator (V4 Pro) delegates and writes the answers, the specialists (Flash) fetch the data with
 * their tools; V4 Pro also reads changes and reviews feedback, the thinking mode serves tax analyses. An agent's own setting in
 * the agent repo overrides the tier. `supervise` and `synthesize` belong to answers of earlier versions in the chat history.
 */
export const taskTier: Record<AiTask, ModelTier> = {
  chat: "fast", route: "fast", categorize: "fast", web: "fast", extract: "fast", document: "fast", suggest: "fast", supervise: "fast", delegate: "fast",
  action: "pro", rule: "pro", synthesize: "pro", orchestrate: "pro", reasoning: "reasoning",
};

/** DeepSeek's list prices in US$ per million tokens at peak time (off-peak is half), as of 15.11.2026. */
export const cloudPrices: Record<string, { cached: number; input: number; output: number }> = {
  "deepseek-flash": { cached: 0.006, input: 0.3, output: 1.2 },
  "deepseek-v4-pro": { cached: 0.044, input: 1.32, output: 3.96 },
};

/** Estimated cost of token counts at peak prices; unknown models count as V4 Pro, so the estimate never comes out too low. */
export function estimateCost(model: string, usage: { input: number; cached: number; output: number }): number {
  const price = cloudPrices[model] ?? cloudPrices["deepseek-v4-pro"];
  const fresh = Math.max(0, usage.input - usage.cached);
  return (usage.cached * price.cached + fresh * price.input + usage.output * price.output) / 1_000_000;
}

export const MONTHLY_BUDGET_USD = 5;
type Tokens = { calls: number; input: number; output: number; cached: number };
// One typical question without cache hits: the orchestrator delegates and writes (two V4 Pro steps), one specialist fetches
// the data (two Flash steps), Flash writes the follow-ups.
const typicalQuestion: { model: string; input: number; cached: number; output: number }[] = [
  { model: "deepseek-v4-pro", input: 3500, cached: 0, output: 120 },
  { model: "deepseek-v4-pro", input: 5000, cached: 0, output: 400 },
  { model: "deepseek-flash", input: 1800, cached: 0, output: 80 },
  { model: "deepseek-flash", input: 2600, cached: 0, output: 200 },
  { model: "deepseek-flash", input: 800, cached: 0, output: 60 },
];

/**
 * What the cloud models cost since the server started, and what one question costs: measured from the average Flash and
 * V4 Pro call once both ran, else the typical question. Local models cost nothing.
 */
export function costOverview(usage: Record<string, Tokens> = {}) {
  const models = Object.entries(usage).filter(([model]) => model.startsWith("deepseek"))
    .map(([model, tokens]) => ({ model, calls: tokens.calls, cost: estimateCost(model, tokens) }));
  const average = (name: string) => {
    const entry = models.find((item) => item.model === name);
    return entry?.calls ? entry.cost / entry.calls : undefined;
  };
  const flash = average("deepseek-flash");
  const pro = average("deepseek-v4-pro");
  const measured = flash !== undefined && pro !== undefined;
  const perQuestion = measured ? 2 * pro + 3 * flash : typicalQuestion.reduce((sum, item) => sum + estimateCost(item.model, item), 0);
  return { models, total: models.reduce((sum, item) => sum + item.cost, 0), perQuestion, perBudget: Math.floor(MONTHLY_BUDGET_USD / perQuestion), measured };
}

export const taskLabel: Record<AiTask, string> = {
  chat: "Antwort", route: "Werkzeugwahl", action: "Aktion", reasoning: "Analyse", categorize: "Kategorisierung",
  web: "Websuche", extract: "Erkennung", document: "Dokument", suggest: "Folgefragen", rule: "Prüfungs-Agent", supervise: "Supervisor", synthesize: "Supervisor-Antwort",
  orchestrate: "Orchestrator", delegate: "Spezialist",
};

/** Work only DeepSeek does; without it the chat keeps its fixed suggestions, routes locally and rule checks wait. Never the local model. */
export const cloudOnlyTasks: Partial<Record<AiTask, string>> = { suggest: "Feste Vorschläge", rule: "Wartet auf DeepSeek", supervise: "Lokales Routing",
  orchestrate: "Lokaler Rückfall", delegate: "Lokaler Rückfall" };

/** One model call as the server reports it: who answered, for what, and whether it was the local fallback. */
export type ModelUse = {
  provider: AiProvider;
  model: string;
  task: AiTask;
  /** The local model answered because the cloud model failed or was paused. */
  fallback?: boolean;
  /** The cloud model reasoned before answering (thinking mode). */
  thinking?: boolean;
  /** Why the cloud model was skipped, e.g. "Key ungültig (HTTP 401)". */
  reason?: string;
};

const words = (value: string) => value.split(/[-_\s]+/).filter(Boolean)
  .map((word) => /^v\d/i.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1));

/** "DeepSeek Flash", "DeepSeek V4 Pro" or "Lokal (Qwen)". */
export function modelLabel(use: Pick<ModelUse, "provider" | "model">): string {
  const name = use.model.split("/").at(-1) ?? use.model;
  if (use.provider === "local") return /qwen/i.test(name) ? "Lokal (Qwen)" : `Lokal (${name.split("-")[0]})`;
  const rest = name.replace(/^deepseek[-_]?/i, "");
  return rest ? `DeepSeek ${words(rest).join(" ")}` : "DeepSeek";
}

/** The label plus the thinking mode, for the live status and the admin view. */
export const modelTitle = (use: Pick<ModelUse, "provider" | "model" | "thinking">) =>
  `${modelLabel(use)}${use.thinking ? " · Denkmodus" : ""}`;

const reasoningWords = /\b(?:warum|wieso|weshalb|analysier\w*|analyse|vergleich\w*|berechn\w*|rechne|steuer\w*|lohnsteuer|einkommensteuer|veranlagung|absetz\w*|abschreib\w*|grenzsteuer\w*|progression|sechstel|lohnt (?:sich|es)|sollte ich|soll ich|was passiert,? wenn|was wäre,? wenn|strategie|langfristig|vor- und nachteile|pro und contra|optimier\w*)\b/i;

/** A tax question for the payroll specialist; it keeps the thinking mode even when the orchestrator writes the answer. */
export const taxQuestion = (question: string, agent?: string) =>
  agent === "payroll" && /\b(?:\w*steuer\w*|netto|brutto|sv|sozialversicherung|\w*sechstel|veranlagung|absetz\w*|progression)\b/i.test(question);

/** "Warum …", "Lohnt sich …", comparisons and strategies: questions that want an analysis rather than a figure. */
export const analysisQuestion = (question: string) => reasoningWords.test(question);

/** Analyses, tax questions and "should I …" advice get the thinking model; short or casual questions stay fast. */
export function needsReasoning(question: string, agent?: string): boolean {
  const text = question.trim();
  if (text.length < 12) return false;
  return taxQuestion(text, agent) || reasoningWords.test(text);
}
