import { feedbackEntrySchema, feedbackSummary, redactEntry, type StoredFeedback } from "@/lib/assistant/feedback";
import { readAiConfig } from "@/lib/ai/config";
import { isAccountMode } from "@/lib/server/config";
import { AccountError } from "@/lib/server/errors";
import { FeedbackFileError, feedbackDisplayPath, feedbackDocument, feedbackFilePath, readFeedback, recordFeedback } from "@/lib/server/feedback-store";
import { accountErrorResponse, jsonResponse, readJsonBody, requestSessionToken, requireMutationOrigin } from "@/lib/server/http";
import { getAccountRuntime } from "@/lib/server/runtime";

export const runtime = "nodejs";

function failed(error: unknown): Response {
  if (!(error instanceof FeedbackFileError)) return accountErrorResponse(error);
  console.error("Assistant feedback file is damaged; it was left untouched.");
  return jsonResponse({ error: "Die Feedback-Datei ist beschädigt und wird nicht überschrieben. Bitte die Datei prüfen." }, 500);
}

// Without accounts (local development) everyone may read and write; with accounts signed-in users write and only the admin reads.
async function caller(request: Request, write: boolean) {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") throw new AccountError(403, "Diese Anfrage ist nicht erlaubt.");
  if (!isAccountMode()) return undefined;
  const { config, database } = await getAccountRuntime();
  const user = database.currentUser(requestSessionToken(request));
  if (!user) throw new AccountError(401, "Bitte anmelden.");
  if (write) {
    requireMutationOrigin(request, config);
    database.consumeRateLimit(`assistant-feedback:${user.id}`, 60, 60_000);
  } else if (user.role !== "admin") throw new AccountError(403, "Die Feedback-Datei kann nur der Administrator ansehen.");
  return user;
}

/** 👍/👎 with optional comment on an assistant answer: redacted and added to the single feedback file. */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await caller(request, true);
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
    return jsonResponse({ stored: true, count: await recordFeedback(stored) });
  } catch (error) {
    return failed(error);
  }
}

/** `?download=1` downloads the whole file; otherwise where it lies, the counts and the latest entries. */
export async function GET(request: Request): Promise<Response> {
  try {
    await caller(request, false);
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
