import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { promptText, type PromptOverrides } from "@/lib/ai/agent-prompts";
import { AiUnavailableError, cloudPause } from "@/lib/ai/client";
import { readAiConfig } from "@/lib/ai/config";
import { diagnoseFeedback, judgeReplay, replayFeedback, type Attempt, type Diagnosis, type ReviewRequest, type Verdict } from "@/lib/ai/feedback-review";
import { fileResponseCache } from "@/lib/ai/response-cache";
import { redactSensitive, type StoredFeedback } from "@/lib/assistant/feedback";
import {
  activeRules, applyEdit, MAX_ACTIVE_RULES, promptAgent, revertEdit, vagueComment, type FeedbackRule, type PromptEdit, type RuleScore, type RuleText,
} from "@/lib/assistant/feedback-rules";
import { runGold } from "@/lib/assistant/gold-eval";
import { agentIds, type AgentId } from "@/lib/assistant/orchestrator";
import { agentPromptsPath, readPromptOverrides, savePrompt } from "./agent-prompts-store";
import { changeRules, readRules, rulesFilePath } from "./rules-store";

/**
 * The review agent's loop: every 👍/👎 is kept with the feedback, and a 👎 with a concrete comment is reviewed in the background.
 * DeepSeek V4 Pro finds the prompt that caused the answer and changes it by one sentence; the question is asked again with the
 * changed prompt and judged demand by demand (with one improved second attempt), and the gold eval runs with the prompts in use,
 * without and with the change. Only a change that
 * fixes the complaint and keeps the eval at least as good (no new safety failure) is written into the agent's prompt – it applies
 * from the next question on. Vague comments and unusable proposals are recorded, never applied. One review at a time.
 */

export type RuleLoopDeps = {
  path?: string;
  /** The prompts file the change goes into. */
  promptsPath?: string;
  cloudReady?: () => boolean;
  diagnose?: (request: ReviewRequest, prompts: PromptOverrides, previous?: Attempt) => Promise<{ diagnosis: Diagnosis }>;
  replay?: (request: ReviewRequest, edit: PromptEdit, prompts: PromptOverrides, rules: readonly RuleText[]) => Promise<string>;
  verify?: (request: ReviewRequest, edit: PromptEdit, replay: string) => Promise<Verdict>;
  evaluate?: (rules: readonly RuleText[], prompts: PromptOverrides) => Promise<RuleScore & { model: string; failed?: string[] }>;
  now?: () => Date;
};

export type RuleJob = ReviewRequest & { feedbackId: string };

const isAgent = (value: string): value is AgentId => (agentIds as readonly string[]).includes(value);

/** The review request in a stored 👎 with comment, with the conversation, the path and the card's figures; nothing for a 👍. */
export function ruleJob(entry: StoredFeedback): RuleJob | undefined {
  const comment = entry.comment?.trim();
  if (entry.rating !== "dislike" || !comment) return undefined;
  const facts: Record<string, string | number> = {};
  for (const line of entry.answer.card?.lines ?? []) {
    const value = line.value ?? line.detail;
    if (value !== undefined) facts[line.label] = value;
  }
  return { feedbackId: entry.id, comment, question: entry.question ?? "", answer: entry.answer.text,
    ...(isAgent(entry.answer.agent.id) ? { agent: entry.answer.agent.id } : {}),
    ...(entry.context.length ? { history: entry.context.map(({ role, text }) => ({ role, text })) } : {}),
    ...(entry.answer.via ? { via: entry.answer.via } : {}), ...(entry.answer.tool ? { tool: entry.answer.tool } : {}),
    ...(entry.answer.calls?.length ? { calls: entry.answer.calls.map((call) => `${call.tool}${call.ok ? "" : " (Fehler)"}`) } : {}),
    ...(Object.keys(facts).length ? { facts } : {}) };
}

/** Whether the loop runs at all: only with DeepSeek set up (review, replay and eval run there). */
export const ruleLoopEnabled = () => !!readAiConfig().cloud;
const cloudReady = () => !!readAiConfig().cloud && !cloudPause();

// The gold questions plus the answer cases on DeepSeek's fast model, four at a time; unchanged prompts come from the cache.
function goldEvaluator(path: string) {
  const cache = fileResponseCache(join(dirname(path), "ai-cache", "rule-eval"));
  return async (rules: readonly RuleText[], prompts: PromptOverrides) => {
    const score = await runGold({ rules, prompts, answers: true, concurrency: 4, chat: { tier: "fast", cloudOnly: true, cache } });
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
 * Reviews one 👎 comment. A comment that was already handled is not reviewed again unless `force` (the admin's "Erneut prüfen").
 * Returns the entry as stored.
 */
export function reviewFeedback(job: RuleJob, deps: RuleLoopDeps = {}, force = false): Promise<FeedbackRule> {
  const path = deps.path ?? rulesFilePath();
  const promptsPath = deps.promptsPath ?? agentPromptsPath();
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
      const request = { ...job, comment };
      const prompts = await readPromptOverrides(promptsPath);
      const diagnose = deps.diagnose ?? ((input: ReviewRequest, current: PromptOverrides, previous?: Attempt) => diagnoseFeedback(input, current, previous));
      const others = (await readRules(path)).filter((item) => item.id !== base.id);
      const rules = activeRules(others);
      // The review agent's own retest: the same question with the changed prompt. A first proposal that falls short gets one second try.
      let tried: (Attempt & { verdict: Verdict; next: PromptOverrides }) | undefined;
      for (let round = 0; round < 2 && !tried?.verdict.fixed; round += 1) {
        const { diagnosis } = await diagnose(request, prompts, tried && { edit: tried.edit, replay: tried.replay, note: tried.verdict.note });
        if (!diagnosis.usable) {
          if (!tried) return save({ status: "unusable", reason: diagnosis.reason.slice(0, 200) });
          break;
        }
        const next: PromptOverrides = { ...prompts, [diagnosis.edit.id]: applyEdit(promptText(diagnosis.edit.id, prompts), diagnosis.edit) };
        const replay = await (deps.replay ?? replayFeedback)(request, diagnosis.edit, next, rules);
        const verdict = await (deps.verify ?? ((input: ReviewRequest, change: PromptEdit, result: string) => judgeReplay(input, change, result)))(request, diagnosis.edit, replay);
        tried = { edit: diagnosis.edit, replay, note: verdict.note, verdict, next };
      }
      if (!tried) return save({ status: "unusable", reason: "Keine Änderung gefunden." });
      const { edit, next, verdict } = tried;
      const agent = promptAgent(edit.id);
      const shown: Partial<FeedbackRule> = { kind: "prompt", prompt: edit, rule: edit.after, scope: agent ?? "all",
        target: edit.id === "supervisor" || edit.id.startsWith("tools.") ? "routing" : "answer" };
      const review = { fixed: verdict.fixed, note: verdict.note.slice(0, 200), replay: tried.replay.slice(0, 400) };
      if (!verdict.fixed) return save({ ...shown, review, status: "rejected", reason: `Nachtest: ${verdict.note}`.slice(0, 200) });
      if (others.filter((item) => item.status === "active").length >= MAX_ACTIVE_RULES)
        return save({ ...shown, review, status: "rejected", reason: `Schon ${MAX_ACTIVE_RULES} aktive Änderungen – erst eine zurücknehmen.` });
      const evaluate = deps.evaluate ?? goldEvaluator(path);
      const baseline = await evaluate(rules, prompts);
      const candidate = await evaluate(rules, next);
      // Equal or better, and no new safety failure; otherwise the prompt stays as it is.
      const passed = candidate.passed >= baseline.passed && candidate.hard <= baseline.hard;
      const score = (value: RuleScore) => ({ passed: value.passed, total: value.total, hard: value.hard });
      const worse = (candidate.failed ?? []).filter((label) => !(baseline.failed ?? []).includes(label)).slice(0, 5).map((label) => label.slice(0, 120));
      const check = { at: now(), model: `${candidate.model} (Prüfung: DeepSeek V4 Pro)`.slice(0, 80), passed, baseline: score(baseline), candidate: score(candidate),
        ...(worse.length ? { worse } : {}) };
      if (!passed) return save({ ...shown, review, check, status: "rejected", reason: `Gold-Eval mit Änderung schlechter: ${candidate.passed}/${candidate.total} ` +
        `statt ${baseline.passed}/${baseline.total}${candidate.hard > baseline.hard ? ", Sicherheitsfehler" : ""}.` });
      // The prompt may have been edited while the checks ran: the change goes onto its current text.
      const current = promptText(edit.id, await readPromptOverrides(promptsPath));
      const changed = current.includes(edit.after) ? current : applyEdit(current, edit);
      if (!changed) return save({ ...shown, review, check, status: "rejected", reason: "Der Prompt wurde inzwischen geändert – bitte erneut prüfen." });
      await savePrompt(edit.id, changed, promptsPath);
      return save({ ...shown, review, check, status: "active", appliedAt: now() });
    } catch (error) {
      if (error instanceof AiUnavailableError) return save({ status: "pending", reason: "DeepSeek nicht verfügbar – später erneut prüfen." });
      console.error("Assistant feedback review failed:", error instanceof Error ? error.name : "Error");
      return save({ status: "error", reason: "Prüfung fehlgeschlagen – später erneut prüfen." });
    }
  });
}

/**
 * The admin's switch. A prompt change is taken out of its prompt again (or put back in); an older rule is switched off or on.
 * Only a change whose checks had passed comes back, and at most twelve are live.
 */
export async function setRuleActive(id: string, active: boolean, path = rulesFilePath(), now = new Date(), promptsPath = agentPromptsPath()): Promise<FeedbackRule | undefined> {
  const rules = await readRules(path);
  const rule = rules.find((item) => item.id === id);
  const live = rules.filter((item) => item.status === "active").length;
  if (!rule || (active ? rule.status !== "disabled" || !rule.check?.passed || live >= MAX_ACTIVE_RULES : rule.status !== "active")) return undefined;
  if (rule.kind === "prompt" && rule.prompt) {
    const text = promptText(rule.prompt.id, await readPromptOverrides(promptsPath));
    const changed = active ? text.includes(rule.prompt.after) ? text : applyEdit(text, rule.prompt) : revertEdit(text, rule.prompt);
    // The sentence it replaced is gone: it cannot come back. Taken out by hand already: it is only marked.
    if (active && !changed) return undefined;
    if (changed && changed !== text) await savePrompt(rule.prompt.id, changed, promptsPath);
  }
  const at = now.toISOString();
  const result: FeedbackRule = { ...rule, status: active ? "active" : "disabled", updatedAt: at, ...(active ? { appliedAt: at } : {}) };
  await changeRules((list) => list.map((item) => item.id === id ? result : item), path);
  return result;
}
