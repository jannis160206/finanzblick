import { z } from "zod";
import { chat, stripThinking, type ChatOptions } from "./client";
import { cleanFacts, contactsBacked, DATA_RULE } from "./untrusted";

const amount = z.number().finite();
const category = z.object({ category: z.string().max(60), amount, change: amount.optional() }).strict();
export const summaryFactsSchema = z.object({
  monthLabel: z.string().max(40),
  income: amount,
  spending: amount,
  balance: amount,
  previousSpending: amount.optional(),
  topCategories: z.array(category).max(5),
  largest: z.array(z.object({ merchant: z.string().max(60), amount, category: z.string().max(60) }).strict()).max(3),
  subscriptions: z.array(z.object({ merchant: z.string().max(60), monthlyCost: amount }).strict()).max(20),
  priceIncreases: z.array(z.object({ merchant: z.string().max(60), from: amount, to: amount }).strict()).max(10),
  duplicates: z.number().int().min(0).max(100),
  forecast: z.object({ projectedSpending: amount, averageSpending: amount.optional(), monthLabel: z.string().max(40) }).strict(),
}).strict();
export type SummaryFacts = z.infer<typeof summaryFactsSchema>;

const euro = (value: number) => new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(value);

export function fallbackSummary(facts: SummaryFacts) {
  const top = facts.topCategories[0];
  const parts = [
    `Im ${facts.monthLabel} hast du ${euro(facts.spending)} ausgegeben und ${euro(facts.income)} eingenommen.`,
    top ? `Größter Posten war ${top.category} mit ${euro(top.amount)}.` : "",
    facts.previousSpending !== undefined
      ? `Das sind ${euro(Math.abs(facts.spending - facts.previousSpending))} ${facts.spending > facts.previousSpending ? "mehr" : "weniger"} als im Monat davor.` : "",
    `Für ${facts.forecast.monthLabel} rechne ich mit rund ${euro(facts.forecast.projectedSpending)} Ausgaben.`,
  ];
  return parts.filter(Boolean).join(" ");
}

// Every number in the model text must come from the facts; otherwise the deterministic text is used.
export function numbersBacked(text: string, facts: object) {
  const known = new Set<string>();
  const add = (value: number) => {
    for (const candidate of [value, Math.abs(value)]) {
      known.add(candidate.toFixed(2));
      known.add(Math.round(candidate).toFixed(2));
    }
  };
  JSON.stringify(facts, (_key, value) => { if (typeof value === "number") add(value); return value; });
  const numbers = text.match(/\d+(?:\.\d{3})*(?:,\d+)?/g) ?? [];
  // Euro amounts always need a source, even small ones ("13,00 € für eine Kamera").
  const amounts = new Set((text.match(/(?:€|\beur\b|\beuro\b)\s*\d[\d.,]*|\d[\d.,]*\s*(?:€|eur\b|euro\b)/gi) ?? [])
    .flatMap((match) => match.match(/\d+(?:\.\d{3})*(?:,\d+)?/g) ?? []));
  return numbers.every((raw) => {
    const value = Number(raw.replace(/\./g, "").replace(",", "."));
    if (known.has(value.toFixed(2)) || value === 0) return true;
    if (amounts.has(raw)) return false;
    // Years, day numbers and small counts are fine; amounts need a source.
    return value < 32 || (value >= 2000 && value <= 2100 && !raw.includes(","));
  });
}

export async function writeMonthlySummary(facts: SummaryFacts, options: ChatOptions = {}) {
  const fallback = fallbackSummary(facts);
  // Hand over finished differences so the model never has to calculate.
  const modelFacts = {
    ...cleanFacts(facts, 60),
    ...(facts.previousSpending !== undefined
      ? { spendingChangeVsPreviousMonth: Math.round((facts.spending - facts.previousSpending) * 100) / 100 } : {}),
  };
  const answer = await chat([
    {
      role: "system",
      content: "Du schreibst eine kurze, freundliche Monatszusammenfassung für ein privates Finanzdashboard auf Deutsch (Du-Form). " +
        "Maximal 4 Sätze, kein Markdown. Nenne nur Beträge, die genau so in den Fakten stehen, und rechne nichts selbst aus. " +
        "previousSpending sind die Ausgaben des Vormonats (nicht des Vorjahres). balance ist Einnahmen minus Ausgaben, nicht der Kontostand. " +
        "Erfinde nichts und gib keine Anlageberatung. " + DATA_RULE,
    },
    { role: "user", content: `Fakten (JSON):\n${JSON.stringify(modelFacts)}` },
  ], { task: "chat", ...options, maxTokens: 300, temperature: 0.2 });
  const text = stripThinking(answer.content).replace(/\s+/g, " ").trim().slice(0, 900);
  return text.length >= 40 && numbersBacked(text, modelFacts) && contactsBacked(text, modelFacts) ? { text, source: "KI" as const } : { text: fallback, source: "Regel" as const };
}
