import { dirname, join } from "node:path";
import { readAiConfig } from "@/lib/ai/config";
import { fileResponseCache } from "@/lib/ai/response-cache";
import type { RuleText } from "@/lib/assistant/feedback-rules";
import { goldTotal, runGold, type CaseResult } from "@/lib/assistant/gold-eval";
import { activeRepo, type RepoLive } from "./agent-repo-store";
import { evalsFilePath, newEvalId, saveEval, type EvalRun } from "./evals-store";
import { promptRules, rulesFilePath } from "./rules-store";

/**
 * Runs the gold eval on DeepSeek's fast model, four cases at a time, and logs it in the evals file: started from the admin view
 * or by the review agent for a change. Unchanged prompts come from the cache, so a repeated run costs little.
 */

export type EvalProgress = { id: string; trigger: string; done: number; total: number; startedAt: string };
const state = globalThis as typeof globalThis & { finanzblickEvalProgress?: EvalProgress };
/** The run in progress, for the admin view. */
export const evalProgress = (): EvalProgress | undefined => state.finanzblickEvalProgress;

export type GoldRun = EvalRun & { results: CaseResult[] };

export async function runGoldEval(trigger: string, options: { repo?: RepoLive; rules?: readonly RuleText[]; path?: string; track?: boolean } = {}): Promise<GoldRun> {
  const path = options.path ?? evalsFilePath();
  const cache = fileResponseCache(join(dirname(rulesFilePath()), "ai-cache", "rule-eval"));
  const startedAt = new Date().toISOString();
  const base: EvalRun = { id: newEvalId(), suite: "gold", trigger: trigger.slice(0, 80), status: "running", startedAt,
    model: readAiConfig().cloud?.models.fast ?? "deepseek" };
  const progress: EvalProgress = { id: base.id, trigger: base.trigger, done: 0, total: goldTotal(true), startedAt };
  if (options.track) state.finanzblickEvalProgress = progress;
  await saveEval(base, path).catch(() => undefined);
  const started = performance.now();
  try {
    const score = await runGold({ repo: options.repo ?? await activeRepo(), rules: options.rules ?? await promptRules(), answers: true, concurrency: 4,
      chat: { tier: "fast", cloudOnly: true, cache }, onResult: () => { progress.done += 1; } });
    const failed = score.results.filter((result) => !result.ok || result.hard).slice(0, 100)
      .map((result) => ({ group: result.group, label: result.label.slice(0, 200), ok: result.ok, hard: result.hard, got: result.got.slice(0, 240), ms: result.ms }));
    const run: EvalRun = { ...base, status: "done", finishedAt: new Date().toISOString(), score: { passed: score.passed, total: score.total, hard: score.hard },
      ...(failed.length ? { failed } : {}), ms: Math.round(performance.now() - started) };
    await saveEval(run, path).catch(() => undefined);
    return { ...run, results: score.results };
  } catch (error) {
    await saveEval({ ...base, status: "error", finishedAt: new Date().toISOString(), error: (error instanceof Error ? error.message : "Fehler").slice(0, 200) }, path)
      .catch(() => undefined);
    throw error;
  } finally {
    if (options.track && state.finanzblickEvalProgress?.id === base.id) state.finanzblickEvalProgress = undefined;
  }
}
