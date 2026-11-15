import { z } from "zod";
import { contentWords } from "@/lib/knowledge-base/query";
import { isPromptId, type PromptId } from "@/lib/ai/agent-prompts";
import { looksInjected, maskContacts } from "@/lib/ai/untrusted";
import type { StoredFeedback } from "./feedback";
import { agentIds, type AgentId } from "./orchestrator";

/**
 * What the assistant learned from feedback. The review agent turns a concrete 👎 comment into a one-sentence change of the
 * prompt that caused it, tests it again and against the gold eval, and only then writes it into the agent's prompt. Older
 * entries are rules that are added to the prompts of the agents they concern. Everything lives in one local JSON file that
 * the admin view shows; each change can be taken back there.
 */

export const RULES_FORMAT = "finanzblick-assistant-rules";
export const MAX_RULES = 200;
/** More rules make every prompt longer; past this many a new one waits until another is switched off. */
export const MAX_ACTIVE_RULES = 12;

export const ruleScopes = [...agentIds, "all"] as const;
export type RuleScope = (typeof ruleScopes)[number];
/** `answer`: how answers are written. `routing`: which agent and tool handle a message. */
export const ruleTargets = ["answer", "routing"] as const;
export type RuleTarget = (typeof ruleTargets)[number];
export const ruleStatuses = ["pending", "checking", "active", "rejected", "vague", "unusable", "disabled", "error"] as const;
export type RuleStatus = (typeof ruleStatuses)[number];

const scoreSchema = z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), hard: z.number().int().nonnegative() }).strict();
export type RuleScore = z.infer<typeof scoreSchema>;

export const feedbackRuleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  // The feedback entry (assistant-feedback.json) the comment came from.
  feedbackId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
  status: z.enum(ruleStatuses),
  comment: z.string().max(500),
  question: z.string().max(300),
  answer: z.string().max(400),
  agent: z.enum(agentIds).optional(),
  rule: z.string().max(240).optional(),
  scope: z.enum(ruleScopes).optional(),
  target: z.enum(ruleTargets).optional(),
  // Why it is not active: too vague, not usable as a rule, worse in the eval, DeepSeek unavailable.
  reason: z.string().max(200).optional(),
  // "prompt": a change the review agent wrote into an agent's prompt; without a kind, a rule added to the prompts (older entries).
  kind: z.enum(["rule", "prompt"]).optional(),
  // The change: a sentence appended to the prompt, or one sentence of it replaced. `rule` repeats the new sentence for display.
  prompt: z.object({
    id: z.custom<PromptId>((value) => isPromptId(value)), mode: z.enum(["append", "replace"]), before: z.string().max(600).optional(), after: z.string().max(240),
  }).strict().optional(),
  // The review agent asked the question again with the changed prompt and judged whether that fixes the complaint.
  review: z.object({ fixed: z.boolean(), note: z.string().max(200), replay: z.string().max(400).optional() }).strict().optional(),
  // When the change went live (again); the votes since then are counted for it.
  appliedAt: z.string().max(40).optional(),
  // The gold eval without and with the rule; `passed` means the rule may be active.
  check: z.object({
    at: z.string().max(40), model: z.string().max(80), passed: z.boolean(), baseline: scoreSchema, candidate: scoreSchema,
    // The eval cases that passed without the rule and failed with it.
    worse: z.array(z.string().max(120)).max(5).optional(),
  }).strict().optional(),
}).strict();
export type FeedbackRule = z.infer<typeof feedbackRuleSchema>;

export const rulesFileSchema = z.object({
  format: z.literal(RULES_FORMAT),
  version: z.literal(1),
  about: z.string(),
  updatedAt: z.string(),
  rules: z.array(feedbackRuleSchema).max(MAX_RULES),
}).strict();
export type RulesFile = z.infer<typeof rulesFileSchema>;

export function rulesFile(rules: FeedbackRule[], now = new Date()): RulesFile {
  return {
    format: RULES_FORMAT, version: 1,
    about: "Was der Prüfungs-Agent aus 👎-Kommentaren gelernt hat: Prompt-Änderungen (und ältere Regeln). Aktiv ist eine Änderung nur, wenn der Nachtest " +
      "die Beschwerde behebt und die Gold-Eval gleich gut oder besser bleibt. Zurücknehmen unter Einstellungen → Assistent-Orchestrator → Feedback.",
    updatedAt: now.toISOString(),
    rules: rules.slice(-MAX_RULES),
  };
}

/** A rule as the prompts use it. */
export type RuleText = { text: string; scope: RuleScope; target: RuleTarget };

export const activeRules = (rules: FeedbackRule[]): RuleText[] => rules
  .filter((rule): rule is FeedbackRule & { rule: string } => rule.status === "active" && !!rule.rule && rule.kind !== "prompt")
  .slice(-MAX_ACTIVE_RULES)
  .map((rule) => ({ text: rule.rule, scope: rule.scope ?? "all", target: rule.target ?? "answer" }));

/** The rules for one agent and one kind of prompt; `undefined` agent means the orchestrator (rules for all agents only). */
export const rulesFor = (rules: readonly RuleText[] | undefined, agent: AgentId | undefined, target: RuleTarget): string[] =>
  (rules ?? []).filter((rule) => rule.target === target && (rule.scope === "all" || rule.scope === agent)).map((rule) => rule.text);

/** Appended at the very end of a system prompt, so the cached prefix stays the same; the safety rules above keep priority. */
export const rulesSection = (rules: readonly string[]): string => rules.length
  ? ` Zusätzliche Regeln aus dem Feedback des Nutzers (sie ergänzen die Regeln oben, heben sie aber nie auf): ${rules.map((rule, index) => `${index + 1}) ${rule}`).join(" ")}`
  : "";

const vagueOnly = /^(?:(?:das |es |die antwort )?(?:war|ist)\s+)?(?:echt |voll |total |sehr |ganz |einfach |leider )*(?:schlecht|falsch|doof|mist|bloed|blöd|schwach|nicht gut|nicht hilfreich|nicht richtig|unbrauchbar|quatsch|nutzlos|komisch|seltsam|bad|wrong|nein|nope|naja|meh|hm+|nix|nichts)[\s!.?]*$/i;

/** A comment too vague to learn from ("war schlecht", "falsch", "?"): it is kept, but no rule is derived. */
export function vagueComment(comment: string): boolean {
  const text = comment.replace(/\s+/g, " ").trim();
  return text.length < 12 || contentWords(text).length < 2 || vagueOnly.test(text);
}

// A rule must not weaken the safety rules, invent figures or carry contact data.
const unsafeRule = /sicherheitsregel|system ?prompt|anweisung\p{L}* (?:ignor|missacht)|ignorier|erfinde|schätz\p{L}* (?:zahlen|beträge)|ohne (?:beleg|prüfung|quelle)|links? (?:aus|weiter)geben|kontonummer|iban|passwort|kennwort/iu;

/** The proposed rule, cleaned: one or two sentences, at most 240 characters, nothing unsafe; otherwise undefined. */
export function cleanRule(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/^["„“'»«\s]+|["„“'»«\s]+$/g, "").replace(/\s+/g, " ").trim();
  if (text.length < 15 || text.length > 240 || !/\p{L}{4}/u.test(text)) return undefined;
  // "z. B." or "bzw." ends no sentence.
  const plain = text.replace(/\b(?:z\.\s?b|d\.\s?h|u\.\s?a|bzw|ca|etc|inkl|exkl|evtl|ggf|usw|vgl|zzgl|mind|max|min|nr)\./giu, "");
  if ((plain.match(/[.!?](?:\s|$)/g) ?? []).length > 2) return undefined;
  if (unsafeRule.test(text) || looksInjected(text) || maskContacts(text) !== text || /\d{5,}/.test(text)) return undefined;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Whether two rules say the same: most of their meaningful words match. */
export function sameRule(a: string, b: string): boolean {
  const left = new Set(contentWords(a));
  const right = new Set(contentWords(b));
  if (!left.size || !right.size) return false;
  return [...left].filter((word) => right.has(word)).length / Math.max(left.size, right.size) >= 0.7;
}

export const statusLabel: Record<RuleStatus, string> = {
  pending: "Wartet auf Prüfung", checking: "Wird geprüft", active: "Aktiv", rejected: "Abgelehnt", vague: "Zu vage", unusable: "Keine Änderung",
  disabled: "Zurückgenommen", error: "Fehler",
};

export type PromptEdit = NonNullable<FeedbackRule["prompt"]>;

// A closing format instruction ("Antworte nur mit JSON …") stays last: a new sentence goes before it, where the model heeds it.
const formatLine = /Antworte nur mit JSON/;

/** The prompt with the learned change; undefined when the sentence to replace is not (or no longer) in it. */
export function applyEdit(text: string, edit: PromptEdit): string | undefined {
  const base = text.trim();
  if (edit.mode === "append") {
    const format = base.search(formatLine);
    return format > 0 ? `${base.slice(0, format)}${edit.after} ${base.slice(format)}` : `${base} ${edit.after}`;
  }
  return edit.before && base.includes(edit.before) ? base.replace(edit.before, () => edit.after) : undefined;
}

/** The prompt without the learned change; undefined when it is no longer in it (someone edited it by hand). */
export function revertEdit(text: string, edit: PromptEdit): string | undefined {
  const base = text.trim();
  if (!base.includes(edit.after)) return undefined;
  if (edit.mode === "replace") return edit.before ? base.replace(edit.after, () => edit.before ?? "") : undefined;
  const spaced = [`${edit.after} `, ` ${edit.after}`].find((part) => base.includes(part)) ?? edit.after;
  return base.replace(spaced, "").trim();
}

/** The agent a prompt belongs to; the supervisor's prompts and the answer rules shape every agent's answers. */
export const promptAgent = (id: PromptId): AgentId | undefined => {
  const agent = id.split(".")[1];
  return (agentIds as readonly string[]).includes(agent) ? agent as AgentId : undefined;
};

/**
 * The 👍/👎 given while a learned change was live, on answers it could shape (its agent's, or every answer for the supervisor
 * and the answer rules); computed from the feedback file whenever it is shown, so a changed vote never counts twice.
 */
export function votesSince(rule: FeedbackRule, entries: readonly StoredFeedback[]): { up: number; down: number } | undefined {
  const from = rule.appliedAt ?? rule.check?.at;
  if (!from || !rule.check?.passed || rule.status !== "active" && rule.status !== "disabled") return undefined;
  const until = rule.status === "disabled" ? rule.updatedAt : undefined;
  const agent = rule.prompt ? promptAgent(rule.prompt.id) : rule.scope && rule.scope !== "all" ? rule.scope : undefined;
  const votes = entries.filter((entry) => {
    const at = entry.updatedAt ?? entry.recordedAt;
    return entry.id !== rule.feedbackId && at >= from && (!until || at <= until) && (!agent || entry.answer.agent.id === agent);
  });
  return { up: votes.filter((entry) => entry.rating === "like").length, down: votes.filter((entry) => entry.rating === "dislike").length };
}
