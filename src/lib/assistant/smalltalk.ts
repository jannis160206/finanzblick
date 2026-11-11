import type { AgentResult } from "./agent";
import { normalizeMessage } from "./normalize";

export const starterSuggestions = [
  "Wie viel hab ich diesen Monat ausgegeben?",
  "Gib mir den Wochenüberblick",
  "Kann ich mir im Mai 900 € leisten?",
];

type Kind = "thanks" | "bye" | "mood" | "who" | "maker" | "greet" | "ack" | "unclear" | "unsure" | "time" | "date" | "joke";
// Order matters: longer phrases first, so "guten morgen" is not split into words.
const phrases: [Kind, RegExp][] = [
  ["thanks", /\b(vielen|tausend) dank\b|\bdanke(sch(ö|oe)n| sehr| dir)?\b|\bmerci\b|\bthx\b|\bthanks\b|\b(das|es) hilft( mir)?( sehr| weiter)?\b|\bhat (mir )?(sehr )?geholfen\b|\bsehr hilfreich\b/g],
  ["bye", /\btsch(ü|ue)ss?\b|\bciao\b|\bbaba\b|\bbye\b|\bbis (dann|sp(ä|ae)ter|bald|morgen)\b|\bgute nacht\b|\bsch(ö|oe)nen (tag|abend)( noch)?\b/g],
  ["mood", /\bwie geht'?s( (dir|so|euch))?\b|\bwie geht es (dir|ihnen)\b|\bwie l(ä|ae)uft'?s\b|\balles (gut|klar) bei dir\b|\bwas geht ab\b/g],
  ["maker", /\bwer hat (dich|finanzblick|die app|diese app) (gebaut|gemacht|entwickelt|programmiert|erfunden|erstellt|trainiert)\b|\bwer steckt hinter dir\b|\bvon wem (bist|kommst) du\b|\bwelches (ki-?)?modell bist du\b|\bwas f(ü|ue)r ein (ki-?)?modell bist du\b/g],
  ["who", /\bwer bist du\b|\bwas bist du\b|\bbist du (?:eine |ein )?(?:echte |echter )?(?:ki|bot|chatbot|roboter|mensch|computer|chatgpt)\b/g],
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

const dateQuestion = /^(?:und\s+)?(?:was ist heute für ein tag|was für ein tag ist heute|welcher (?:wochen)?tag ist heute|welchen tag haben wir(?: heute)?|welches datum (?:ist|haben wir)(?: heute)?|der wievielte ist heute|was haben wir heute für ein datum)\s*\??$/;
// A generic joke request gets a tried joke; "einen Witz über Katzen" stays with the model.
const jokeRequest = /^(?:(?:erzähl|erzaehl|sag|kennst du)\w*\s+(?:mir\s+)?(?:mal\s+)?(?:noch\s+)?(?:einen|nen|'nen|ein|was|etwas)\s+(?:guten\s+|kurzen\s+|lustigen\s+)?(?:witz|scherz|flachwitz|lustiges)|bring mich zum lachen|(?:noch\s+)?(?:einen|ein) witz(?:\s+bitte)?)\s*[.!?]*$/;
const jokes = [
  "Treffen sich zwei Euro. Fragt der eine: „Lange nicht gesehen – wo warst du?“ Sagt der andere: „Auf dem Sparkonto. Da kommt man so schwer wieder raus.“",
  "Warum nehmen Sparschweine nie ab? Weil sie ständig gefüttert werden. 🐷",
  "Mein Kontostand und ich haben etwas gemeinsam: Gegen Monatsende sind wir beide ein bisschen erschöpft.",
  "Sagt das Gehalt zum Konto: „Ich bleib nicht lange.“ Sagt das Konto: „Ich weiß – die Miete wartet schon draußen.“",
  "Was macht ein Sparfuchs im Supermarkt? Er geht nur hinein, um sich die Preise anzuschauen – und kommt mit Bananen um 4,99 € wieder raus.",
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
  if (timeQuestion.test(normalizeMessage(input).toLowerCase().trim())) return "time";
  if (dateQuestion.test(normalizeMessage(input).toLowerCase().trim())) return "date";
  if (jokeRequest.test(normalizeMessage(input).toLowerCase().trim())) return "joke";
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
    case "who": if (/\b(?:ki|bot|chatbot|roboter|mensch|computer|chatgpt)\b/.test(input.toLowerCase())) return {
      text: `${/\bmensch\b/.test(input.toLowerCase()) ? "Nein, ich bin kein Mensch, sondern eine KI" : "Ja, ich bin eine KI"} – ein kleines Sprachmodell, das lokal auf deinem Rechner läuft. ` +
        "Die Zahlen rechnet Finanzblick selbst nach festen Regeln; ich formuliere nur.",
      suggestions: ["Was kannst du alles?", ...starterSuggestions.slice(0, 2)] };
    return { text: "Ich bin Finanzblick, dein Finanz-Assistent. Ich laufe lokal auf deinem Rechner, kenne deine Buchungen, Verträge, " +
      "dein Budget und dein Gehalt und rechne damit für dich – plaudern geht aber genauso. Geändert wird nur, wenn du bestätigst.",
    suggestions: ["Was kannst du alles?", ...starterSuggestions.slice(0, 2)] };
    case "ack": return { text: pick(["Alles klar!", "Passt. Sag Bescheid, wenn du noch was brauchst."]) };
    case "maker": return { text: "Ich bin der Assistent von Finanzblick, einer selbst gehosteten Finanz-App. Formulieren tut ein kleines Sprachmodell, " +
      "das lokal auf deinem Rechner läuft; die Zahlen rechnet die App selbst nach festen Regeln. Deine Daten verlassen den Rechner nicht.",
    suggestions: ["Was kannst du alles?", ...starterSuggestions.slice(0, 2)] };
    case "unsure": return { text: pick(["Kein Problem. Magst du mit etwas Einfachem starten?", "Macht nichts – such dir einfach was aus, oder frag drauflos."]),
      suggestions: starterSuggestions };
    case "time": {
      const place = timeQuestion.exec(normalizeMessage(input).toLowerCase().trim())?.[1]?.replace(/[?!.]+$/, "").trim();
      const zone = place ? zones.find(([pattern]) => pattern.test(place)) : undefined;
      if (place && !zone) return { text: `Die genaue Uhrzeit in ${place.charAt(0).toUpperCase()}${place.slice(1)} kenne ich nicht – die Weltuhr am Handy weiß es sicher.` };
      const clock = new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", ...(zone ? { timeZone: zone[1] } : {}) }).format(now);
      return { text: zone ? `In ${zone[2]} ist es gerade ${clock} Uhr.` : `Es ist gerade ${clock} Uhr.` };
    }
    case "date": return { text: `Heute ist ${new Intl.DateTimeFormat("de-AT", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now).replace(/, (\d)/, ", der $1")}.` };
    case "joke": return { text: pick(jokes), suggestions: ["Erzähl mir noch einen Witz", ...starterSuggestions.slice(0, 2)] };
    case "unclear": return { text: pick(["Da komm ich gerade nicht ganz mit. Was möchtest du wissen?",
      "Hm, das hab ich nicht verstanden. Magst du's mir in ein paar Worten sagen?"]), suggestions: starterSuggestions };
  }
}

