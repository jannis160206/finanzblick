import { contentWords } from "@/lib/knowledge-base/query";
import { currentInfo, currentSubject } from "./current-info";
import { foldText } from "./public-facts";

/**
 * Keeping follow-up questions on topic: the words a question, its answer and a suggestion share, and fixed fallback
 * questions built from the subject of the question, for when DeepSeek is not available. Pure: used by server and chat.
 */

// Words that say when, not what; they make no topic.
const timeWords = new Set(["aktue", "heute", "gerad", "jetzt", "derze", "momen", "zurze", "letzt", "tagen", "monat", "woche", "jahre"]);
// Different words for the same thing count as one topic.
const synonyms: [RegExp, string][] = [
  [/^(?:kurs|preis|wert|steht|notie|koste)/, "preis"], [/^(?:abo|abos|abonn|vertr)/, "vertrag"], [/^(?:ausga|zahle|bezah)/, "ausgabe"],
  [/^(?:sparz|ziel)/, "sparziel"], [/^(?:gehal|lohn|netto|brutt)/, "gehalt"], [/^(?:konto|konte|guthab)/, "konto"],
];

/** The topic of a text as short word stems: no filler, no time words, synonyms merged. */
export function topicStems(text: string): Set<string> {
  const stems = new Set<string>();
  // Filler words are dropped before folding, so "für" and "über" never count as a topic.
  for (const word of contentWords(text).map(foldText)) {
    if (word.length < 3 || /^\d+$/.test(word)) continue;
    const stem = word.slice(0, 5);
    if (timeWords.has(stem)) continue;
    stems.add(synonyms.find(([pattern]) => pattern.test(stem))?.[1] ?? stem);
  }
  return stems;
}

/** Whether a suggested question stays with what was just asked and answered. */
export function onTopic(suggestion: string, topic: Set<string>): boolean {
  return [...topicStems(suggestion)].some((stem) => topic.has(stem));
}

/**
 * Fixed follow-ups about the same subject: the price history after a quote, the next headlines after news, the effect on
 * the user's money after an explanation. Empty when the question names no subject.
 */
export function topicFollowUps(question: string): string[] {
  const live = currentInfo(question);
  const subject = (live?.subject ?? currentSubject(question)).replace(/[?!.]+$/, "").trim();
  if (!subject || subject.length < 3 || subject.split(" ").length > 3) return [];
  if (live?.kind === "quote") return [`Wie hat sich ${subject} in den letzten 30 Tagen entwickelt?`, `Was beeinflusst den Preis von ${subject} gerade?`,
    `Wie viel ${subject} passt zu meinem Budget?`];
  if (live?.kind === "news") return [`Was bedeutet das für meine Finanzen?`, `Gibt es weitere Nachrichten zu ${subject}?`];
  if (live) return [`Wie hat sich ${subject} zuletzt verändert?`, `Was bedeutet ${subject} für mein Budget?`];
  return [`Erklär mir ${subject} genauer`, `Was bedeutet ${subject} für meine Finanzen?`];
}
