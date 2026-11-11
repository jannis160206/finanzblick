import type { AgentResult } from "./agent";
import { normalizeMessage } from "./normalize";

export const starterSuggestions = [
  "Wie viel hab ich diesen Monat ausgegeben?",
  "Gib mir den Wochenüberblick",
  "Kann ich mir im Mai 900 € leisten?",
];

type Kind = "thanks" | "bye" | "mood" | "who" | "greet" | "ack" | "unclear" | "time";
// Order matters: longer phrases first, so "guten morgen" is not split into words.
const phrases: [Kind, RegExp][] = [
  ["thanks", /\b(vielen|tausend) dank\b|\bdanke(sch(ö|oe)n| sehr| dir)?\b|\bmerci\b|\bthx\b|\bthanks\b/g],
  ["bye", /\btsch(ü|ue)ss?\b|\bciao\b|\bbaba\b|\bbye\b|\bbis (dann|sp(ä|ae)ter|bald|morgen)\b|\bgute nacht\b|\bsch(ö|oe)nen (tag|abend)( noch)?\b/g],
  ["mood", /\bwie geht'?s( (dir|so|euch))?\b|\bwie geht es (dir|ihnen)\b|\bwie l(ä|ae)uft'?s\b|\balles (gut|klar) bei dir\b|\bwas geht ab\b/g],
  ["who", /\bwer bist du\b|\bwas bist du\b|\bbist du (eine )?(ki|ein bot|ein mensch)\b/g],
  ["greet", /\bhall(o|öchen|oechen)\b|\bhi+\b|\bhey+\b|\bhe+y\b|\bservus\b|\bmoin\b|\bgr(ü|ue)(ß|ss) (gott|dich|di)\b|\bgria(ß|ss) di\b|\bguten (morgen|tag|abend)\b|\bmorgen\b|\bna\b|\byo\b|\bheyho\b/g],
  ["ack", /\b(ok(ay)?|passt( schon)?|super|cool|alles klar|perfekt|gut|sehr gut|nice|top|toll|genial|verstanden|ja|nein|ne|nö|jo|alright)\b/g],
];
// "Wie spät ist es in Tokio?": answered from the clock, never guessed by the model.
const timeQuestion = /^(?:und\s+)?(?:wie spät ist es|wie viel uhr ist es|wieviel uhr ist es|wie viel uhr haben wir|was ist die uhrzeit|uhrzeit)(?:\s+(?:gerade|jetzt|aktuell))?(?:\s+in\s+(.{2,30}?))?\s*\??$/;
const zones: [RegExp, string, string][] = [
  [/tokio|tokyo|japan/, "Asia/Tokyo", "Tokio"], [/new york|nyc|ostküste/, "America/New_York", "New York"],
  [/los angeles|kalifornien|san francisco|westküste/, "America/Los_Angeles", "Los Angeles"], [/london|england|großbritannien/, "Europe/London", "London"],
  [/sydney|australien/, "Australia/Sydney", "Sydney"], [/peking|beijing|shanghai|china/, "Asia/Shanghai", "Peking"], [/dubai/, "Asia/Dubai", "Dubai"],
  [/bangkok|thailand/, "Asia/Bangkok", "Bangkok"], [/singapur|singapore/, "Asia/Singapore", "Singapur"], [/indien|mumbai|delhi/, "Asia/Kolkata", "Indien"],
  [/wien|österreich|berlin|deutschland|paris|rom|madrid|zürich|schweiz/, "Europe/Vienna", "Mitteleuropa"],
];

// "???", "hmm", "asdfgh": nothing to answer yet, so ask back instead of guessing.
const unclear = (text: string) => {
  const plain = text.trim().toLowerCase();
  if (plain.length >= 2 && !/[\p{L}\p{N}]/u.test(plain)) return true;
  const word = plain.replace(/[^\p{L}]+/gu, "");
  return word === plain.replace(/[\s.!?…]+/g, "") && (/^(?:h+m+|ä+h*m*|ö+h+m*|e+h*m+|hä+h?|h+u+h+)$/.test(word) ||
    word.length >= 5 && (!/[aeiouäöüy]/.test(word) || /^[asdfghjklöä]+$/.test(word) || /^[yxcvbnm]+$/.test(word)));
};
const filler = /\b(du|dir|ihr|lieber|liebe|mein|meine|assistent|bot|finanz|nochmal|noch|mal|auch|so|und|aber|echt|wirklich|ganz|dann|erstmal)\b/g;

// Recognises messages that are only small talk ("Hallo!", "Danke dir 🙂", "Wie geht's?") so the assistant can answer like a person.
export function detectSmallTalk(input: string): Kind | undefined {
  if (unclear(normalizeMessage(input))) return "unclear";
  if (timeQuestion.test(normalizeMessage(input).toLowerCase().trim())) return "time";
  let rest = normalizeMessage(input).toLowerCase().replace(/[’`´]/g, "'").replace(/[\p{Extended_Pictographic}\u{FE0F}:;()\-^_*~.!?,…"„“]+/gu, " ")
    .replace(/(^| )'|'( |$)/g, " ").replace(/\s+/g, " ").trim();
  if (!rest || rest.length > 80 || /\d/.test(rest)) return undefined;
  const found = new Set<Kind>();
  for (const [kind, pattern] of phrases) rest = rest.replace(pattern, () => { found.add(kind); return " "; });
  if (rest.replace(filler, " ").trim()) return undefined;
  return (["thanks", "bye", "mood", "who", "greet", "ack"] as const).find((kind) => found.has(kind));
}

const daytime = (hour: number) => hour < 11 ? "Guten Morgen" : hour >= 18 ? "Guten Abend" : "Hallo";

export function smallTalk(input: string, { hour, seed = input.length, now = new Date() }: { hour: number; seed?: number; now?: Date }): AgentResult | undefined {
  const kind = detectSmallTalk(input);
  if (!kind) return undefined;
  const pick = (options: string[]) => options[seed % options.length];
  // The general chat agent's instant replies: short and warm like in a normal chat, no model call needed.
  switch (kind) {
    case "greet": return { text: `${daytime(hour)}! ${pick(["Was liegt an?", "Schön, dass du da bist. Was möchtest du wissen?",
      "Womit fangen wir an – Geldfrage oder kurzer Plausch?"])}`, suggestions: starterSuggestions };
    case "mood": return { text: pick(["Danke, mir geht's gut! Und dir? Wenn du magst, schau ich kurz, wie dein Monat läuft.",
      "Bestens, danke der Nachfrage. Was kann ich für dich tun?"]), suggestions: starterSuggestions };
    case "thanks": return { text: pick(["Gern geschehen! Sag einfach, wenn noch was ist.", "Sehr gern. Freut mich, wenn's geholfen hat.",
      "Immer gern!"]) };
    case "bye": return { text: pick(["Bis bald, mach's gut!", "Ciao, schönen Tag noch! Deine Daten bleiben hier auf deinem Rechner."]) };
    case "who": return { text: "Ich bin Finanzblick, dein Finanz-Assistent. Ich laufe lokal auf deinem Rechner, kenne deine Buchungen, Verträge, " +
      "dein Budget und dein Gehalt und rechne damit für dich – plaudern geht aber genauso. Geändert wird nur, wenn du bestätigst.",
    suggestions: ["Was kannst du alles?", ...starterSuggestions.slice(0, 2)] };
    case "ack": return { text: pick(["Alles klar!", "Passt. Sag Bescheid, wenn du noch was brauchst."]) };
    case "time": {
      const place = timeQuestion.exec(normalizeMessage(input).toLowerCase().trim())?.[1]?.replace(/[?!.]+$/, "").trim();
      const zone = place ? zones.find(([pattern]) => pattern.test(place)) : undefined;
      if (place && !zone) return { text: `Die genaue Uhrzeit in ${place.charAt(0).toUpperCase()}${place.slice(1)} kenne ich nicht – die Weltuhr am Handy weiß es sicher.` };
      const clock = new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", ...(zone ? { timeZone: zone[1] } : {}) }).format(now);
      return { text: zone ? `In ${zone[2]} ist es gerade ${clock} Uhr.` : `Es ist gerade ${clock} Uhr.` };
    }
    case "unclear": return { text: pick(["Da komm ich gerade nicht ganz mit. Was möchtest du wissen?",
      "Hm, das hab ich nicht verstanden. Magst du's mir in ein paar Worten sagen?"]), suggestions: starterSuggestions };
  }
}

