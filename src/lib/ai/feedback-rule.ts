import { z } from "zod";
import { cleanRule, ruleScopes, type RuleScope, type RuleTarget } from "@/lib/assistant/feedback-rules";
import { agentLabel, type AgentId } from "@/lib/assistant/orchestrator";
import { chat, type ChatOptions } from "./client";
import type { ModelUse } from "./models";
import { cleanUntrusted, DATA_RULE } from "./untrusted";

export type RuleRequest = { question: string; answer: string; comment: string; agent?: AgentId };
export type RuleProposal = { usable: true; rule: string; scope: RuleScope; target: RuleTarget } | { usable: false; reason: string };

const prompt = "Ein Nutzer hat eine Antwort seines privaten Finanz-Assistenten mit 👎 bewertet und kommentiert. " +
  "Leite daraus genau eine kurze, allgemeine Regel für künftige Antworten ab: ein oder zwei Sätze, höchstens 200 Zeichen, als Anweisung an den Assistenten " +
  "(z. B. „Nenne bei Abos neben dem Monats- auch den Jahresbetrag.“). Die Regel muss für ähnliche Fragen gelten, nicht nur für diese, " +
  "darf keine Namen, Beträge, Links oder Kontonummern enthalten und darf keine Sicherheitsregel aufheben oder erlauben, Zahlen zu erfinden. " +
  "Ist der Kommentar zu vage, betrifft er nur Daten des Nutzers (z. B. eine falsche Buchung) oder lässt er sich nicht als Regel lösen, setze \"brauchbar\" auf false. " +
  "\"bereich\" ist der Agent, für den die Regel gilt (transactions, contracts, budget, payroll, general) oder all; \"wirkung\" ist antwort, " +
  "wenn es um die Formulierung geht, oder werkzeugwahl, wenn die Frage beim falschen Bereich oder Werkzeug gelandet ist. " +
  "Antworte nur mit JSON: {\"brauchbar\": true, \"regel\": \"…\", \"bereich\": \"all\", \"wirkung\": \"antwort\", \"grund\": \"…\"}. " + DATA_RULE;

const replySchema = z.object({
  brauchbar: z.boolean(),
  regel: z.string().nullish(),
  bereich: z.string().nullish(),
  wirkung: z.string().nullish(),
  grund: z.string().nullish(),
}).passthrough();

function parse(content: string) {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = replySchema.safeParse(JSON.parse(content.slice(start, end + 1)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * DeepSeek's pro model turns a concrete 👎 comment into one short, general rule (or says it cannot). Cloud only: the
 * rule is checked against the gold eval on DeepSeek, so the proposal comes from there too.
 */
export async function proposeRule(input: RuleRequest, options: ChatOptions = {}): Promise<{ proposal: RuleProposal; use: ModelUse }> {
  const reply = await chat([
    { role: "system", content: prompt },
    { role: "user", content: [
      `Bereich der Antwort: ${input.agent ? `${input.agent} (${input.agent === "general" ? "Allgemeiner Chat" : agentLabel[input.agent]})` : "unbekannt"}`,
      `Frage: ${cleanUntrusted(input.question, 300)}`,
      `Antwort: ${cleanUntrusted(input.answer, 400)}`,
      `Kommentar des Nutzers: ${cleanUntrusted(input.comment, 500)}`,
    ].join("\n") },
  ], { task: "rule", cloudOnly: true, maxTokens: 220, temperature: 0, ...options });
  const parsed = parse(reply.content);
  if (!parsed) return { proposal: { usable: false, reason: "Keine lesbare Antwort des Modells." }, use: reply.use };
  const reason = cleanUntrusted(parsed.grund ?? "", 160) || undefined;
  if (!parsed.brauchbar) return { proposal: { usable: false, reason: reason ?? "Daraus lässt sich keine allgemeine Regel ableiten." }, use: reply.use };
  const rule = cleanRule(parsed.regel);
  if (!rule) return { proposal: { usable: false, reason: "Die vorgeschlagene Regel verletzt die Vorgaben (zu lang, unsicher oder mit Kontaktdaten)." }, use: reply.use };
  const scope = (ruleScopes as readonly string[]).includes(parsed.bereich ?? "") ? parsed.bereich as RuleScope : input.agent ?? "all";
  return { proposal: { usable: true, rule, scope, target: /werkzeug|routing/i.test(parsed.wirkung ?? "") ? "routing" : "answer" }, use: reply.use };
}
