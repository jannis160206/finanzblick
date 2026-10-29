import { z } from "zod";
import { categorizeBookings } from "@/lib/ai/categorize";
import { aiBookingInputSchema, aiExampleSchema, MAX_AI_BATCH, MAX_AI_EXAMPLES } from "@/lib/ai/review-candidates";
import { handleAiPost } from "@/lib/ai/route-support";

export const runtime = "nodejs";

const requestSchema = z.object({
  bookings: z.array(aiBookingInputSchema).min(1).max(MAX_AI_BATCH),
  examples: z.array(aiExampleSchema).max(MAX_AI_EXAMPLES),
}).strict();

export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "categorize", requestSchema, 64 * 1024, async (input, signal) => ({
    results: await categorizeBookings(input.bookings, input.examples, { signal }),
  }));
}
