import { z } from "zod";
import { lookupIndustryResult } from "@/lib/ai/industry";
import { handleAiPost } from "@/lib/ai/route-support";

export const runtime = "nodejs";

const requestSchema = z.object({
  targets: z.array(z.object({
    key: z.string().trim().min(1).max(160),
    name: z.string().trim().min(2).max(90),
    city: z.string().trim().max(60).optional(),
    postcode: z.string().regex(/^\d{4,5}$/).optional(),
  }).strict()).min(1).max(8),
}).strict();

// What the internet says unknown shops are: OpenStreetMap shop type, Wikidata, the shop's own website.
// Lookups that could not be answered (rate limit, timeout) are left out so they are retried later.
export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "web-categories", requestSchema, 8 * 1024, async (input, signal) => {
    const results: { key: string; industry?: Awaited<ReturnType<typeof lookupIndustryResult>>["industry"] }[] = [];
    for (const target of input.targets) {
      if (signal.aborted) break;
      const place = target.city || target.postcode ? { city: target.city, postcode: target.postcode } : undefined;
      const { industry, failed } = await lookupIndustryResult(target.name, { signal, place });
      if (!failed) results.push(industry ? { key: target.key, industry } : { key: target.key });
    }
    return { results };
  });
}
