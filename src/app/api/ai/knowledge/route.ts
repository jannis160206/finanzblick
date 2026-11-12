import { z } from "zod";
import { handleAiPost } from "@/lib/ai/route-support";
import { searchKnowledge } from "@/lib/knowledge-base/search";

export const runtime = "nodejs";

const requestSchema = z.object({
  question: z.string().trim().min(2).max(500),
  // Answers the user confirmed earlier; searched together with the curated knowledge, never stored on the server.
  learned: z.array(z.object({
    id: z.string().min(1).max(100), question: z.string().trim().min(1).max(300), text: z.string().trim().min(1).max(600),
    votes: z.number().int().min(-50).max(1000), uses: z.number().int().min(0).max(100_000),
  }).strict()).max(30).optional(),
});

// Local finance knowledge for the assistant: hybrid search over the curated chunks and the confirmed answers, at most three short hits.
export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "knowledge", requestSchema, 32 * 1024, (input, signal) => searchKnowledge(input.question, { signal, learned: input.learned }));
}