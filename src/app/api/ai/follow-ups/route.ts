import { followUpRequestSchema, suggestFollowUps } from "@/lib/ai/follow-ups";
import { handleAiPost } from "@/lib/ai/route-support";

export const runtime = "nodejs";

// Follow-up questions for the latest answer, from DeepSeek only; 503 when it is unavailable, so the chat keeps its fixed ones.
export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "follow-ups", followUpRequestSchema, 16 * 1024, (input, signal) => suggestFollowUps(input, { signal }));
}
