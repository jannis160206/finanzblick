import type { AgentResult } from "./agent";
import { normalizeMessage } from "./normalize";

export const starterSuggestions = [
  "Wie viel hab ich diesen Monat ausgegeben?",
  "Gib mir den Wochenüberblick",
  "Kann ich mir im Mai 900 € leisten?",
];

type Kind = "thanks" | "bye" | "mood" | "who" | "greet" | "ack";
// Order matters: longer phrases first, so "guten morgen" is not split into words.
const phrases: [Kind, RegExp][] = [
  ["thanks", /\b(vielen|tausend) dank\b|\bdanke(sch(ö|oe)n| sehr| dir)?\b|\bmerci\b|\bthx\b|\bthanks\b/g],
  ["bye", /\btsch(ü|ue)ss?\b|\bciao\b|\bbaba\b|\bbye\b|\bbis (dann|sp(ä|ae)ter|bald|morgen)\b|\bgute nacht\b|\bsch(ö|oe)nen (tag|abend)( noch)?\b/g],
  ["mood", /\bwie geht'?s( (dir|so|euch))?\b|\bwie geht es (dir|ihnen)\b|\bwie l(ä|ae)uft'?s\b|\balles (gut|klar) bei dir\b|\bwas geht ab\b/g],
  ["who", /\bwer bist du\b|\bwas bist du\b|\bbist du (eine )?(ki|ein bot|ein mensch)\b/g],
  ["greet", /\bhall(o|öchen|oechen)\b|\bhi+\b|\bhey+\b|\bhe+y\b|\bservus\b|\bmoin\b|\bgr(ü|ue)(ß|ss) (gott|dich|di)\b|\bgria(ß|ss) di\b|\bguten (morgen|tag|abend)\b|\bmorgen\b|\bna\b|\byo\b|\bheyho\b/g],
  ["ack", /\b(ok(ay)?|passt( schon)?|super|cool|alles klar|perfekt|gut|sehr gut|nice|top|toll|genial|verstanden|ja|nein|ne|nö|jo|alright)\b/g],
];
const filler = /\b(du|dir|ihr|lieber|liebe|mein|meine|assistent|bot|finanz|nochmal|noch|mal|auch|so|und|aber|echt|wirklich|ganz|dann|erstmal)\b/g;

// Recognises messages that are only small talk ("Hallo!", "Danke dir 🙂", "Wie geht's?") so the assistant can answer like a person.
export function detectSmallTalk(input: string): Kind | undefined {
  let rest = normalizeMessage(input).toLowerCase().replace(/[’`´]/g, "'").replace(/[\p{Extended_Pictographic}\u{FE0F}:;()\-^_*~.!?,…"„“]+/gu, " ")
    .replace(/(^| )'|'( |$)/g, " ").replace(/\s+/g, " ").trim();
  if (!rest || rest.length > 80 || /\d/.test(rest)) return undefined;
  const found = new Set<Kind>();
  for (const [kind, pattern] of phrases) rest = rest.replace(pattern, () => { found.add(kind); return " "; });
  if (rest.replace(filler, " ").trim()) return undefined;
  return (["thanks", "bye", "mood", "who", "greet", "ack"] as const).find((kind) => found.has(kind));
}

const daytime = (hour: number) => hour < 11 ? "Guten Morgen" : hour >= 18 ? "Guten Abend" : "Hallo";

export function smallTalk(input: string, { hour, seed = input.length }: { hour: number; seed?: number }): AgentResult | undefined {
  const kind = detectSmallTalk(input);
  if (!kind) return undefined;
  const pick = (options: string[]) => options[seed % options.length];
  switch (kind) {
    case "greet": return { text: `${daytime(hour)}! ${pick(["Schön, dass du da bist. Wobei kann ich dir helfen?",
      "Was möchtest du heute über deine Finanzen wissen?", "Womit fangen wir an?"])}`, suggestions: starterSuggestions };
    case "mood": return { text: pick(["Mir geht's gut, danke! Ich hab deine Zahlen im Blick. Wie kann ich dir helfen?",
      "Danke der Nachfrage, alles bestens. Soll ich dir einen kurzen Überblick über diese Woche geben?"]), suggestions: starterSuggestions };
    case "thanks": return { text: pick(["Gern geschehen! Sag Bescheid, wenn ich noch etwas durchrechnen soll.", "Sehr gerne! Kann ich sonst noch etwas für dich tun?",
      "Immer wieder gern. Falls noch etwas ist, frag einfach."]) };
    case "bye": return { text: pick(["Bis bald! Deine Daten bleiben sicher auf deinem Gerät.", "Mach's gut, bis zum nächsten Mal!"]) };
    case "who": return { text: "Ich bin dein Finanz-Assistent. Ich laufe lokal auf deinem Rechner, kenne deine Buchungen, Sparziele und geplanten Ausgaben " +
      "und kann damit rechnen, planen und Dinge für dich einstellen. Geändert wird nur, wenn du bestätigst.", suggestions: ["Was kannst du alles?", ...starterSuggestions.slice(0, 2)] };
    case "ack": return { text: pick(["Alles klar. Was steht als Nächstes an?", "Passt! Sag einfach, wenn du noch etwas brauchst."]) };
  }
}
