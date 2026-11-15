import { agentDef, CHANGE_TOOL, subagentForTool, type AgentLimits, type LlmAgentKey, type SubagentKey } from "./registry";

/**
 * The agent runtime as it runs in the browser (the harness): the orchestrator's loop, the specialists' loops it starts through
 * tool calls – at the same time when they do not depend on each other – and the limits of every agent (steps, tool calls, time).
 * Each step is one call to the server (`step`), which asks the model; tools run here on the user's data (`execute`). A change
 * ends the run: it goes to the change workflow, which shows a preview and asks first. Pure, so it is tested without a browser.
 */

export type RuntimeCall = { id: string; name: string; arguments: string };
export type RuntimeTurn = { calls: RuntimeCall[]; results: { id: string; content: string }[] };
/** `question`: the user's own message, which a specialist reads next to its task for context. */
export type StepRequest = { agent: LlmAgentKey; message: string; question?: string; turns: RuntimeTurn[]; final: boolean };
/** `limits`: the agent's live limits from the agent repo, sent with every step. */
export type StepResult = { calls: RuntimeCall[]; text?: string; limits?: AgentLimits };
export type ToolResult = { ok: boolean; content: string };

export type RuntimeEvent =
  | { type: "step"; agent: LlmAgentKey; index: number; final: boolean }
  | { type: "delegate"; agent: SubagentKey; task: string }
  | { type: "tool"; agent: SubagentKey; tool: string; input: string }
  | { type: "tool-done"; agent: SubagentKey; tool: string; input: string; ok: boolean; result: string }
  | { type: "finding"; agent: SubagentKey; task: string; ok: boolean; text: string }
  | { type: "limit"; agent: LlmAgentKey; reason: "steps" | "tools" };

export type RuntimeDeps = {
  step: (request: StepRequest, signal: AbortSignal) => Promise<StepResult>;
  execute: (agent: SubagentKey, tool: string, input: string, signal: AbortSignal) => Promise<ToolResult>;
  emit?: (event: RuntimeEvent) => void;
  signal: AbortSignal;
};

export type RunOutcome = { kind: "answer"; text?: string } | { kind: "change"; task: string };

/** The one string argument of a call ("frage", "suche", "aufgabe", "auftrag"); a broken argument becomes empty. */
export function callInput(call: RuntimeCall): string {
  try {
    const value: unknown = JSON.parse(call.arguments || "{}");
    if (typeof value === "string") return value.trim();
    if (value && typeof value === "object") {
      const text = Object.values(value).find((item): item is string => typeof item === "string" && !!item.trim());
      return text?.trim().slice(0, 1000) ?? "";
    }
  } catch {
    // Some models send the plain text instead of JSON.
    return call.arguments.trim().slice(0, 1000);
  }
  return "";
}

/** A deadline that the live limits may move: the first step answers with the agent's configured timeout. */
function deadline(parent: AbortSignal, ms: number) {
  const controller = new AbortController();
  const started = Date.now();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  let timer = setTimeout(() => controller.abort(new DOMException("Zeitlimit erreicht", "TimeoutError")), ms);
  return {
    signal: controller.signal,
    set(next: number) {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new DOMException("Zeitlimit erreicht", "TimeoutError")), Math.max(0, next - (Date.now() - started)));
    },
    stop() {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}

const defaults = (agent: LlmAgentKey): AgentLimits => agentDef(agent).config!;

/**
 * One agent's loop: a step, its tool calls, the results back, until the agent answers in words or a limit forces the words.
 * `run` handles one call; a call that is not allowed or fails comes back as text, so the model can react.
 */
async function loop(agent: LlmAgentKey, message: string, deps: RuntimeDeps,
  run: (call: RuntimeCall, signal: AbortSignal) => Promise<string | { stop: RunOutcome }>, question?: string): Promise<RunOutcome> {
  let limits = defaults(agent);
  const time = deadline(deps.signal, limits.timeoutMs);
  const turns: RuntimeTurn[] = [];
  let used = 0;
  try {
    for (let index = 0; ; index += 1) {
      const final = index >= limits.maxSteps - 1 || used >= limits.maxToolCalls;
      if (final && index > 0) deps.emit?.({ type: "limit", agent, reason: used >= limits.maxToolCalls ? "tools" : "steps" });
      deps.emit?.({ type: "step", agent, index, final });
      const result = await deps.step({ agent, message, ...(question ? { question } : {}), turns, final }, time.signal);
      if (result.limits) {
        limits = result.limits;
        if (index === 0) time.set(limits.timeoutMs);
      }
      if (!result.calls.length || final) return { kind: "answer", text: result.text };
      const calls = result.calls.slice(0, Math.max(1, limits.maxToolCalls - used));
      used += calls.length;
      const results = await Promise.all(calls.map(async (call) => ({ call, outcome: await run(call, time.signal) })));
      const stop = results.find((item): item is { call: RuntimeCall; outcome: { stop: RunOutcome } } => typeof item.outcome !== "string");
      if (stop) return stop.outcome.stop;
      turns.push({ calls, results: results.map(({ call, outcome }) => ({ id: call.id, content: outcome as string })) });
    }
  } finally {
    time.stop();
  }
}

/** A specialist: its tools in a loop, then its findings for the orchestrator. A failure becomes an honest finding. */
export async function runSubagent(agent: SubagentKey, task: string, deps: RuntimeDeps, question?: string): Promise<{ ok: boolean; text: string }> {
  try {
    const outcome = await loop(agent, task, deps, async (call, signal) => {
      const input = callInput(call);
      deps.emit?.({ type: "tool", agent, tool: call.name, input });
      const result = await deps.execute(agent, call.name, input, signal).catch((): ToolResult => ({ ok: false, content: "Das Werkzeug ist fehlgeschlagen." }));
      deps.emit?.({ type: "tool-done", agent, tool: call.name, input, ok: result.ok, result: result.content });
      return result.content || "Keine Daten.";
    }, question);
    const text = outcome.kind === "answer" ? outcome.text?.trim() ?? "" : "";
    return text ? { ok: true, text } : { ok: false, text: "Der Spezialist hat nichts zurückgegeben." };
  } catch (error) {
    if (deps.signal.aborted) throw error;
    return { ok: false, text: "Der Spezialist hat nicht rechtzeitig geantwortet." };
  }
}

/**
 * The orchestrator: delegates to the specialists through its tools, runs them (at the same time when it called several in one
 * step) and writes the answer from their findings. A call of the change workflow ends the run with the user's request.
 */
export function runOrchestrator(message: string, deps: RuntimeDeps): Promise<RunOutcome> {
  return loop("orchestrator", message, deps, async (call, signal) => {
    if (call.name === CHANGE_TOOL) return { stop: { kind: "change", task: callInput(call) || message } };
    const agent = subagentForTool(call.name);
    if (!agent) return "Dieses Werkzeug gibt es nicht.";
    const task = callInput(call) || message;
    deps.emit?.({ type: "delegate", agent, task });
    const finding = await runSubagent(agent, task, { ...deps, signal }, message);
    deps.emit?.({ type: "finding", agent, task, ok: finding.ok, text: finding.text });
    return finding.text;
  });
}
