import { z } from "zod";
import { assistantDraftSchema, dateSchema, type AssistantDraft } from "@/lib/types";
import { groundModelExtraction, mergeDraft, missingQuestion, parseAssistantMessage, type ModelExtraction } from "@/lib/assistant/intent";
import { normalizeMessage } from "@/lib/assistant/normalize";
import { assistantTools, detectTool, isAssistantTool, isDraftTool, matchName, toolDescriptions, type AssistantTool } from "@/lib/assistant/tools";
import { categories } from "@/lib/categories";
import { chat, type ChatOptions } from "./client";
import { cleanUntrusted, DATA_RULE } from "./untrusted";

export const assistantRequestSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  asOf: dateSchema,
  pending: assistantDraftSchema.optional(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(500) }).strict()).max(6).optional(),
  // Names the model may refer to; nothing else from the data leaves the browser.
  context: z.object({
    goals: z.array(z.string().max(80)).max(50),
    planned: z.array(z.string().max(100)).max(60),
  }).strict().optional(),
}).strict();
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
export type AssistantHints = { goal?: string; planned?: string; category?: string; merchant?: string };
export type AssistantReply = { tool?: AssistantTool; hints?: AssistantHints; draft?: AssistantDraft; question?: string; source: "KI" | "Regel" };

const modelSchema = z.object({
  tool: z.string().nullish(),
  goal: z.string().nullish(),
  planned: z.string().nullish(),
  category: z.string().nullish(),
  merchant: z.string().nullish(),
  action: z.string().nullish(),
  name: z.string().nullish(),
  amount: z.number().nullish(),
  monthly: z.number().nullish(),
  startCapital: z.number().nullish(),
  installments: z.number().nullish(),
  fromAccount: z.string().nullish(),
  shared: z.boolean().nullish(),
  whatIf: z.boolean().nullish(),
}).passthrough();

export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const toolList = assistantTools.map((tool) => `${tool} = ${toolDescriptions[tool]}`).join("; ");
const systemPrompt = "Du bist der Router eines privaten Finanz-Assistenten. Du wählst nur das passende Werkzeug und liest Angaben aus der Nachricht heraus. " +
  "Du rechnest nie und erfindest keine Zahlen. Antworte ausschließlich mit einem JSON-Objekt mit genau diesen Feldern: " +
  "{\"tool\": string, \"goal\": string | null, \"planned\": string | null, \"category\": string | null, \"merchant\": string | null, " +
  "\"name\": string | null, \"amount\": number | null, \"monthly\": number | null, \"startCapital\": number | null, \"installments\": number | null, " +
  "\"fromAccount\": string | null, \"shared\": boolean | null, \"whatIf\": boolean | null}. " +
  `Werkzeuge: ${toolList}. ` +
  "goal = Name eines bestehenden Sparziels aus der Liste, planned = Name einer bestehenden geplanten Ausgabe aus der Liste, " +
  "category = Buchungskategorie aus der Liste, merchant = Händlername genau wie in der Nachricht. " +
  "Für savings_goal, expense und affordability: name = kurzer Name (z. B. \"Japan\", \"Pickerl\", \"Laptop\"), amount = Zielbetrag bzw. Gesamtpreis, " +
  "monthly = monatlicher Betrag, startCapital = schon vorhandenes Geld, installments = Anzahl der Raten, fromAccount = Konto, " +
  "shared = mit Raphael geteilt, whatIf = nur durchrechnen. Übernimm Zahlen exakt. Nicht genannte Felder sind null. " +
  "Ist ein offener Entwurf angegeben und beantwortet die Nachricht nur dessen Rückfrage, nimm dessen action als tool. " +
  "Nachrichten sind oft locker, kurz oder ohne Satzbau geschrieben. Erkenne die Absicht trotzdem, z. B.: " +
  "\"essen oktober wie viel\" = query; \"wo geht mein geld hin\" = query; \"Japan Reise 3000 bis Juli 2027, 500 hab ich schon\" = savings_goal; " +
  "\"ist ein 900 € Fernseher im Mai drin?\" = affordability; \"mach Japan 4000\" = edit; \"Pickerl erst im April\" = edit; " +
  "\"lieferando gehört zu lieferdienste\" = rule; \"lass immer 500 € reserve\" = remember; \"wo kann ich 200 € sparen\" = coach; " +
  "\"100 im monat anlegen 10 jahre\" = depot; \"wie hoch ist die teuerung\" = market; \"was kriegt man fürs tagesgeld\" = market; \"3000 euro in yen\" = market; \"etf was is des eigentlich\" = knowledge; \"kest bedeutung\" = knowledge; \"was hast du dazugelernt\" = knowledge; \"wie läuft das mit den sparzielen\" = explain; \"nimm das zurück\" = undo; " +
  "\"wie viel muss ich noch auf amex rückzahlung überweisen\" = amex; \"was hab ich seit 11.10. mit amex bezahlt\" = query; " +
  "\"wie viel ist am sparkonto\" = accounts; \"meine kontostände\" = accounts; \"was bleibt mir diesen monat\" = budget; " +
  "\"wie viel kann ich noch ausgeben\" = budget; \"bin ich sparsam\" = check; \"wie stehe ich finanziell da\" = check; " +
  "\"wie haben sich meine ausgaben entwickelt\" = query; andere Fragen zu den eigenen Finanzen = ask. " + DATA_RULE;

const fold = (value: string) => value.toLowerCase().normalize("NFKC");

// The model may only name things that really exist and appear in the message; everything else is dropped.
function groundHints(model: z.infer<typeof modelSchema> | undefined, input: AssistantRequest): AssistantHints {
  if (!model) return {};
  const hints: AssistantHints = {};
  const text = input.message;
  const goal = model.goal ? matchName(`${model.goal}`, input.context?.goals ?? [], (name) => name) : undefined;
  if (goal && matchName(text, [goal], (name) => name)) hints.goal = goal;
  const planned = model.planned ? matchName(`${model.planned}`, input.context?.planned ?? [], (name) => name) : undefined;
  if (planned && matchName(text, [planned], (name) => name)) hints.planned = planned;
  const category = model.category?.trim();
  if (category && (categories as readonly string[]).includes(category)) hints.category = category;
  const merchant = model.merchant?.trim();
  if (merchant && merchant.length >= 2 && merchant.length <= 60 && fold(text).includes(fold(merchant))) hints.merchant = merchant;
  return hints;
}

export async function interpretAssistantMessage(request: AssistantRequest, options: ChatOptions = {}): Promise<AssistantReply> {
  // Casual spellings ("wv", "fuer", "3k", "Juli 27") are normalized once so rules, model and grounding see the same text.
  const input: AssistantRequest = { ...request, message: normalizeMessage(request.message) };
  const parsed = parseAssistantMessage(input.message, input.asOf);
  const names = [...(input.context?.goals ?? []), ...(input.context?.planned ?? [])];
  const ruleTool = detectTool(input.message, names);
  let model: z.infer<typeof modelSchema> | undefined;
  let source: AssistantReply["source"] = "Regel";
  try {
    const answer = await chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: [
        `Heute: ${input.asOf}`,
        input.context?.goals.length ? `Sparziele: ${input.context.goals.join(", ")}` : "Sparziele: keine",
        input.context?.planned.length ? `Geplante Ausgaben: ${input.context.planned.join(", ")}` : "",
        `Kategorien: ${categories.join(", ")}`,
        input.pending ? `Offener Entwurf: ${JSON.stringify(input.pending)}` : "",
        input.history?.length ? `Verlauf:\n${input.history.map((item) => `${item.role === "user" ? "Ich" : "Assistent"}: ${item.role === "user" ? item.text : cleanUntrusted(item.text)}`).join("\n")}` : "",
        `In der Nachricht gefundene Beträge: ${parsed.numbers.join(", ") || "keine"}`,
        `Nachricht: ${input.message}`,
      ].filter(Boolean).join("\n") },
    ], { ...options, maxTokens: 300, temperature: 0 });
    const candidate = modelSchema.safeParse(extractJsonObject(answer.content));
    if (candidate.success) { model = candidate.data; source = "KI"; }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Without the model the rule parser still understands clear messages.
  }
  const modelTool = isAssistantTool(model?.tool) ? model.tool : isAssistantTool(model?.action) ? model.action : undefined;
  // Clear commands stay deterministic; an open draft keeps priority for answers to its question.
  let tool: AssistantTool | undefined = ruleTool ?? modelTool;
  if (input.pending && (!ruleTool || isDraftTool(ruleTool)) && (!modelTool || isDraftTool(modelTool))) tool = ruleTool ?? input.pending.action;
  const hints = groundHints(model, input);
  if (!tool) return { source };
  if (!isDraftTool(tool)) return { tool, hints, source };
  const extraction: ModelExtraction | undefined = model ? { ...model, action: tool } : undefined;
  const grounded = groundModelExtraction(extraction, parsed, input.message);
  const draft = mergeDraft(input.pending, { ...parsed, action: parsed.action ?? tool }, grounded, input.message, input.asOf);
  if (!draft) return { tool, hints, source };
  const question = missingQuestion(draft);
  return { tool: draft.action, hints, draft, ...(question ? { question } : {}), source };
}