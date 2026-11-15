import { agentStep, agentStepSchema, runAgentStep } from "@/lib/ai/agent-step";
import { handleAiPost, handleAiStream } from "@/lib/ai/route-support";
import { activeRepo } from "@/lib/server/agent-repo-store";
import { promptRules } from "@/lib/server/rules-store";

export const runtime = "nodejs";

/**
 * One step of an agent of the runtime (orchestrator or specialist): `?stream=1` sends NDJSON lines ({"prompt"}, {"model"},
 * {"delta"}/{"replace"}, then {"calls"} or {"done","ok","text"}); without it the step comes as one JSON object. Prompts, models,
 * limits, tool descriptions and knowledge come from the agent repo, so a save applies to the next run.
 */
export async function POST(request: Request): Promise<Response> {
  // Specialists of one run work at the same time; each agent has its own lane.
  const lane = (await request.clone().json().catch(() => ({})) as { agent?: unknown }).agent;
  const kind = `agent:${typeof lane === "string" ? lane.slice(0, 20) : "?"}`;
  if (new URL(request.url).searchParams.get("stream") === "1")
    return handleAiStream(request, kind, agentStepSchema, 160 * 1024, async function* (input, signal) {
      yield* runAgentStep(input, { signal, repo: await activeRepo(), rules: await promptRules() });
    });
  return handleAiPost(request, kind, agentStepSchema, 160 * 1024, async (input, signal) =>
    agentStep(input, { signal, repo: await activeRepo(), rules: await promptRules() }));
}
