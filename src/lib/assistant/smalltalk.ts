import type { AgentResult } from "./agent";
import { normalizeMessage } from "./normalize";

export const starterSuggestions = [
  "Wie viel hab ich diesen Monat ausgegeben?",
  "Gib mir den Wochenüberblick",
  "Kann ich mir im Mai 900 € leisten?",
];

type Kind = "thanks" | "bye" | "mood" | "who" | "maker" | "greet" | "ack" | "unclear" | "unsure";
// Order matters: longer phrases first, so "guten morgen" is not split into words.
const phrases: [Kind, RegExp][] = [
  ["thanks", /\b(vielen|tausend) dank\b|\bdanke(sch(ö|oe)n| sehr| dir)?\b|\bmerci\b|\bthx\b|\bthanks\b|\b(das|es) hilft( mir)?( sehr| weiter)?\b|\bhat (mir )?(sehr )?geholfen\b|\bsehr hilfreich\b/g],
  ["bye", /\btsch(ü|ue)ss?\b|\bciao\b|\bbaba\b|\bbye\b|\bbis (dann|sp(ä|ae)ter|bald|morgen)\b|\bgute nacht\b|\bsch(ö|oe)nen (tag|abend)( noch)?\b/g],
  ["mood", /\bwie geht'?s( (dir|so|euch))?\b|\bwie geht es (dir|ihnen)\b|\bwie l(ä|ae)uft'?s\b|\balles (gut|klar) bei dir\b|\bwas geht ab\b|\bwie war dein (tag|wochenende|morgen|abend)( so)?\b|\bwas machst du (so|gerade)\b/g],
  ["maker", /\bwer hat (dich|finanzblick|die app|diese app) (gebaut|gemacht|entwickelt|programmiert|erfunden|erstellt|trainiert)\b|\bwer steckt hinter dir\b|\bvon wem (bist|kommst) du\b|\bwelches (ki-?)?modell bist du\b|\bwas f(ü|ue)r ein (ki-?)?modell bist du\b/g],
  ["who", /\bwer bist du\b|\bwas bist du\b|\bbist du (?:eine |ein )?(?:echte |echter )?(?:ki|bot|chatbot|roboter|mensch|computer|chatgpt)\b/g],
  ["greet", /\bhall(o|öchen|oechen)\b|\bhi+\b|\bhey+\b|\bhe+y\b|\bservus\b|\bmoin\b|\bgr(ü|ue)(ß|ss) (gott|dich|di)\b|\bgria(ß|ss) di\b|\bguten (morgen|tag|abend)\b|\bmorgen\b|\bna\b|\byo\b|\bheyho\b/g],
  ["ack", /\b(ok(ay)?|passt( schon)?|super|cool|alles klar|perfekt|gut|sehr gut|nice|top|toll|genial|verstanden|ja|nein|ne|nö|jo|alright)\b/g],
];
// "???", "hmm", "asdfgh": nothing to answer yet, so ask back instead of guessing.
const unclear = (text: string) => {
  const plain = text.trim().toLowerCase();
  if (plain.length >= 2 && !/[\p{L}\p{N}]/u.test(plain)) return true;
  const word = plain.replace(/[^\p{L}]+/gu, "");
  return word === plain.replace(/[\s.!?…]+/g, "") && (/^(?:h+m+|ä+h*m*|ö+h+m*|e+h*m+|hä+h?|h+u+h+)$/.test(word) ||
    word.length >= 5 && (!/[aeiouäöüy]/.test(word) || /^[asdfghjklöä]+$/.test(word) || /^[yxcvbnm]+$/.test(word)));
};
const filler = /\b(du|dir|ihr|lieber|liebe|mein|meine|assistent|bot|finanz|nochmal|noch|mal|sag|auch|so|und|aber|echt|wirklich|ganz|dann|erstmal|eigentlich)\b/g;

// Recognises messages that are only small talk ("Hallo!", "Danke dir 🙂", "Wie geht's?") so the assistant can answer like a person.
export function detectSmallTalk(input: string): Kind | undefined {
  if (unclear(normalizeMessage(input))) return "unclear";
  const plain = normalizeMessage(input).toLowerCase().trim();
  // "Na, alles gut?" asks how it is going; "Alles gut, danke" is only an acknowledgement.
  if (/^(?:na,?\s+)?(?:alles (?:gut|klar|fit|okay|ok|easy|roger)|wie läuft'?s)(?: bei dir)?\s*\?+$/.test(plain)) return "mood";
  if (/^(?:ich weiß (?:es )?(?:auch )?nicht|weiß nicht|keine ahnung|k\.?\s?a\.?|egal|ich hab keine idee|keine idee|mach (?:du )?mal|leg los|los geht'?s|und (?:jetzt|nun))[.!?]*$/.test(plain)) return "unsure";
  if (/^(?:und\s+)?(?:wie ?viel|was)\s*\?+$/.test(plain)) return "unclear";
  let rest = normalizeMessage(input).toLowerCase().replace(/[’`´]/g, "'").replace(/[\p{Extended_Pictographic}\u{FE0F}:;()\-^_*~.!?,…"„“]+/gu, " ")
    .replace(/(^| )'|'( |$)/g, " ").replace(/\s+/g, " ").trim();
  if (!rest || rest.length > 80 || /\d/.test(rest)) return undefined;
  const found = new Set<Kind>();
  for (const [kind, pattern] of phrases) rest = rest.replace(pattern, () => { found.add(kind); return " "; });
  if (rest.replace(filler, " ").trim()) return undefined;
  return (["thanks", "bye", "mood", "maker", "who", "greet", "ack"] as const).find((kind) => found.has(kind));
}

const daytime = (hour: number) => hour < 11 ? "Guten Morgen" : hour >= 18 ? "Guten Abend" : "Hallo";

export function smallTalk(input: string, { hour, seed = input.length }: { hour: number; seed?: number; now?: Date }): AgentResult | undefined {
  const kind = detectSmallTalk(input);
  if (!kind) return undefined;
  const pick = (options: string[]) => options[seed % options.length];
  // The general chat agent's instant replies: short and warm like in a normal chat, no model call needed.
  switch (kind) {
    case "greet": return { text: `${daytime(hour)}! ${pick(["Was liegt an?", "Schön, dass du da bist. Was möchtest du wissen?",
      "Womit fangen wir an – Geldfrage oder kurzer Plausch?"])}`, suggestions: starterSuggestions };
    case "mood": return { text: pick(["Danke, mir geht's gut! Und dir? Wenn du magst, schau ich kurz, wie dein Monat läuft.",
      "Bestens, danke der Nachfrage. Was kann ich für deine Finanzen tun?"]), suggestions: starterSuggestions };
    case "thanks": return { text: pick(["Gern geschehen! Sag einfach, wenn noch was ist.", "Sehr gern. Freut mich, wenn's geholfen hat.",
      "Immer gern!"]) };
    case "bye": return { text: pick(["Bis bald, mach's gut!", "Ciao, schönen Tag noch! Deine Daten bleiben hier auf deinem Rechner."]) };
    case "who": if (/\b(?:ki|bot|chatbot|roboter|mensch|computer|chatgpt)\b/.test(input.toLowerCase())) return {
      text: `${/\bmensch\b/.test(input.toLowerCase()) ? "Nein, ich bin kein Mensch, sondern eine KI" : "Ja, ich bin eine KI"} – ein kleines Sprachmodell, das lokal auf deinem Rechner läuft. ` +
        "Die Zahlen rechnet Finanzblick selbst nach festen Regeln; ich formuliere nur.",
      suggestions: ["Was kannst du alles?", ...starterSuggestions.slice(0, 2)] };
    return { text: "Ich bin Finanzblick, dein Finanz-Assistent. Ich laufe lokal auf deinem Rechner, kenne deine Buchungen, Verträge, " +
      "dein Budget und dein Gehalt, rechne damit für dich und erledige Änderungen in der App. Geändert wird nur, wenn du bestätigst.",
    suggestions: ["Was kannst du alles?", ...starterSuggestions.slice(0, 2)] };
    case "ack": return { text: pick(["Alles klar!", "Passt. Sag Bescheid, wenn du noch was brauchst."]) };
    case "maker": return { text: "Ich bin der Assistent von Finanzblick, einer selbst gehosteten Finanz-App. Formulieren tut ein kleines Sprachmodell, " +
      "das lokal auf deinem Rechner läuft; die Zahlen rechnet die App selbst nach festen Regeln. Deine Daten verlassen den Rechner nicht.",
    suggestions: ["Was kannst du alles?", ...starterSuggestions.slice(0, 2)] };
    case "unsure": return { text: pick(["Kein Problem. Magst du mit etwas Einfachem starten?", "Macht nichts – such dir einfach was aus, oder frag drauflos."]),
      suggestions: starterSuggestions };
    case "unclear": return { text: pick(["Da komm ich gerade nicht ganz mit. Was möchtest du wissen?",
      "Hm, das hab ich nicht verstanden. Magst du's mir in ein paar Worten sagen?"]), suggestions: starterSuggestions };
  }
}

