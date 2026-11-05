import type { AppState, AssistantOperation } from "@/lib/types";
import { parseMemory } from "./agent";
import { detectAction } from "./intent";
import { normalizeMessage } from "./normalize";
import type { AssistantTool } from "./tools";

type MemoryAdd = Extract<AssistantOperation, { op: "memory_add" }>;

const fold = (value: string) => value.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, " ").trim();
const months = /\b(?:jänner|januar|februar|feber|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\b|\b\d{1,2}\.\d{1,2}\.|\b20\d{2}\b/;

// Lasting first-person facts: "Ich wohne in Wien", "Meine Miete ist 650 €", "Ich teile mir die Miete mit Raphael".
const facts = [
  /^(?:ich|wir)\s+(?:bin|sind|wohne|wohnen|arbeite|arbeiten|teile|teilen|lebe|leben|studiere|studieren|pendle|pendeln|verdiene|verdienen|bekomme|bekommen|zahle|zahlen|fahre|fahren|tanke|tanken|kaufe|kaufen|esse|essen|gehe|gehen|nutze|nutzen)\b.{3,}/,
  /^(?:mein|meine|meinen|unser|unsere)\s+[a-zäöüß-]{3,}\s+(?:ist|sind|heißt|kostet|kosten|kommt|beträgt|läuft|endet|liegt|bekommt)\b.{2,}/,
  /^(?:ich|wir)\s+(?:möchte|will|wollen|mag|mögen)\s+(?:immer|nie|niemals|keine?n?|lieber|grundsätzlich)\b.{3,}/,
  /^(?:ich|wir)\s+(?:hab|habe|haben)\s+(?:ein|eine|einen|zwei|drei|vier|\d+|keine?n?)\s+(?:kind|kinder|auto|autos|hund|hunde|katze|katzen|wohnung|haus|freundin|freund|partner|partnerin|frau|mann|motorrad)\b.*/,
  /^mit\s+.{2,30}\s+meine? (?:ich|wir)\b.{2,}/,
];
// One-off events, plans and past bookings are not facts worth keeping.
const transient = /\?|\bbis\b|ausgegeben|gekauft|bezahlt|überwiesen|gestern|heute|morgen|vorhin|letzte[nrs]? |nächste[nrs]? |diese[nrs]? (?:woche|monat)|gerade|wie viel|\bwas\b|\bsoll ich\b|\bkann ich\b|\bwürde\b|merk dir|vergiss/;
const habit = /\bimmer\b|\bnie\b|niemals|mindestens|stets|grundsätzlich|generell|jeden monat|monatlich|\bmein(?:e|en)? (?:puffer|reserve|polster)\b|(?:puffer|reserve|polster) (?:ist|von|sind|beträgt)|\bkommt\b|\bbekomm|\bgibt'?s\b|\bjeweils\b/;

function sentences(text: string) {
  return text.split(/(?<=[.!?;])\s+|\s*\n+\s*|,\s+(?=(?:und\s+|aber\s+)?(?:ich|wir|mein|meine|unser|unsere)\b)/i)
    .map((part) => part.trim().replace(/^(?:und|aber|übrigens|ach ja|übrigens|info|fyi)[,:\s]+/i, "").trim())
    .filter(Boolean);
}

// Finds lasting facts in any chat message so the assistant remembers them without "Merk dir".
export function extractMemories(input: string, state: AppState, tool?: AssistantTool): MemoryAdd[] {
  if (tool === "remember" || tool === "forget" || tool === "memory" || tool === "undo" || tool === "changes") return [];
  const memory = state.assistantMemory ?? [];
  const found: MemoryAdd[] = [];
  const known = (operation: MemoryAdd) => {
    if (operation.key !== "note") return [...memory, ...found].some((entry) => entry.key === operation.key && entry.value === operation.value);
    const plain = fold(operation.text);
    return [...memory, ...found].some((entry) => entry.key === "note" && (fold(entry.text).includes(plain) || plain.includes(fold(entry.text))));
  };
  for (const sentence of sentences(normalizeMessage(input))) {
    if (found.length >= 3) break;
    const lower = sentence.toLowerCase();
    if (/\?\s*$/.test(sentence)) continue;
    let operation: MemoryAdd | undefined;
    if ((/(?:gehalt|lohn)\b.*\bam\s+\d{1,2}\b|\bam\s+\d{1,2}\.?\s+(?:kommt|gibt'?s)\s+(?:mein|das)\s+(?:gehalt|lohn)/.test(lower) ||
      /puffer|reserve|polster|nie unter \d|nicht unter \d/.test(lower)) && habit.test(lower) && !/\bkam\b|\bwar\b|leisten|leistbar/.test(lower)) {
      const parsed = parseMemory(sentence);
      if (parsed && parsed.key !== "note") operation = parsed;
    } else if (facts.some((pattern) => pattern.test(lower)) && !transient.test(lower) && !months.test(lower) && !detectAction(sentence)) {
      const note = sentence.replace(/[.!;,\s]+$/, "").slice(0, 200);
      if (note.length >= 8) operation = { op: "memory_add", key: "note", text: note.charAt(0).toUpperCase() + note.slice(1) };
    }
    if (operation && !known(operation)) found.push(operation);
  }
  return found;
}
