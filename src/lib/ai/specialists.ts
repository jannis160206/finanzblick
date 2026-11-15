import { rulesSection } from "@/lib/assistant/feedback-rules";
import { agentTools, type AgentId } from "@/lib/assistant/orchestrator";
import { toolDescriptions } from "@/lib/assistant/tools";
import { promptPart, promptText, type PromptOverrides } from "./agent-prompts";
import { DATA_RULE } from "./untrusted";

// Server-side prompts of the orchestrator and its agents. The editable parts come from agent-prompts (defaults or the admin's
// version); every prompt stays static per agent, so the model server's prefix cache keeps it warm and only the short dynamic
// part (date, names, message) is processed per request.

/** The local routing without DeepSeek: one word, and "chat" whenever it is unsure. */
export const orchestratorPrompt = (prompts?: PromptOverrides): string => promptText("router", prompts);

type Scope = { fields: string; needs: { names?: boolean; categories?: boolean } };

// Fields per agent; each specialist only sees its own tools.
const scopes: Record<AgentId, Scope> = {
  transactions: {
    fields: "category = Buchungskategorie aus der Liste, merchant = Händlername genau wie in der Nachricht (nie Wörter wie Geld oder Ausgaben)",
    needs: { categories: true },
  },
  contracts: {
    fields: "merchant = Vertrag oder Anbieter genau wie in der Nachricht",
    needs: {},
  },
  budget: {
    fields: "goal = Name eines bestehenden Sparziels aus der Liste, planned = Name einer bestehenden geplanten Ausgabe aus der Liste. " +
      "Für savings_goal, expense und affordability: name = kurzer Name (z. B. \"Japan\", \"Pickerl\"), amount = Zielbetrag bzw. Gesamtpreis, monthly = monatlicher Betrag, " +
      "startCapital = schon vorhandenes Geld, installments = Anzahl der Raten, fromAccount = Konto, shared = mit Raphael geteilt, whatIf = nur durchrechnen",
    needs: { names: true },
  },
  payroll: {
    fields: "",
    needs: {},
  },
  general: {
    fields: "",
    needs: {},
  },
};

const jsonFields = (agent: AgentId) => [
  "\"tool\": string",
  ...(scopes[agent].needs.categories ? ["\"category\": string | null", "\"merchant\": string | null"] : []),
  ...(agent === "contracts" ? ["\"merchant\": string | null"] : []),
  ...(scopes[agent].needs.names ? ["\"goal\": string | null", "\"planned\": string | null", "\"name\": string | null", "\"amount\": number | null",
    "\"monthly\": number | null", "\"startCapital\": number | null", "\"installments\": number | null", "\"fromAccount\": string | null",
    "\"shared\": boolean | null", "\"whatIf\": boolean | null"] : []),
].join(", ");

/** The tool prompt of one specialist: only its own tools, fields and examples, plus the rules learned from feedback. */
export function interpretPrompt(agent: AgentId, rules: readonly string[] = [], prompts?: PromptOverrides): string {
  const tools = agentTools(agent).filter((tool) => tool !== "ask").map((tool) => `${tool} = ${toolDescriptions[tool]}`).join("; ");
  const scope = scopes[agent];
  return "Du bist ein Spezialist eines privaten Finanz-Assistenten: Wähl das passende Werkzeug und lies die Angaben aus der Nachricht, " +
    `ohne zu rechnen oder Zahlen zu erfinden. Antworte nur mit JSON: {${jsonFields(agent)}}. Werkzeuge: ${tools}; ask = in Worten beantworten. ` +
    (scope.fields ? `${scope.fields}. Zahlen exakt übernehmen, Fehlendes ist null. ` : "") +
    (agent === "budget" ? "Beantwortet die Nachricht nur die Rückfrage eines offenen Entwurfs, nimm dessen action als tool. " : "") +
    promptPart(`tools.${agent}`, prompts) + DATA_RULE + rulesSection(rules);
}
export const scopeNeeds = (agent: AgentId) => scopes[agent].needs;

// Fixed: numbers come only from the facts and results. An edited prompt can never drop this.
const grounding = "Zahlen zu seinen Finanzen nimmst du nur aus den Fakten (JSON) und den Ergebnissen, genau so geschrieben wie dort; rechne nichts selbst aus " +
  "und lass weg, was dort nicht steht. Empfiehl keine einzelnen Aktien, Fonds oder Anbieter. ";

/**
 * The system prompt the local model writes an answer with (without DeepSeek): the agent's voice, the shared answer rules, then
 * the fixed grounding and data rule, plus the rules learned from feedback.
 */
export function answerPrompt(agent: AgentId, rules: readonly string[] = [], prompts?: PromptOverrides): string {
  return promptPart(`voice.${agent}`, prompts) + promptPart("answer-rules", prompts) + grounding + DATA_RULE + rulesSection(rules);
}
