import { z } from "zod";
import { sweepMissingLogos } from "@/lib/ai/logo-sweep";
import { handleAiPost } from "@/lib/ai/route-support";
import { AutomationStore } from "@/lib/automation/store";
import { isAccountMode } from "@/lib/server/auth";
import { requestSessionToken } from "@/lib/server/http";
import { getAccountRuntime } from "@/lib/server/runtime";

export const runtime = "nodejs";

const requestSchema = z.object({ limit: z.number().int().min(1).max(10).optional() }).strict();

// Looks up logos for a few payees without one; the client calls it again while there are more.
export async function POST(request: Request): Promise<Response> {
  return handleAiPost(request, "logos", requestSchema, 1024, async (input, signal) => {
    if (!isAccountMode()) return { saved: [], checked: 0, remaining: 0, rateLimited: false };
    const { database } = await getAccountRuntime();
    const user = database.currentUser(requestSessionToken(request));
    const state = user ? database.getFinance(user.id).state : null;
    if (!user || !state) return { saved: [], checked: 0, remaining: 0, rateLimited: false };
    return sweepMissingLogos(new AutomationStore(database), user.id, state, { limit: input.limit, signal });
  });
}
