import { z } from "zod";
import { handleAiPost } from "@/lib/ai/route-support";
import { searchWeb } from "@/lib/web/search";

export const runtime = "nodejs";

const requestSchema = z.object({
  question: z.string().trim().min(2).max(500),
  // Sources the user rejected earlier for this kind of question; they are skipped.
  avoid: z.array(z.string().trim().min(3).max(500)).max(10).optional(),
  // A question about a current value: quotes and news come from live sources, prices, rates and tax figures are searched as current.
  current: z.enum(["quote", "news", "price", "rate", "tax"]).optional(),
}).strict();

// Automatic web search of the finance assistant: search words only, up to three short public sources to compare.
export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "web-search", requestSchema, 8 * 1024, (input, signal) => searchWeb(input.question, { signal, avoid: input.avoid, current: input.current }));
}
