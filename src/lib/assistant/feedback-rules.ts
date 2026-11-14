import { z } from "zod";
import { contentWords } from "@/lib/knowledge-base/query";
import { looksInjected, maskContacts } from "@/lib/ai/untrusted";
import { agentIds, type AgentId } from "./orchestrator";

/**
 * Rules learned from 👎 comments: DeepSeek turns a concrete comment into one short rule, the gold eval decides whether
 * it may go live, and active rules are added to the prompts of the agents they concern. Everything lives in one local
 * JSON file that the admin view shows; each rule can be switched off there.
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
    about: "Regeln, die der Finanz-Assistent aus 👎-Kommentaren gelernt hat. Aktiv ist eine Regel nur, wenn die Gold-Eval mit ihr gleich gut oder besser war. " +
      "Ein- und ausschalten unter Einstellungen → Assistent-Orchestrator → Regeln aus Feedback.",
    updatedAt: now.toISOString(),
    rules: rules.slice(-MAX_RULES),
  };
}

/** A rule as the prompts use it. */
export type RuleText = { text: string; scope: RuleScope; target: RuleTarget };

export const activeRules = (rules: FeedbackRule[]): RuleText[] => rules
  .filter((rule): rule is FeedbackRule & { rule: string } => rule.status === "active" && !!rule.rule)
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
  if ((text.match(/[.!?](?:\s|$)/g) ?? []).length > 2) return undefined;
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
  pending: "Wartet auf Prüfung", checking: "Wird geprüft", active: "Aktiv", rejected: "Abgelehnt", vague: "Zu vage", unusable: "Keine Regel",
  disabled: "Deaktiviert", error: "Fehler",
};
