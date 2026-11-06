import { answerFreeQuestion, answerRequestSchema, streamFreeAnswer } from "@/lib/ai/answer";
import { handleAiPost, handleAiStream } from "@/lib/ai/route-support";

export const runtime = "nodejs";

// `?stream=1` sends NDJSON lines ({"delta"} … {"done","ok","text"}); without it the whole answer comes as one JSON object.
export async function POST(request: Request): Promise<Response> {
  if (new URL(request.url).searchParams.get("stream") === "1")
    return handleAiStream(request, "answer", answerRequestSchema, 64 * 1024, (input, signal) => streamFreeAnswer(input, { signal }));
  return handleAiPost(request, "answer", answerRequestSchema, 64 * 1024, (input, signal) => answerFreeQuestion(input, { signal }));
}
