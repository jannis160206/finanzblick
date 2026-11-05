import { z } from "zod";
import { lookupIndustry } from "@/lib/ai/industry";
import { handleAiPost } from "@/lib/ai/route-support";

export const runtime = "nodejs";

const requestSchema = z.object({
  names: z.array(z.string().trim().min(2).max(90)).min(1).max(12),
}).strict();

// Industry of unknown shops from Wikidata or the shop's own website; one batch at a time.
export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "industry", requestSchema, 4 * 1024, async (input, signal) => {
    const results: { name: string; category?: string; label?: string; source?: string }[] = [];
    for (const name of [...new Set(input.names)]) {
      if (signal.aborted) break;
      const industry = await lookupIndustry(name, { signal });
      results.push(industry ? { name, ...industry } : { name });
    }
    return { results };
  });
}
