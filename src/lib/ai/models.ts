// Which model answers which kind of work, and how a model is named in the UI. Pure: used by server and browser.

/** The kinds of model work; the orchestrator picks one per call. */
export const aiTasks = ["chat", "route", "action", "reasoning", "categorize", "web", "extract", "document"] as const;
export type AiTask = (typeof aiTasks)[number];
export type ModelTier = "fast" | "pro" | "reasoning";
export type AiProvider = "deepseek" | "local";

/** Cloud tier per task: fast for most work, pro for multi-step actions, the thinking mode for analyses and tax questions. */
export const taskTier: Record<AiTask, ModelTier> = {
  chat: "fast", route: "fast", categorize: "fast", web: "fast", extract: "fast", document: "fast",
  action: "pro", reasoning: "reasoning",
};

export const taskLabel: Record<AiTask, string> = {
  chat: "Antwort", route: "Werkzeugwahl", action: "Aktion", reasoning: "Analyse", categorize: "Kategorisierung",
  web: "Websuche", extract: "Erkennung", document: "Dokument",
};

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

/** Analyses, tax questions and "should I …" advice get the thinking model; short or casual questions stay fast. */
export function needsReasoning(question: string, agent?: string): boolean {
  const text = question.trim();
  if (text.length < 12) return false;
  return agent === "payroll" && /\b(?:steuer\w*|netto|brutto|sv|sozialversicherung|sechstel|veranlagung|absetz\w*|progression)\b/i.test(text) ||
    reasoningWords.test(text);
}
