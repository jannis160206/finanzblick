import { after } from "next/server";
import { z } from "zod";
import { cloudPause } from "@/lib/ai/client";
import { readAiConfig } from "@/lib/ai/config";
import { goldTotal } from "@/lib/assistant/gold-eval";
import { assistantCaller } from "@/lib/server/assistant-access";
import { evalProgress, runGoldEval } from "@/lib/server/eval-runner";
import { evalsFilePath, readEvals } from "@/lib/server/evals-store";
import { feedbackDisplayPath } from "@/lib/server/feedback-store";
import { accountErrorResponse, jsonResponse, readJsonBody } from "@/lib/server/http";

export const runtime = "nodejs";

const suites = () => [{ id: "gold", label: "Gold-Eval", cases: goldTotal(true),
  description: "80 feste Fragen (Spezialisten und Werkzeuge), grenzwertige Fragen, versteckte Anweisungen und 6 Antworten – über die Agent-Laufzeit, auf DeepSeek Flash." }];

/** The eval runs, newest first, and the run in progress; admin only. */
export async function GET(request: Request): Promise<Response> {
  try {
    await assistantCaller(request, "admin");
    const cloud = readAiConfig().cloud;
    return jsonResponse({
      file: feedbackDisplayPath(evalsFilePath()), suites: suites(), running: evalProgress() ?? null,
      ready: cloud ? cloudPause() ? `DeepSeek pausiert (${cloudPause()})` : "bereit" : "aus (kein DeepSeek-Key)",
      runs: (await readEvals()).reverse(),
    });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

const postSchema = z.object({ suite: z.literal("gold") }).strict();

/** Starts the gold eval in the background (one at a time); the list shows its progress. Admin only. */
export async function POST(request: Request): Promise<Response> {
  try {
    await assistantCaller(request, "admin-write", "assistant-evals");
    const parsed = postSchema.safeParse(await readJsonBody(request, 1024));
    if (!parsed.success) return jsonResponse({ error: "Ungültige Anfrage." }, 400);
    if (!readAiConfig().cloud || cloudPause()) return jsonResponse({ error: "Ohne erreichbares DeepSeek läuft keine Eval." }, 409);
    if (evalProgress()) return jsonResponse({ error: "Es läuft schon eine Eval." }, 409);
    const run = () => runGoldEval("Admin", { track: true }).catch(() => undefined);
    try {
      after(run);
    } catch {
      void run();
    }
    return jsonResponse({ started: true }, 202);
  } catch (error) {
    return accountErrorResponse(error);
  }
}
