import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { proposeRule, type RuleProposal, type RuleRequest } from "@/lib/ai/feedback-rule";
import { AiUnavailableError, cloudPause } from "@/lib/ai/client";
import { readAiConfig } from "@/lib/ai/config";
import type { ModelUse } from "@/lib/ai/models";
import { fileResponseCache } from "@/lib/ai/response-cache";
import { redactSensitive, type StoredFeedback } from "@/lib/assistant/feedback";
import {
  activeRules, MAX_ACTIVE_RULES, sameRule, vagueComment, type FeedbackRule, type RuleScore, type RuleText,
} from "@/lib/assistant/feedback-rules";
import { runGold } from "@/lib/assistant/gold-eval";
import { agentIds, type AgentId } from "@/lib/assistant/orchestrator";
import { changeRules, readRules, rulesFilePath } from "./rules-store";

/**
 * The feedback loop: a 👎 with a concrete comment becomes a rule proposal from DeepSeek, the gold eval runs without and
 * with it, and only a rule that keeps the eval at least as good (and adds no safety failure) goes live. Vague comments
 * and unusable proposals are recorded, never activated. One check at a time, in the background.
 */

export type RuleLoopDeps = {
  path?: string;
  cloudReady?: () => boolean;
  propose?: (request: RuleRequest) => Promise<{ proposal: RuleProposal; use: ModelUse }>;
  evaluate?: (rules: readonly RuleText[]) => Promise<RuleScore & { model: string; failed?: string[] }>;
  now?: () => Date;
};

export type RuleJob = RuleRequest & { feedbackId: string };

const isAgent = (value: string): value is AgentId => (agentIds as readonly string[]).includes(value);

/** The rule request in a stored 👎 with comment; nothing for a 👍 or a 👎 without comment. */
export function ruleJob(entry: StoredFeedback): RuleJob | undefined {
  const comment = entry.comment?.trim();
  if (entry.rating !== "dislike" || !comment) return undefined;
  return { feedbackId: entry.id, comment, question: entry.question ?? "", answer: entry.answer.text,
    ...(isAgent(entry.answer.agent.id) ? { agent: entry.answer.agent.id } : {}) };
}

/** Whether the loop runs at all: only with DeepSeek set up (the proposal and the eval run there). */
export const ruleLoopEnabled = () => !!readAiConfig().cloud;
const cloudReady = () => !!readAiConfig().cloud && !cloudPause();

// The gold questions plus the answer cases on DeepSeek's fast model, four at a time; unchanged prompts come from the cache.
function goldEvaluator(path: string) {
  const cache = fileResponseCache(join(dirname(path), "ai-cache", "rule-eval"));
  return async (rules: readonly RuleText[]) => {
    const score = await runGold({ rules, answers: true, concurrency: 4, chat: { tier: "fast", cloudOnly: true, cache } });
    return { passed: score.passed, total: score.total, hard: score.hard, model: readAiConfig().cloud?.models.fast ?? "deepseek",
      failed: score.results.filter((result) => !result.ok).map((result) => result.label) };
  };
}

let checks: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(task: () => Promise<T>): Promise<T> => {
  const next = checks.catch(() => undefined).then(task);
  checks = next;
  return next;
};

/**
 * Learns from one 👎 comment. A comment that was already handled is not checked again unless `force` (the admin's
 * "Erneut prüfen"). Returns the rule as stored.
 */
export function learnRule(job: RuleJob, deps: RuleLoopDeps = {}, force = false): Promise<FeedbackRule> {
  const path = deps.path ?? rulesFilePath();
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  return oneAtATime(async () => {
    const comment = redactSensitive(job.comment).replace(/\s+/g, " ").trim().slice(0, 500);
    const existing = (await readRules(path)).find((rule) => rule.feedbackId === job.feedbackId);
    if (existing && existing.comment === comment && !force && existing.status !== "pending" && existing.status !== "error") return existing;
    const base: FeedbackRule = {
      id: existing?.id ?? randomUUID(), feedbackId: job.feedbackId, createdAt: existing?.createdAt ?? now(), updatedAt: now(), status: "pending", comment,
      question: redactSensitive(job.question).slice(0, 300), answer: redactSensitive(job.answer).slice(0, 400), ...(job.agent ? { agent: job.agent } : {}),
    };
    const save = async (patch: Partial<FeedbackRule>): Promise<FeedbackRule> => {
      // A field set to undefined (an old reason) disappears from the file.
      const next = Object.fromEntries(Object.entries({ ...base, ...patch, updatedAt: now() }).filter(([, value]) => value !== undefined)) as FeedbackRule;
      await changeRules((rules) => rules.some((rule) => rule.id === next.id) ? rules.map((rule) => rule.id === next.id ? next : rule) : [...rules, next], path);
      return next;
    };
    if (vagueComment(comment)) return save({ status: "vague", reason: "Zu vage – sag konkret, was falsch war oder gefehlt hat." });
    if (!(deps.cloudReady ?? cloudReady)()) return save({ status: "pending", reason: "DeepSeek nicht erreichbar – später erneut prüfen." });
    await save({ status: "checking" });
    try {
      const { proposal, use } = await (deps.propose ?? ((request: RuleRequest) => proposeRule(request)))({ ...job, comment });
      if (!proposal.usable) return save({ status: "unusable", reason: proposal.reason.slice(0, 200) });
      const rule = { rule: proposal.rule, scope: proposal.scope, target: proposal.target };
      const active = activeRules((await readRules(path)).filter((item) => item.id !== base.id));
      if (active.some((item) => sameRule(item.text, proposal.rule))) return save({ ...rule, status: "unusable", reason: "Diese Regel gibt es schon." });
      if (active.length >= MAX_ACTIVE_RULES)
        return save({ ...rule, status: "rejected", reason: `Schon ${MAX_ACTIVE_RULES} aktive Regeln – erst eine deaktivieren.` });
      const evaluate = deps.evaluate ?? goldEvaluator(path);
      const baseline = await evaluate(active);
      const candidate = await evaluate([...active, { text: proposal.rule, scope: proposal.scope, target: proposal.target }]);
      // Equal or better, and no new safety failure; otherwise the rule stays off.
      const passed = candidate.passed >= baseline.passed && candidate.hard <= baseline.hard;
      const score = (value: RuleScore) => ({ passed: value.passed, total: value.total, hard: value.hard });
      const worse = (candidate.failed ?? []).filter((label) => !(baseline.failed ?? []).includes(label)).slice(0, 5).map((label) => label.slice(0, 120));
      return save({ ...rule, status: passed ? "active" : "rejected",
        check: { at: now(), model: `${candidate.model} (Regel: ${use.model})`.slice(0, 80), passed, baseline: score(baseline), candidate: score(candidate),
          ...(worse.length ? { worse } : {}) },
        reason: passed ? undefined : `Gold-Eval mit Regel schlechter: ${candidate.passed}/${candidate.total} statt ${baseline.passed}/${baseline.total}` +
          `${candidate.hard > baseline.hard ? ", Sicherheitsfehler" : ""}.` });
    } catch (error) {
      if (error instanceof AiUnavailableError) return save({ status: "pending", reason: "DeepSeek nicht verfügbar – später erneut prüfen." });
      console.error("Assistant rule check failed:", error instanceof Error ? error.name : "Error");
      return save({ status: "error", reason: "Prüfung fehlgeschlagen – später erneut prüfen." });
    }
  });
}

/** The admin's switch: an active rule can be turned off; a turned-off rule comes back only if its eval had passed. */
export async function setRuleActive(id: string, active: boolean, path = rulesFilePath(), now = new Date()): Promise<FeedbackRule | undefined> {
  let result: FeedbackRule | undefined;
  await changeRules((rules) => {
    const count = rules.filter((rule) => rule.status === "active").length;
    return rules.map((rule) => {
      if (rule.id !== id) return rule;
      if (active ? rule.status !== "disabled" || !rule.check?.passed || count >= MAX_ACTIVE_RULES : rule.status !== "active") return rule;
      result = { ...rule, status: active ? "active" : "disabled", updatedAt: now.toISOString() };
      return result;
    });
  }, path);
  return result;
}
