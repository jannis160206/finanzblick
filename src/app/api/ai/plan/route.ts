import { planLookups, planRequestSchema } from "@/lib/ai/planner";
import { handleAiPost } from "@/lib/ai/route-support";

export const runtime = "nodejs";

// Which reading tools (app data or web) DeepSeek wants for a question no single tool answers; 503 without DeepSeek.
export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "plan", planRequestSchema, 16 * 1024, (input, signal) => planLookups(input, { signal }));
}
