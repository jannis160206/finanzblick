import { z } from "zod";
import { handleAiPost } from "@/lib/ai/route-support";
import { searchKnowledge } from "@/lib/knowledge-base/search";

export const runtime = "nodejs";

const requestSchema = z.object({ question: z.string().trim().min(2).max(500) });

// Local finance knowledge for the assistant: hybrid search over the curated chunks, at most three short hits.
export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "knowledge", requestSchema, 4 * 1024, (input, signal) => searchKnowledge(input.question, { signal }));
}