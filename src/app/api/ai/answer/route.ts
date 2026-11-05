import { answerFreeQuestion, answerRequestSchema } from "@/lib/ai/answer";
import { handleAiPost } from "@/lib/ai/route-support";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "answer", answerRequestSchema, 64 * 1024, (input, signal) => answerFreeQuestion(input, { signal }));
}
