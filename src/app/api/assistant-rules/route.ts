import { after } from "next/server";
import { z } from "zod";
import { statusLabel, votesSince, type FeedbackRule } from "@/lib/assistant/feedback-rules";
import { readAiConfig } from "@/lib/ai/config";
import { cloudPause } from "@/lib/ai/client";
import { assistantCaller } from "@/lib/server/assistant-access";
import { feedbackDisplayPath, readFeedback } from "@/lib/server/feedback-store";
import { accountErrorResponse, jsonResponse, readJsonBody } from "@/lib/server/http";
import { reviewFeedback, ruleJob, setRuleActive } from "@/lib/server/rule-loop";
import { readRules, RulesFileError, rulesFilePath } from "@/lib/server/rules-store";

export const runtime = "nodejs";

function failed(error: unknown): Response {
  if (!(error instanceof RulesFileError)) return accountErrorResponse(error);
  console.error("Assistant rules file is damaged; it was left untouched.");
  return jsonResponse({ error: "Die Regel-Datei ist beschädigt und wird nicht überschrieben. Bitte die Datei prüfen." }, 500);
}

const summary = (rules: FeedbackRule[]) => Object.fromEntries(Object.keys(statusLabel).map((status) => [status, rules.filter((rule) => rule.status === status).length]));

/** What the review agent learned from 👎 comments, newest first, with retest, eval and the votes since each change; admin only. */
export async function GET(request: Request): Promise<Response> {
  try {
    await assistantCaller(request, "admin");
    const path = rulesFilePath();
    const rules = await readRules(path);
    const cloud = readAiConfig().cloud;
    const votes = await readFeedback().catch(() => []);
    return jsonResponse({
      file: feedbackDisplayPath(path),
      loop: cloud ? cloudPause() ? `DeepSeek pausiert (${cloudPause()})` : "bereit" : "aus (kein DeepSeek-Key)",
      count: summary(rules),
      rules: [...rules].reverse().slice(0, 50).map((rule) => {
        const since = votesSince(rule, votes);
        return since ? { ...rule, votes: since } : rule;
      }),
    });
  } catch (error) {
    return failed(error);
  }
}

const patchSchema = z.object({ id: z.string().min(8).max(100), action: z.enum(["enable", "disable", "recheck"]) }).strict();

/** Takes a change back or applies it again (only if its checks had passed), or reviews a waiting or failed one again; admin only. */
export async function PATCH(request: Request): Promise<Response> {
  try {
    await assistantCaller(request, "admin-write", "assistant-rules");
    const parsed = patchSchema.safeParse(await readJsonBody(request, 4 * 1024));
    if (!parsed.success) return jsonResponse({ error: "Ungültige Anfrage." }, 400);
    const { id, action } = parsed.data;
    if (action !== "recheck") {
      const rule = await setRuleActive(id, action === "enable");
      return rule ? jsonResponse({ rule }) : jsonResponse({ error: action === "enable"
        ? "Nur eine zurückgenommene Änderung mit bestandener Prüfung lässt sich wieder anwenden (höchstens 12 aktive)." : "Die Änderung ist nicht aktiv." }, 409);
    }
    const rule = (await readRules()).find((item) => item.id === id);
    if (!rule || rule.status === "checking" || rule.status === "active") return jsonResponse({ error: "Diese Regel lässt sich gerade nicht neu prüfen." }, 409);
    if (!readAiConfig().cloud) return jsonResponse({ error: "Ohne DeepSeek-Key lässt sich nichts prüfen." }, 409);
    // The full feedback entry carries the conversation and the path; without it, what the rules file kept.
    const entry = (await readFeedback().catch(() => [])).find((item) => item.id === rule.feedbackId);
    const job = (entry && ruleJob(entry)) ?? { feedbackId: rule.feedbackId, comment: rule.comment, question: rule.question, answer: rule.answer,
      ...(rule.agent ? { agent: rule.agent } : {}) };
    const run = () => reviewFeedback(job, {}, true).catch(() => undefined);
    try {
      after(run);
    } catch {
      void run();
    }
    return jsonResponse({ rule: { ...rule, status: "checking" } }, 202);
  } catch (error) {
    return failed(error);
  }
}
