import { assistantRequestSchema, interpretAssistantMessage } from "@/lib/ai/assistant";
import { handleAiPost } from "@/lib/ai/route-support";
import { activePrompts } from "@/lib/server/agent-prompts-store";
import { promptRules } from "@/lib/server/rules-store";

export const runtime = "nodejs";

// The orchestrator and specialist prompts carry the routing rules learned from feedback that passed the gold eval and the
// admin's edited prompts (config/agent-prompts.json); both take effect on the next request.
export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "assistant", assistantRequestSchema, 32 * 1024, async (input, signal) => interpretAssistantMessage(input, { signal, rules: await promptRules(), prompts: await activePrompts() }));
}
