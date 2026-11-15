import { answerFreeQuestion, answerRequestSchema, streamFreeAnswer } from "@/lib/ai/answer";
import { handleAiPost, handleAiStream } from "@/lib/ai/route-support";
import { activePrompts } from "@/lib/server/agent-prompts-store";
import { promptRules } from "@/lib/server/rules-store";

export const runtime = "nodejs";

// `?stream=1` sends NDJSON lines ({"delta"} … {"done","ok","text"}); without it the whole answer comes as one JSON object.
// The answer prompt carries the rules learned from feedback that passed the gold eval and the admin's edited prompts.
export async function POST(request: Request): Promise<Response> {
  if (new URL(request.url).searchParams.get("stream") === "1")
    return handleAiStream(request, "answer", answerRequestSchema, 64 * 1024, async function* (input, signal) {
      yield* streamFreeAnswer(input, { signal, rules: await promptRules(), prompts: await activePrompts() });
    });
  return handleAiPost(request, "answer", answerRequestSchema, 64 * 1024, async (input, signal) => answerFreeQuestion(input, { signal, rules: await promptRules(), prompts: await activePrompts() }));
}
