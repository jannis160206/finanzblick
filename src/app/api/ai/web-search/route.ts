import { z } from "zod";
import { handleAiPost } from "@/lib/ai/route-support";
import { searchWeb } from "@/lib/web/search";

export const runtime = "nodejs";

const requestSchema = z.object({
  question: z.string().trim().min(2).max(500),
  // Sources the user rejected earlier for this kind of question; they are skipped.
  avoid: z.array(z.string().trim().min(3).max(500)).max(10).optional(),
}).strict();

// Automatic web search of the finance assistant: search words only, up to three short public sources to compare.
export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "web-search", requestSchema, 8 * 1024, (input, signal) => searchWeb(input.question, { signal, avoid: input.avoid }));
}
