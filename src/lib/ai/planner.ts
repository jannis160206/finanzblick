import { z } from "zod";
import { agentIds, agentLabel } from "@/lib/assistant/orchestrator";
import { toolDescriptions, type AssistantTool } from "@/lib/assistant/tools";
import { AiUnavailableError, chat, type ChatOptions } from "./client";
import type { ModelUse } from "./models";
import { cleanUntrusted, DATA_RULE } from "./untrusted";

/**
 * Free choice of what to look up: for a question no single tool answers, DeepSeek picks up to three reading tools (the
 * app's own data tools or the web) with a short sub-question each. The chat runs them and answers from all results.
 * Changing tools are never offered here; changes keep their preview and confirmation.
 */

export const lookupTools = [
  "query", "accounts", "amex", "budget", "briefing", "check", "coach", "forecast", "pulse", "month_review", "review", "security", "insights",
  "contracts", "payroll", "networth", "refunds", "shared", "orders", "funds", "whatif", "loan", "depot", "market", "knowledge", "tax", "why",
] as const satisfies readonly AssistantTool[];
export type LookupTool = (typeof lookupTools)[number] | "web";
export const MAX_LOOKUPS = 3;

export const planRequestSchema = z.object({
  question: z.string().trim().min(1).max(500),
  agent: z.enum(agentIds).optional(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(500) }).strict()).max(4).optional(),
}).strict();
export type PlanRequest = z.infer<typeof planRequestSchema>;
export type LookupStep = { tool: LookupTool; question: string };

const toolList = [...lookupTools.map((tool) => `${tool} = ${toolDescriptions[tool]}`),
  "web = aktuelle öffentliche Informationen aus dem Internet: Kurse (Bitcoin, Aktien, Gold), Preise, Nachrichten, Steuersätze und Grenzwerte des Jahres"].join("; ");

const prompt = "Du bist der Finanz-Assistent einer privaten Finanz-App in Österreich. Für deine Antwort hast du schon einen Überblick über alle Daten " +
  "des Nutzers: Konten, laufender Monat mit Budgets, Abos, Sparziele, Kontoprognose, Amex, Gehalt, Auffälliges und die letzten Buchungen. " +
  "Entscheide selbst, ob du für eine wirklich gute Antwort noch etwas nachschlagen willst, und wähle dafür bis zu drei Lese-Werkzeuge, " +
  "jeweils mit einer kurzen, konkreten Teilfrage auf Deutsch (Zeitraum, Kategorie, Händler oder Betrag aus der Nachricht übernehmen). " +
  "Kombiniere Werkzeuge, wenn die Frage mehrere Seiten hat. Für aktuelle öffentliche Werte nimm web. Ändern kannst du hier nichts. " +
  "Reicht der Überblick, gib eine leere Liste. " +
  `Werkzeuge: ${toolList}. ` +
  "Antworte nur mit JSON: {\"schritte\": [{\"werkzeug\": \"query\", \"frage\": \"…\"}]}. " + DATA_RULE;

const isLookup = (value: unknown): value is LookupTool => value === "web" || (lookupTools as readonly string[]).includes(value as string);

/** The model's steps, cleaned: known reading tools only, a short question each, no repeats, at most three. */
export function cleanPlan(raw: unknown): LookupStep[] {
  const list = raw && typeof raw === "object" ? (Array.isArray(raw) ? raw : Object.values(raw).find(Array.isArray) ?? []) : [];
  const steps: LookupStep[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const tool = entry.werkzeug ?? entry.tool;
    const question = typeof (entry.frage ?? entry.question) === "string" ? cleanUntrusted(String(entry.frage ?? entry.question), 200) : "";
    if (!isLookup(tool) || question.length < 3) continue;
    if (steps.some((step) => step.tool === tool && step.question === question)) continue;
    steps.push({ tool, question });
    if (steps.length === MAX_LOOKUPS) break;
  }
  return steps;
}

function parse(content: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** The lookups DeepSeek wants for this question; cloud only, without DeepSeek the chat answers as before. */
export async function planLookups(input: PlanRequest, options: ChatOptions = {}): Promise<{ steps: LookupStep[]; models: ModelUse[] }> {
  const reply = await chat([
    { role: "system", content: prompt },
    { role: "user", content: [
      input.agent ? `Zuständig: ${input.agent === "general" ? "Allgemeiner Chat" : agentLabel[input.agent]}` : "",
      input.history?.length ? `Verlauf:\n${input.history.map((item) => `${item.role === "user" ? "Ich" : "Assistent"}: ${cleanUntrusted(item.text, 300)}`).join("\n")}` : "",
      `Nachricht: ${cleanUntrusted(input.question, 500)}`,
    ].filter(Boolean).join("\n") },
  ], { task: "plan", cloudOnly: true, maxTokens: 220, temperature: 0, ...options });
  const parsed = parse(reply.content);
  if (parsed === undefined) throw new AiUnavailableError("Kein lesbarer Plan.");
  return { steps: cleanPlan(parsed), models: [reply.use] };
}
