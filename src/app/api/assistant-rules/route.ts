import { after } from "next/server";
import { z } from "zod";
import { statusLabel, type FeedbackRule } from "@/lib/assistant/feedback-rules";
import { readAiConfig } from "@/lib/ai/config";
import { cloudPause } from "@/lib/ai/client";
import { assistantCaller } from "@/lib/server/assistant-access";
import { feedbackDisplayPath } from "@/lib/server/feedback-store";
import { accountErrorResponse, jsonResponse, readJsonBody } from "@/lib/server/http";
import { learnRule, setRuleActive } from "@/lib/server/rule-loop";
import { readRules, RulesFileError, rulesFilePath } from "@/lib/server/rules-store";

export const runtime = "nodejs";

function failed(error: unknown): Response {
  if (!(error instanceof RulesFileError)) return accountErrorResponse(error);
  console.error("Assistant rules file is damaged; it was left untouched.");
  return jsonResponse({ error: "Die Regel-Datei ist beschädigt und wird nicht überschrieben. Bitte die Datei prüfen." }, 500);
}

const summary = (rules: FeedbackRule[]) => Object.fromEntries(Object.keys(statusLabel).map((status) => [status, rules.filter((rule) => rule.status === status).length]));

/** The rules learned from 👎 comments, newest first, with their eval result; admin only. */
export async function GET(request: Request): Promise<Response> {
  try {
    await assistantCaller(request, "admin");
    const path = rulesFilePath();
    const rules = await readRules(path);
    const cloud = readAiConfig().cloud;
    return jsonResponse({
      file: feedbackDisplayPath(path),
      loop: cloud ? cloudPause() ? `DeepSeek pausiert (${cloudPause()})` : "bereit" : "aus (kein DeepSeek-Key)",
      count: summary(rules),
      rules: [...rules].reverse().slice(0, 50),
    });
  } catch (error) {
    return failed(error);
  }
}

const patchSchema = z.object({ id: z.string().min(8).max(100), action: z.enum(["enable", "disable", "recheck"]) }).strict();

/** Switches a rule off or on again (only if its eval had passed), or checks a waiting or failed one again; admin only. */
export async function PATCH(request: Request): Promise<Response> {
  try {
    await assistantCaller(request, "admin-write", "assistant-rules");
    const parsed = patchSchema.safeParse(await readJsonBody(request, 4 * 1024));
    if (!parsed.success) return jsonResponse({ error: "Ungültige Anfrage." }, 400);
    const { id, action } = parsed.data;
    if (action !== "recheck") {
      const rule = await setRuleActive(id, action === "enable");
      return rule ? jsonResponse({ rule }) : jsonResponse({ error: action === "enable"
        ? "Nur eine deaktivierte Regel mit bestandener Eval lässt sich wieder einschalten (höchstens 12 aktive)." : "Die Regel ist nicht aktiv." }, 409);
    }
    const rule = (await readRules()).find((item) => item.id === id);
    if (!rule || rule.status === "checking" || rule.status === "active") return jsonResponse({ error: "Diese Regel lässt sich gerade nicht neu prüfen." }, 409);
    if (!readAiConfig().cloud) return jsonResponse({ error: "Ohne DeepSeek-Key lässt sich keine Regel prüfen." }, 409);
    const job = { feedbackId: rule.feedbackId, comment: rule.comment, question: rule.question, answer: rule.answer, ...(rule.agent ? { agent: rule.agent } : {}) };
    const run = () => learnRule(job, {}, true).catch(() => undefined);
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
