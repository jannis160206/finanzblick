import { assistantRequestSchema, interpretAssistantMessage } from "@/lib/ai/assistant";
import { handleAiPost } from "@/lib/ai/route-support";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "assistant", assistantRequestSchema, 32 * 1024, (input, signal) => interpretAssistantMessage(input, { signal }));
}
