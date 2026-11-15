import { after } from "next/server";
import { feedbackEntrySchema, feedbackSummary, redactEntry, type StoredFeedback } from "@/lib/assistant/feedback";
import { readAiConfig } from "@/lib/ai/config";
import { assistantCaller } from "@/lib/server/assistant-access";
import { FeedbackFileError, feedbackDisplayPath, feedbackDocument, feedbackFilePath, readFeedback, recordFeedback } from "@/lib/server/feedback-store";
import { accountErrorResponse, jsonResponse, readJsonBody } from "@/lib/server/http";
import { reviewFeedback, ruleJob, ruleLoopEnabled } from "@/lib/server/rule-loop";

export const runtime = "nodejs";

function failed(error: unknown): Response {
  if (!(error instanceof FeedbackFileError)) return accountErrorResponse(error);
  console.error("Assistant feedback file is damaged; it was left untouched.");
  return jsonResponse({ error: "Die Feedback-Datei ist beschädigt und wird nicht überschrieben. Bitte die Datei prüfen." }, 500);
}

// Background work after the response; outside a request (tests, scripts) it simply runs on its own.
function later(task: () => Promise<unknown>) {
  const run = () => task().catch(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}

/**
 * 👍/👎 with optional comment on an assistant answer: redacted and added to the single feedback file, where the review agent counts
 * it for the prompt changes that were live. A 👎 with a comment also starts the review agent in the background (prompt change,
 * retest, gold eval, written into the prompt only if it fixes the complaint and the eval is not worse).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await assistantCaller(request, "write");
    const parsed = feedbackEntrySchema.safeParse(await readJsonBody(request, 64 * 1024));
    if (!parsed.success) return jsonResponse({ error: "Ungültiges Feedback." }, 400);
    const entry = redactEntry(parsed.data);
    const ai = readAiConfig();
    const stored: StoredFeedback = {
      ...entry, summary: feedbackSummary(entry), recordedAt: new Date().toISOString(),
      ...(user ? { account: user.id } : {}),
      app: {
        ...(process.env.NODE_ENV ? { nodeEnv: process.env.NODE_ENV } : {}), aiEnabled: ai.enabled, ...(ai.enabled ? { model: ai.model } : {}),
        ...(ai.embeddingModel ? { embeddingModel: ai.embeddingModel } : {}),
        ...(ai.cloud ? { cloudModels: [...new Set(Object.values(ai.cloud.models))] } : {}),
        webSearch: !/^(?:off|false|0|aus|nein)$/i.test(process.env.FINANZBLICK_WEB_SEARCH?.trim() ?? ""),
      },
    };
    const count = await recordFeedback(stored);
    const job = ruleJob(stored);
    if (job && ruleLoopEnabled()) later(() => reviewFeedback(job));
    return jsonResponse({ stored: true, count, ...(job && ruleLoopEnabled() ? { learning: true } : {}) });
  } catch (error) {
    return failed(error);
  }
}

/** `?download=1` downloads the whole file; otherwise where it lies, the counts and the latest entries. */
export async function GET(request: Request): Promise<Response> {
  try {
    await assistantCaller(request, "admin");
    const path = feedbackFilePath();
    if (new URL(request.url).searchParams.get("download") === "1") {
      return new Response(`${JSON.stringify(await feedbackDocument(path), null, 2)}\n`, { headers: {
        "Content-Type": "application/json; charset=utf-8", "Content-Disposition": "attachment; filename=\"assistant-feedback.json\"",
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      } });
    }
    const entries = await readFeedback(path);
    return jsonResponse({
      file: feedbackDisplayPath(path),
      count: { total: entries.length, like: entries.filter((entry) => entry.rating === "like").length,
        dislike: entries.filter((entry) => entry.rating === "dislike").length, withComment: entries.filter((entry) => !!entry.comment).length },
      latest: entries.slice(-5).reverse().map((entry) => ({ id: entry.id, rating: entry.rating, summary: entry.summary, recordedAt: entry.updatedAt ?? entry.recordedAt })),
    });
  } catch (error) {
    return failed(error);
  }
}
