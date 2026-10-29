import { z } from "zod";
import { findMerchantLogo } from "@/lib/ai/logo-finder";
import { handleAiPost } from "@/lib/ai/route-support";

export const runtime = "nodejs";

const requestSchema = z.object({
  name: z.string().trim().min(2).max(90),
  context: z.string().trim().max(300).optional(),
}).strict();

export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "logo", requestSchema, 4 * 1024, (input, signal) =>
    findMerchantLogo(input.name, input.context, { signal }));
}
