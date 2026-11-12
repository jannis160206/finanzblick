import type { AppState, AssistantCard, AssistantKnowledge, AssistantPhrase } from "@/lib/types";
import { MAX_ASSISTANT_KNOWLEDGE, MAX_ASSISTANT_PHRASES } from "@/lib/types";
import { normalizeMessage, stripAck } from "./normalize";

type Result = { text: string; card?: AssistantCard; suggestions?: string[] };
type Line = AssistantCard["lines"][number];

export const KNOWLEDGE_REFRESH_DAYS = 90;
const fold = (value: string) => value.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, " ").trim();

// "Was ist ein ETF?", "Was bedeutet KESt?", "Was versteht man unter Zinseszins?", "Wie funktioniert ein Bausparvertrag?", "Erklär mir Tagesgeld".
const article = "(?:eigentlich |denn |genau |ueberhaupt |überhaupt |so |nochmal |mal |kurz |bitte )*(?:ein |eine |einen |einem |einer |der |die |das |den |dem |des )?";
const definition = [
  new RegExp(`^(?:was|wos) (?:ist|sind|bedeutet|bedeuten|heißt|heisst|hei[sß]t eigentlich|meint man mit|macht|machen) ${article}(.+)$`),
  new RegExp(`^was versteht man unter ${article}(.+)$`),
  new RegExp(`^wie funktionier(?:t|en) ${article}(.+)$`),
  new RegExp(`^(?:erklär|erklaer|erkläre|erklaere)(?: mir| uns)? (?:mal |kurz |bitte |nochmal |einfach )*(?:was |wie )?${article}(.+?)(?: ist| sind| funktioniert| funktionieren| bedeutet)?$`),
  new RegExp(`^(?:kannst du mir|kannst du) (?:kurz |mal |bitte )*(?:erklären|erklaeren|sagen),? (?:was|wie) ${article}(.+?)(?: ist| sind| funktioniert| funktionieren| bedeutet)$`),
  new RegExp(`^(?:schlag|schau) (?:mal |bitte )*${article}(.+?) nach$`),
  new RegExp(`^(?:such|recherchier)\\w* (?:mal |bitte )*(?:im internet |online )?(?:nach |zu |über |ueber )?${article}(.+)$`),
];
const difference = /(?:^|\b)unterschied zwischen (?:einem |einer |dem |der |den |die |das )?(.+?) und (?:einem |einer |dem |der |den |die |das )?(.+?)$/;

// Dashboard words, own data and time phrases belong to the other tools.
const ownWords = /\b(?:mein\w*|mir|mich|ich|du|dein\w*|unser\w*|hier|dashboard|app|seite|assistent\w*|chat|pockets?|sparziel\w*|monatsplan|budgetdetails|pruefliste|händlerregel\w*|haendlerregel\w*|extra.?betr\w*|stichtag|ueberschuss|überschuss|import\w*|einstellung\w*|kategorie\w*|regeln?|rechner|funktion\w*|knopf|button|men(?:ü|ue)|ansicht|diagramm|gedaechtnis|gedächtnis|aenderung\w*|änderung\w*|sparkonto|amex|woche|monat\w*|jahr\w*|heuer|heute|morgen|gestern|faellig|fällig|offen|uebrig|übrig|los|neu\w*|passiert|geplant|ausgegeben|bezahlt|ausgaben?|einnahmen?|buchung\w*|umsa\w*|fixkosten|abos?|gehalt|lohn|kontostand|saldo|vermoegen|vermögen|ersparnis\w*|budget|puffer|reserve|stand|status|absetzbar|leistbar|moeglich|möglich|drin|rate|raten|urlaub\w*|notgroschen|plan|check|finanz.?check|coach|briefing|wochen(?:ü|ue)berblick|(?:ü|ue)berblick)\b/;
const badStart = /^(?:auf|im|in|am|an|bei|mit|fuer|für|von|vom|zu|zum|zur|da|denn|so|noch|schon|jetzt|gerade|es|alles|nicht|wann|wo|wie|was|wer|dies\w*|jene\w*|der|die|das|dann|damit|dabei|davon|dazu|hier|sonst|besser|gut|schlecht|falsch|richtig|los)\b/;
const months = /\b(?:jänner|jaenner|januar|februar|feber|maerz|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\b/;

const cleanTopic = (value: string) => value.replace(/[?!.,;:„“"'»«]+/g, " ").replace(/(?:\s+(?:eigentlich|genau|denn|überhaupt|ueberhaupt|bitte|nochmal|so|einfach|kurz|mal|schnell|in einem satz|in einfachen worten|einfach erklärt|für anfänger))+$/g, "")
  .replace(/\s+(?:in österreich|in oesterreich|in at)$/, " Österreich").replace(/\s+/g, " ").trim();

function validTopic(topic: string, names: string[]) {
  if (topic.length < 2 || topic.length > 60 || /\d/.test(topic) || topic.split(" ").length > 6) return false;
  if (badStart.test(topic) || ownWords.test(topic) || months.test(topic)) return false;
  const plain = fold(topic);
  return !names.some((name) => fold(name) && (plain === fold(name) || plain.includes(fold(name))));
}

// Up to two terms to look up; empty when the question is about own data or the dashboard.
export function knowledgeTopics(input: string, names: string[] = [], loose = false): string[] {
  const lower = stripAck(normalizeMessage(input)).toLowerCase().replace(/[?!.]+$/g, "").trim();
  if (/\d/.test(lower)) return [];
  const pair = difference.exec(lower);
  if (pair) {
    const topics = [cleanTopic(pair[1]), cleanTopic(pair[2])];
    return topics.every((topic) => validTopic(topic, names)) ? topics : [];
  }
  for (const pattern of definition) {
    const match = pattern.exec(lower);
    if (!match) continue;
    const topic = cleanTopic(match[1]);
    return validTopic(topic, names) ? [topic] : [];
  }
  if (!loose) return [];
  // The model already decided it is a term question ("etf was is des eigentlich"); keep only the term.
  const topic = cleanTopic(lower.split(" ").filter((word) => !filler.test(word)).join(" "));
  return validTopic(topic, names) && topic.split(" ").length <= 4 ? [topic] : [];
}
const filler = /^(?:was|wos|is|ist|sind|des|das|der|die|den|dem|ein|eine|einen|eigentlich|genau|denn|bedeutung|bedeutet|heißt|heisst|erklär\w*|erklaer\w*|mir|mal|bitte|kurz|nochmal|kannst|du|wie|funktioniert|funktionieren|versteht|man|unter|begriff|definition|meint|überhaupt|ueberhaupt|so|ne|eh|halt|weißt|weisst|kennst|sag|sagen|erzähl|erzaehl|über|ueber|von|zu|zum|zur|nach|schlag|such|im|internet|online|\?)$/;
export const knowledgeQuestion = (input: string, names: string[] = []) => knowledgeTopics(input, names).length > 0;
export const knowledgeListQuestion = (lower: string) =>
  /was hast du (?:alles |schon |bisher |dazu ?)*gelernt|was hast du dir angeeignet|dein (?:wissen|gelerntes)|was weißt du (?:schon )?alles(?! über mich)|was weisst du (?:schon )?alles(?! ueber mich)|gelerntes wissen|was (?:kannst|verstehst) du (?:noch )?nicht|was hast du (?:noch )?nicht verstanden|wie (?:hast du dich|bist du) (?:weiter ?entwickelt|besser geworden)|was hast du (?:von mir )?gelernt/.test(lower);

// Stored entries match by the asked term or the article title, so "ETF" and "Börsengehandelter Fonds" find the same entry.
// Confirmed web answers are found by the knowledge search instead, never as an encyclopedia article.
export function findKnowledge(all: AssistantKnowledge[] = [], topic: string): AssistantKnowledge | undefined {
  const wanted = fold(topic);
  if (!wanted) return undefined;
  const entries = all.filter((entry) => entry.kind !== "web");
  return entries.find((entry) => fold(entry.topic) === wanted || fold(entry.title) === wanted)
    ?? entries.find((entry) => wanted.length >= 4 && (fold(entry.title).split(" ").includes(wanted) || fold(entry.topic).includes(wanted)));
}
export const isStale = (entry: AssistantKnowledge, now = Date.now()) => now - entry.at > KNOWLEDGE_REFRESH_DAYS * 24 * 60 * 60 * 1000;

// Adds or refreshes learned entries; the least used, oldest ones make room when the list is full.
export function storeKnowledge(entries: AssistantKnowledge[] = [], learned: AssistantKnowledge[], used: string[] = []): AssistantKnowledge[] {
  const usedIds = new Set(used);
  let next = entries.map((entry) => usedIds.has(entry.id) ? { ...entry, uses: (entry.uses ?? 0) + 1 } : entry);
  for (const entry of learned) {
    next = next.filter((item) => fold(item.title) !== fold(entry.title) && fold(item.topic) !== fold(entry.topic));
    next.push(entry);
  }
  if (next.length <= MAX_ASSISTANT_KNOWLEDGE) return next;
  const weight = (entry: AssistantKnowledge) => (entry.rejected ? -5 : 0) + (entry.votes ?? 0) * 3 + (entry.uses ?? 0);
  const keep = new Set([...next].sort((a, b) => weight(b) - weight(a) || b.at - a.at).slice(0, MAX_ASSISTANT_KNOWLEDGE).map((entry) => entry.id));
  return next.filter((entry) => keep.has(entry.id));
}

// Splits at sentence ends only; abbreviations such as "z. B.", "d.o.o." or "bzw." do not end a sentence.
const sentences = (text: string, count: number) => {
  const parts: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?](?=\s+[A-ZÄÖÜ„"(])/g)) {
    const end = match.index + 1;
    const word = text.slice(start, end).match(/(\S+)$/)?.[1] ?? "";
    if (/^(?:\S{1,3}|\S*\.\S*)\.$/.test(word) || /^(?:bzw|engl|lat|vgl|etc|usw|inkl|exkl|ggf|evtl|bspw|sog)\.$/i.test(word)) continue;
    parts.push(text.slice(start, end).trim());
    start = end;
  }
  if (start < text.length && text.slice(start).trim()) parts.push(text.slice(start).trim());
  let result = "";
  for (const part of parts.slice(0, count)) {
    if (result && result.length + part.length > 700) break;
    result = result ? `${result} ${part}` : part;
  }
  return result || text.slice(0, 700);
};
const learnedDate = (at: number) => new Date(at).toLocaleDateString("de-AT");
const isAustrian = (entry: AssistantKnowledge) => /österreich|oesterreich/i.test(`${entry.title} ${entry.text}`);

// Builds the answer from looked-up encyclopedia text only; numbers in it come from the source, not from the model.
export function knowledgeAnswer(input: string, found: AssistantKnowledge[], options: { fresh?: string[]; offline?: boolean } = {}): Result {
  const topics = knowledgeTopics(input, [], true);
  if (!found.length) return {
    text: options.offline
      ? `Zu „${topics.join("“ und „") || "dem Begriff"}“ habe ich noch nichts gelernt, und gerade komme ich nicht ins Internet. Versuch es bitte gleich noch einmal.`
      : `Zu „${topics.join("“ und „") || "dem Begriff"}“ habe ich nichts Verlässliches gefunden. Ich erkläre Begriffe rund um Geld, Steuern, Versicherungen und Verträge – magst du ihn etwas anders schreiben?`,
    suggestions: ["Was ist ein ETF?", "Was hast du gelernt?"],
  };
  const fresh = new Set(options.fresh ?? []);
  const lines: Line[] = found.map((entry) => ({
    label: entry.title.slice(0, 200),
    detail: `${fresh.has(entry.id) ? "gerade gelernt" : `gelernt am ${learnedDate(entry.at)}`} · ${entry.source}`.slice(0, 300),
    tone: "info" as const,
  }));
  // Asides like "(englisch exchange-traded fund, ETF)" make encyclopedia text hard to read in a chat.
  const plain = (text: string) => text.replace(/\s*\([^()]{0,160}\)/g, "").replace(/\s+([,.])/g, "$1");
  const text = found.length === 1 ? sentences(plain(found[0].text), 2)
    : found.map((entry) => `${entry.title}: ${sentences(plain(entry.text), 2)}`).join("\n\n");
  const austrianHint = found.some(isAustrian) ? "" : " Regeln in Österreich können abweichen.";
  const learnedNow = found.some((entry) => fresh.has(entry.id));
  return {
    text: text.slice(0, 1900),
    card: { kind: "answer", title: found.length === 1 ? found[0].title.slice(0, 120) : `${found[0].title} vs. ${found[1].title}`.slice(0, 120), lines,
      note: (`${learnedNow ? "Eben im Internet nachgeschlagen und gemerkt; nächstes Mal antworte ich sofort, auch offline." : "Aus meinem gelernten Wissen, ohne neue Internetabfrage."} ` +
        `Quelle: ${found.map((entry) => entry.url).join(" · ")}.${austrianHint} Allgemeine Info, keine Steuer- oder Anlageberatung.`).slice(0, 400) },
    suggestions: [...followUpsFor(found), "Was hast du gelernt?"].slice(0, 3),
  };
}

function followUpsFor(found: AssistantKnowledge[]): string[] {
  const words = fold(found.map((entry) => `${entry.title} ${entry.text.slice(0, 300)}`).join(" "));
  if (/\b(?:fonds|etf|aktie\w*|anleihe\w*|boerse\w*)\b/.test(words)) return ["100 € im Monat in einen ETF, was habe ich nach 10 Jahren?"];
  if (/\b(?:zins\w*|tagesgeld|festgeld|spareinlage\w*|sparbuch)\b/.test(words)) return ["Welche Zinsen bekomme ich fürs Sparkonto?"];
  if (/\b(?:steuer\w*|veranlagung|werbungskosten|absetz\w*)\b/.test(words)) return ["Was kann ich bei der Arbeitnehmerveranlagung absetzen?"];
  if (/\b(?:inflation|preis\w*|kaufkraft)\b/.test(words)) return ["Wie hoch ist die Inflation gerade?"];
  return ["Wie stehe ich finanziell da?"];
}

// "Was hast du gelernt?": everything learned by itself, visible and deletable under „Gedächtnis“.
export function knowledgeList(state: AppState): Result {
  const entries = [...(state.assistantKnowledge ?? [])].sort((a, b) => b.at - a.at);
  const phrases = state.assistantPhrases ?? [];
  const aliases = state.assistantAliases ?? [];
  const gaps = (state.assistantGaps ?? []).filter((gap) => !gap.resolved).sort((a, b) => b.count - a.count);
  const solved = (state.assistantGaps ?? []).filter((gap) => gap.resolved).length;
  if (!entries.length && !phrases.length && !aliases.length && !gaps.length) return {
    text: "Bisher habe ich noch nichts selbst dazugelernt. Frag mich zum Beispiel „Was ist ein ETF?“; dann schlage ich es nach und merke es mir. " +
      "Formulierungen, die nur die KI verstanden hat, lerne ich auch nebenbei.",
    suggestions: ["Was ist ein ETF?", "Was bedeutet KESt?"],
  };
  const lines: Line[] = entries.slice(0, 30).map((entry) => ({ label: entry.title.slice(0, 200), tone: entry.rejected ? "warn" as const : "info" as const,
    detail: (entry.kind === "web" ? webDetail(entry) : `gefragt als „${entry.topic}“ · ${learnedDate(entry.at)}${entry.uses ? ` · ${entry.uses}× wieder genutzt` : ""}`).slice(0, 300) }));
  if (phrases.length) lines.push({ label: `${phrases.length} gelernte Formulierung${phrases.length === 1 ? "" : "en"}`, tone: "good",
    detail: "verstehe ich jetzt sofort, ohne die KI zu fragen" });
  for (const alias of aliases.slice(-8)) lines.push({ label: `„${alias.from}“ = „${alias.to}“`.slice(0, 200), tone: "good",
    detail: `deine Bezeichnung${alias.hits ? ` · ${alias.hits}× genutzt` : ""}` });
  if (solved) lines.push({ label: `${solved} anfangs unklare Frage${solved === 1 ? "" : "n"} gelöst`, tone: "good", detail: "durch deine Korrektur oder später nachgelernt" });
  for (const gap of gaps.slice(0, 5)) lines.push({ label: `Noch offen: „${gap.text}“`.slice(0, 200), tone: "warn",
    detail: `${gap.count}× gefragt · schreib „Nein, ich meinte …“, dann lerne ich es` });
  const confirmed = entries.filter((entry) => entry.kind === "web" && !entry.rejected).length;
  const terms = entries.filter((entry) => entry.kind !== "web").length;
  return {
    text: `Ich habe mir ${terms} Begriff${terms === 1 ? "" : "e"} aus dem Internet gemerkt` +
      (confirmed ? ` und ${confirmed} von dir bestätigte Antwort${confirmed === 1 ? "" : "en"} aus der Websuche` : "") +
      (phrases.length ? `, ${phrases.length} deiner Formulierungen gelernt` : "") + (aliases.length ? `, ${aliases.length} deiner eigenen Bezeichnungen übernommen` : "") +
      "." + (gaps.length ? ` ${gaps.length} Frage${gaps.length === 1 ? " verstehe" : "n verstehe"} ich noch nicht; mit deiner Korrektur lerne ich sie.` : "") + " Alles liegt nur in deiner Datenbank; unter „Gedächtnis“ kannst du es einsehen und löschen.",
    card: { kind: "memory", title: "Was ich dazugelernt habe", lines: lines.slice(0, 40),
      note: "Begriffe kommen aus der deutschsprachigen Wikipedia (CC BY-SA 4.0) und werden nach 90 Tagen aufgefrischt; Antworten aus der Websuche merke ich mir erst nach deinem 👍." },
    suggestions: ["Was ist ein ETF?", "Was bedeutet KESt?"],
  };
}

const webDetail = (entry: AssistantKnowledge) => entry.rejected
  ? `abgelehnt · wird nicht mehr vorgeschlagen${entry.note ? ` · dein Hinweis: „${entry.note.slice(0, 120)}“` : ""}`
  : `bestätigte Websuche · ${learnedDate(entry.at)} · ${entry.votes ?? 1}× 👍${entry.uses ? ` · ${entry.uses}× wieder genutzt` : ""}`;

// Stored knowledge relevant to a free question, so grounded answers can use it everywhere; rejected answers never.
export function relevantKnowledge(all: AssistantKnowledge[] = [], input: string, limit = 2): AssistantKnowledge[] {
  const words = new Set(fold(input).split(" ").filter((word) => word.length >= 3));
  const entries = all.filter((entry) => !entry.rejected);
  return entries.map((entry) => ({ entry, score: fold(`${entry.topic} ${entry.title}`).split(" ").filter((word) => words.has(word)).length }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((item) => item.entry);
}

// Learned phrasings: amounts become "#", so "Geht sich 900 € aus?" also matches "Geht sich 1.200 € aus?".
export function phrasePattern(input: string): string {
  return fold(normalizeMessage(input)).replace(/\d+(?: \d{3})*(?: \d{1,2}\b)?/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
}
export function matchPhrase(phrases: AssistantPhrase[] = [], input: string): AssistantPhrase | undefined {
  const pattern = phrasePattern(input);
  return pattern.split(" ").length >= 2 ? phrases.find((phrase) => phrase.pattern === pattern) : undefined;
}
export function learnPhrase(phrases: AssistantPhrase[] = [], input: string, tool: string, now = Date.now()): AssistantPhrase[] {
  const pattern = phrasePattern(input);
  if (pattern.split(" ").length < 2 || pattern.length < 6) return phrases;
  const existing = phrases.find((phrase) => phrase.pattern === pattern);
  if (existing?.tool === tool) return phrases.map((phrase) => phrase === existing ? { ...phrase, hits: (phrase.hits ?? 0) + 1, at: now } : phrase);
  return [...phrases.filter((phrase) => phrase.pattern !== pattern), { pattern, tool: tool.slice(0, 40), at: now }].slice(-MAX_ASSISTANT_PHRASES);
}
