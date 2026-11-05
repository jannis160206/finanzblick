import { z } from "zod";
import { assistantDraftSchema, dateSchema, type AssistantDraft } from "@/lib/types";
import { groundModelExtraction, mergeDraft, missingQuestion, parseAssistantMessage, type ModelExtraction } from "@/lib/assistant/intent";
import { chat, type ChatOptions } from "./client";

export const assistantRequestSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  asOf: dateSchema,
  pending: assistantDraftSchema.optional(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(500) }).strict()).max(6).optional(),
}).strict();
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
export type AssistantReply = { draft?: AssistantDraft; question?: string; source: "KI" | "Regel" };

const modelSchema = z.object({
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

const systemPrompt = "Du liest Nachrichten an einen privaten Finanz-Assistenten und gibst nur die genannten Angaben als JSON zurück. " +
  "Antworte ausschließlich mit einem JSON-Objekt mit genau diesen Feldern: " +
  "{\"action\": \"savings_goal\" | \"expense\" | \"affordability\" | null, \"name\": string | null, \"amount\": number | null, " +
  "\"monthly\": number | null, \"startCapital\": number | null, \"installments\": number | null, \"fromAccount\": string | null, " +
  "\"shared\": boolean | null, \"whatIf\": boolean | null}. " +
  "savings_goal = ein Sparziel anlegen. expense = eine künftige Ausgabe oder einen Ratenkauf planen. affordability = Frage, ob man sich etwas leisten kann. " +
  "name = kurzer Name des Ziels oder der Ausgabe (z. B. \"Japan\", \"Pickerl\", \"Laptop\"). amount = Zielbetrag bzw. Gesamtpreis. " +
  "monthly = Betrag, den man monatlich sparen kann. startCapital = Geld, das schon vorhanden ist. installments = Anzahl der Raten. " +
  "fromAccount = Konto des Startkapitals oder der Zahlung. shared = mit Raphael geteilt. whatIf = nur durchrechnen, nichts anlegen. " +
  "Übernimm Zahlen exakt aus der Nachricht und rechne nichts. Datumsangaben brauchst du nicht. Nicht genannte Felder sind null. " +
  "Ist ein offener Entwurf angegeben und beantwortet die Nachricht nur dessen Rückfrage, nimm dessen action.";

export async function interpretAssistantMessage(input: AssistantRequest, options: ChatOptions = {}): Promise<AssistantReply> {
  const parsed = parseAssistantMessage(input.message, input.asOf);
  let model: ModelExtraction | undefined;
  let source: AssistantReply["source"] = "Regel";
  try {
    const answer = await chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: [
        `Heute: ${input.asOf}`,
        input.pending ? `Offener Entwurf: ${JSON.stringify(input.pending)}` : "",
        input.history?.length ? `Verlauf:\n${input.history.map((item) => `${item.role === "user" ? "Ich" : "Assistent"}: ${item.text}`).join("\n")}` : "",
        `In der Nachricht gefundene Beträge: ${parsed.numbers.join(", ") || "keine"}`,
        `Nachricht: ${input.message}`,
      ].filter(Boolean).join("\n") },
    ], { ...options, maxTokens: 250, temperature: 0 });
    const candidate = modelSchema.safeParse(extractJsonObject(answer.content));
    if (candidate.success) { model = candidate.data; source = "KI"; }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Without the model the rule parser still understands clear messages.
  }
  const grounded = groundModelExtraction(model, parsed, input.message);
  const draft = mergeDraft(input.pending, parsed, grounded, input.message, input.asOf);
  if (!draft) return { source };
  const question = missingQuestion(draft);
  return { draft, ...(question ? { question } : {}), source };
}
