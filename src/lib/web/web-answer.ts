import { contentWords } from "@/lib/knowledge-base/query";

// The web search result as the chat sees it, plus the pure helpers that turn it into evidence and a fallback answer.
// No server imports here: the chat component uses this file, the search itself runs in `search.ts` on the server.

// Words that only ask for a search ("Such im Internet nochmal danach") and carry no topic.
export const searchFiller = new Set([
  "such", "suche", "sucht", "schau", "schaue", "nach", "internet", "netz", "web", "online", "google", "googel", "googeln", "googlen", "recherchier",
  "recherchiere", "hoch", "bekommt", "bekomme", "kriegt", "krieg", "gibt", "gilt", "infos", "info", "informationen", "frage", "hallo", "danke",
  "nochmal", "erneut", "neuem", "neues", "dazu", "danach", "darüber", "davon", "bitte", "aktuelle", "aktuell", "mehr", "nachschauen", "nachsehen",
]);

/** Personal details and amounts removed: links, e-mail addresses, IBANs, euro amounts and numbers other than recent years. */
export const scrubQuestion = (question: string) => question
  .replace(/https?:\/\/\S+|\S+@\S+/gi, " ")
  .replace(/\b[a-z]{2}\d{2}(?:\s?[a-z0-9]{4}){3,7}\b/gi, " ")
  .replace(/€\s*\d[\d.,]*|\d[\d.,]*\s*(?:€|euro\b|eur\b)/gi, " ")
  .replace(/\b\d[\d.,]*\b/g, (number) => /^20[23]\d$/.test(number) ? number : " ");

/** The topic words of a message without the search request around them; empty for "Such im Internet nochmal danach". */
export const searchTopicWords = (question: string) => contentWords(scrubQuestion(question)).filter((word) => !searchFiller.has(word));

export type WebSource = { n: number; title: string; url: string; site: string; text: string; official: boolean };
export type WebSearchProvider = "searxng" | "brave" | "bing" | "wikipedia" | "none";
export type WebSearchResult = {
  query: string; sources: WebSource[]; agreed: string[]; provider: WebSearchProvider; ms: number; disabled?: boolean;
};
export type WebLink = { title: string; url: string };

// Amounts, percentages and kilometre rates are what sources usually disagree on.
const FIGURE = /(?:€\s*\d[\d.,]*|\d[\d.,]*\s*(?:€|euro\b|eur\b|cent\b|prozent\b|%))/gi;

export const figureKey = (raw: string) => {
  const number = raw.match(/\d[\d.,]*/)?.[0] ?? "";
  const value = Number(number.replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  const unit = /%|prozent/i.test(raw) ? "%" : /cent/i.test(raw) ? "Cent" : "€";
  return Number.isFinite(value) ? `${value.toLocaleString("de-AT", { maximumFractionDigits: 2 })} ${unit}` : raw.trim();
};

/** Figures that at least two different sources state; they can be said without hedging. */
export function agreedFigures(texts: string[]): string[] {
  const seen = new Map<string, number>();
  for (const text of texts) for (const key of new Set((text.match(FIGURE) ?? []).map(figureKey))) seen.set(key, (seen.get(key) ?? 0) + 1);
  return [...seen.entries()].filter(([, count]) => count >= 2).map(([key]) => key).slice(0, 6);
}

/** The search result as evidence for the answer model: short, numbered and clearly public, never the user's own data. */
export function webEvidence(result: WebSearchResult, maxLength = 1450): string | undefined {
  if (!result.sources.length) return undefined;
  const lines = [
    "Websuche (öffentliche Quellen, keine Daten des Nutzers). Vergleiche die Quellen: Was übereinstimmt, sag direkt; wo sie sich widersprechen, " +
    "nenne beide Angaben. Amtliche Quellen (.gv.at) gehen vor. Verweise mit [1], [2] auf die Quellen und erfinde nichts dazu.",
  ];
  if (result.agreed.length) lines.push(`Übereinstimmend in mehreren Quellen: ${result.agreed.join(", ")}.`);
  const budget = Math.max(200, Math.floor((maxLength - lines.join("\n").length) / result.sources.length) - 4);
  for (const source of result.sources) {
    const head = `[${source.n}] ${source.site}${source.official ? " (amtlich)" : ""}: `;
    const room = budget - head.length;
    lines.push(`${head}${source.text.length > room ? `${source.text.slice(0, room - 1).replace(/\s+\S*$/, "")}…` : source.text}`);
  }
  return lines.join("\n").slice(0, maxLength);
}

// Sentence ends, but not after numbers ("7. Sept.") or short abbreviations ("bzw.", "z. B.", "Abs.").
const firstSentences = (text: string, count = 2) => {
  const parts: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?](?=\s+[A-ZÄÖÜ0-9„"])/g)) {
    const end = match.index + 1;
    const word = text.slice(start, end).match(/(\S+)$/)?.[1] ?? "";
    if (match[0] === "." && /^(?:\d+|\S{1,4})\.$/.test(word)) continue;
    parts.push(text.slice(start, end).trim());
    start = end;
    if (parts.length >= count) break;
  }
  if (parts.length < count && start < text.length) parts.push(text.slice(start).trim());
  return parts.slice(0, count).join(" ");
};

/** Without the language model: the most official source in its own words, with the source number. */
export function webFallbackAnswer(result: WebSearchResult): string | undefined {
  const [top, second] = [...result.sources].sort((a, b) => Number(b.official) - Number(a.official) || a.n - b.n);
  if (!top) return undefined;
  const lead = `Laut ${top.site} [${top.n}]: ${firstSentences(top.text)}`;
  const also = second ? ` Auch ${second.site} [${second.n}] schreibt dazu: ${firstSentences(second.text, 1)}` : "";
  return `${lead}${also} Bitte prüfe Details in der Quelle; das ist keine Steuer- oder Rechtsberatung.`.slice(0, 1800);
}

export const webLinks = (result: WebSearchResult): WebLink[] => result.sources.filter((source) => /^https:\/\/[^\s"<>]+$/.test(source.url) && source.url.length <= 500)
  .map((source) => ({ title: `${source.site} – ${source.title}`.slice(0, 120), url: source.url }));
