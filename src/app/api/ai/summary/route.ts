import { summaryFactsSchema, writeMonthlySummary } from "@/lib/ai/summary";
import { handleAiPost } from "@/lib/ai/route-support";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "summary", summaryFactsSchema, 16 * 1024, (facts, signal) => writeMonthlySummary(facts, { signal }));
}
