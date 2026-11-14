import { contentWords } from "@/lib/knowledge-base/query";
import type { AssistantKnowledge } from "@/lib/types";
import { redactSensitive } from "./feedback";
import { unsureAnswer } from "./orchestrator";
import { foldText, ownData, publicTerms, statedYear } from "./public-facts";

// What the assistant may keep as local knowledge: general answers without personal data. Facts that change
// (news, prices, rates, yearly limits) are never kept or expire; account numbers and contact details never go in.

const DAY = 24 * 60 * 60 * 1000;
/** Rates and prices are looked up again after a week. */
export const VOLATILE_DAYS = 7;

export type Volatility =
  | { kind: "stable" }
  | { kind: "expires"; reason: string; expiresAt: number }
  | { kind: "never"; reason: string };

const news = /\b(?:nachricht\w*|news|schlagzeile\w*|was (?:ist|war) (?:heute|gestern) (?:los|passiert)|neuigkeit\w*|ereignis\w*|wahl(?:en|ergebnis\w*)?|krieg\w*)\b/;
const quotes = /\b(?:\w*kurs(?:e|es)?|kurswert|dax|atx|s ?p ?500|nasdaq|dow jones|msci world (?:steht|stand)|\w*preis (?:von|fuer) (?:bitcoin|gold|silber|oel)|(?:bitcoin|gold|silber|oel)preis|wie steht (?:der|die|das))\b/;
const rates = /\b(?:\w*zins\w*|euribor|ezb|inflation\w*|teuerung\w*|vpi|hvpi|rendite\w*)\b/;
const prices = /\b(?:\w*preis\w*|kostet|kosten|\w*gebuehr\w*|tarif\w*|miete\w*|\w*beitrag|\w*beitraege)\b/;
const currentValue = new RegExp(`${statedYear.source}|\\b(?:heute|gerade|zurzeit|jetzt|neueste\\w*|diese[snm]? (?:woche|monat)|wie (?:hoch|viel|teuer)|was kostet|stand)\\b`);
// An amount or a percentage in the answer: "520 €", "3,5 %", "€ 12".
const figure = /\d[\d.,]*\s*(?:€|eur\b|euro\b|%|prozent\b)|€\s*\d/i;

const endOfYear = (year: number) => Date.UTC(year, 11, 31, 23, 59, 59);

/**
 * Whether an answer stays true: news and quotes are never kept; rates and prices expire after a week; yearly limits,
 * allowances and tax figures at the end of the year they are about. Explanations ("Was ist ein ETF?") stay.
 */
export function volatility(question: string, answer: string, now = Date.now()): Volatility {
  const asked = foldText(question);
  const said = foldText(answer);
  const current = currentValue.test(asked) || figure.test(answer);
  if (news.test(asked)) return { kind: "never", reason: "Nachrichten" };
  if (quotes.test(asked) && current) return { kind: "never", reason: "Kurse" };
  if ((rates.test(asked) || prices.test(asked)) && current && !publicTerms.test(asked))
    return { kind: "expires", reason: rates.test(asked) ? "Zinsen ändern sich" : "Preise ändern sich", expiresAt: now + VOLATILE_DAYS * DAY };
  if ((publicTerms.test(asked) || /\bsteuer\w*|\bkest\b/.test(asked) && figure.test(answer)) && current) {
    const thisYear = new Date(now).getUTCFullYear();
    const named = [...`${asked} ${said}`.matchAll(/\b(20[2-3]\d)\b/g)].map((match) => Number(match[1])).filter((year) => year >= thisYear);
    return { kind: "expires", reason: "Gilt für ein Jahr", expiresAt: endOfYear(Math.min(thisYear + 1, Math.max(thisYear, ...named))) };
  }
  return { kind: "stable" };
}

/**
 * General knowledge only: no question about the user's own money, nothing that had to be redacted (IBAN, card or
 * phone numbers, e-mail addresses, keys), no answer that admits not knowing, and enough words to be found again.
 */
export function storableAnswer(question: string, answer: string): boolean {
  const text = answer.trim();
  if (contentWords(question).length < 2 || text.length < 20 || text.length > 1500) return false;
  if (ownData.test(foldText(question)) || unsureAnswer(text)) return false;
  return redactSensitive(question) === question && redactSensitive(text) === text && !/\b(?:Person|IBAN|Karte|Nummer|Telefon|email)-\d+\b/.test(text);
}

export const isExpired = (entry: Pick<AssistantKnowledge, "expiresAt">, now = Date.now()) => entry.expiresAt !== undefined && entry.expiresAt <= now;

/** Answers the assistant may find again: stored web or chat answers that are neither rejected nor expired. */
export const reusable = (entry: AssistantKnowledge, now = Date.now()) =>
  (entry.kind === "web" || entry.kind === "answer") && !entry.rejected && !isExpired(entry, now) && !!entry.question;
