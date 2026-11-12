import type { AgentResult } from "./agent";
import { normalizeMessage } from "./normalize";

/**
 * The assistant only helps with money and the app. Clearly unrelated requests (films, weather, recipes, general facts,
 * jokes …) get a short, friendly no and a way back to the finances, without calling the model.
 */
const word = (source: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, "iu");

// Money and the app: such a message is never turned away, even when it also mentions a film or a trip.
const finance = word([
  "geld", "euro", "eur", "cent", "kost\\p{L}*", "preis\\p{L}*", "teuer\\p{L}*", "günstig\\p{L}*", "billig\\p{L}*", "ausgab\\p{L}*", "ausgegeben", "ausgeben",
  "bezahl\\p{L}*", "gezahlt", "zahl\\p{L}*", "überweis\\p{L}*", "budget\\p{L}*", "spar\\p{L}*", "gespart", "konto", "konten", "kontost\\p{L}*", "giro\\p{L}*",
  "pockets?", "notgroschen", "gehalt\\p{L}*", "lohn\\p{L}*", "netto", "brutto", "steuer\\p{L}*", "abos?", "abonnement\\p{L}*", "vertr[aä]g\\p{L}*",
  "versicher\\p{L}*", "kündig\\p{L}*", "frist\\p{L}*", "kredit\\p{L}*", "raten?", "zins\\p{L}*", "inflation", "teuerung", "invest\\p{L}*", "aktie\\p{L}*",
  "etfs?", "depot", "fonds", "börse\\p{L}*", "finanz\\p{L}*", "bank\\p{L}*", "rechnung\\p{L}*", "miete", "buchung\\p{L}*", "umsatz", "umsätze",
  "kategorie\\p{L}*", "händler\\p{L}*", "leisten", "leistbar", "schulden", "vermögen", "einnahmen", "einkommen", "bonus", "prämie\\p{L}*",
  "sonderzahlung\\p{L}*", "pension", "rente", "kaufkraft", "wechselkurs\\p{L}*", "dollar", "franken", "yen", "pfund", "klarna", "paypal", "amex", "revolut",
  "raiffeisen", "einkauf\\p{L}*", "gekauft", "kauf\\p{L}*", "bestell\\p{L}*", "fixkosten", "sparziel\\p{L}*", "bitcoin", "krypto\\p{L}*",
  "app", "finanzblick", "dashboard", "einstellung\\p{L}*", "export\\p{L}*", "import\\p{L}*", "backup\\p{L}*", "dunkelmodus", "dark mode",
].join("|"));
// Compounds such as "Leitzins", "Handyvertrag" or "Lebensmittelbudget".
const financeCompound = word("\\p{L}*(?:zins|zinsen|vertrag|verträge|budget|konto|konten|versicherung|steuer|kosten|gehalt|abo|abos|preis|preise|geld|sparen)\\p{L}*");
const personal = word("ich|mir|mich|mein\\p{L}*|wir|uns|unser\\p{L}*");
// "Wie viel gebe ich für Musik aus?", "Ich will ins Kino, geht sich das aus?": own spending, even about a hobby.
const spending = /\b(?:gebe|geben|gibst)\b.{0,60}\baus\b|\bgeht sich\b.{0,60}\baus\b/i;

type Topic = "creative" | "media" | "weather" | "food" | "facts" | "time" | "other";
const always: [Topic, RegExp][] = [
  // Creative writing stays out even when it is about money ("ein Gedicht über Sparen").
  ["creative", word("witz\\p{L}*|flachwitz\\p{L}*|gedicht\\p{L}*|reim\\p{L}*|haiku|märchen|limerick|songtext\\p{L}*|rap")],
  ["creative", /(?:schreib|dicht|erfind|erzähl|erzaehl)\w*\b.{0,30}\b(?:geschichte|kurzgeschichte|lied|song|story)\b|(?:was|etwas) lustiges|zum lachen/i],
];
const unrelated: [Topic, RegExp][] = [
  ["media", word("filme?|filmtipps?|kino\\p{L}*|serien?|serientipps?|buchtipps?|buch|bücher|romane?|lektüre|musik\\p{L}*|songs?|lieder|album|alben|playlist\\p{L}*|podcasts?|videospiel\\p{L}*|computerspiel\\p{L}*|games?|anime|youtube\\p{L}*|schauspieler\\p{L}*|regisseur\\p{L}*")],
  ["weather", word("wetter\\p{L}*|regnet|regen|schneit|schnee|sonnig|gewitter\\p{L}*|temperatur\\p{L}*")],
  ["weather", /^(?:und\s+)?wie (?:warm|kalt|heiß|heiss) (?:wird|ist) es\b/i],
  ["food", word("rezept\\p{L}*|zutaten|kochen|koche|kocht|backen|backe|backt|zubereit\\p{L}*|kochidee\\p{L}*")],
  ["food", /^(?:und\s+)?was (?:soll|könnte|koennte|kann) ich (?:heute |morgen |am wochenende )?(?:essen|kochen|backen)\b/i],
  ["food", /^wie (?:mache|macht|koche|kocht|backe|backt|bereite|bereitet) (?:ich|man)\b/i],
  ["time", /^(?:und\s+)?(?:wie spät ist es|wie viel uhr|wieviel uhr|was ist die uhrzeit|uhrzeit|was ist heute für ein tag|was für ein tag ist heute|welcher (?:wochen)?tag ist heute|welches datum|der wievielte ist heute|welchen tag haben wir)/i],
  ["other", /^(?:und\s+)?wann spielt\b|\b(?:spanisch|englisch|französisch|italienisch|chinesisch) lernen\b/i],
  ["facts", word("\\p{L}*physik|chemie|biologie|hauptstadt|einwohner\\p{L}*|kontinent\\p{L}*|planet\\p{L}*|präsident\\p{L}*|bundeskanzler\\p{L}*|relativitätstheorie|weltkrieg\\p{L}*|dinosaurier\\p{L}*")],
  ["other", word("fußball\\p{L}*|fussball\\p{L}*|bundesliga|champions league|olympia\\p{L}*|formel 1|tennis|nachrichten|schlagzeilen|politik|übersetz\\p{L}*|programmier\\p{L}*|python|javascript|hausaufgabe\\p{L}*|horoskop\\p{L}*|sternzeichen|sinn des lebens|philosophie\\p{L}*|lieblings\\p{L}+|lebenslauf\\p{L}*|bewerbungs\\p{L}*|vokabel\\p{L}*|grammatik|beibringen|dating|beziehungstipp\\p{L}*|sehenswürdigkeit\\p{L}*|kopfschmerz\\p{L}*|symptom\\p{L}*")],
  ["other", /(?:schreib|formulier|verfass)\w*\b.{0,40}\b(?:e-?mail|mail|brief|bewerbung|aufsatz)\b|\b(?:e-?mail|mail|brief|bewerbung|aufsatz)\b.{0,40}\b(?:helf|hilf)\w*|\b(?:helf|hilf)\w*\b.{0,40}\b(?:e-?mail|mail|brief|bewerbung|aufsatz)\b/i],
];
// General knowledge about the world, never about oneself: "Wie hoch ist der Großglockner?", "Wo liegt Kärnten?".
const factQuestion = /^(?:und\s+)?(?:wie (?:hoch|lang|groß|gross|tief|alt|schwer|weit|breit) (?:ist|war|sind|waren) (?:der|die|das|ein|eine)\b|wer (?:hat|war|ist|sind|waren|wurde|erfand|entdeckte)\b|wann (?:wurde|wurden|war|begann|endete|starb|lebte)\b|wo (?:liegt|liegen|ist|sind|steht|stehen) (?:der|die|das|\p{Lu})|wie viele (?:menschen|leute|einwohner|länder|sterne|tage hat)\b)/iu;

const reasons: Record<Topic, string> = {
  creative: "Witze, Gedichte und Geschichten schreibe ich nicht",
  media: "Film-, Serien-, Buch- und Musiktipps gebe ich nicht",
  weather: "Zum Wetter kann ich dir nichts sagen",
  food: "Rezepte und Kochtipps gebe ich nicht",
  facts: "Allgemeine Wissensfragen beantworte ich nicht",
  time: "Datum und Uhrzeit zeigt dir dein Gerät",
  other: "Dabei kann ich dir nicht helfen",
};

/** The topic of a message that has nothing to do with money or the app; undefined when it may be about finances. */
export function offTopic(input: string): Topic | undefined {
  const text = normalizeMessage(input).trim();
  if (!text) return undefined;
  const creative = always.find(([, pattern]) => pattern.test(text));
  if (creative) return creative[0];
  if (finance.test(text) || financeCompound.test(text) || spending.test(text)) return undefined;
  const found = unrelated.find(([, pattern]) => pattern.test(text));
  if (found) return found[0];
  if (!personal.test(text) && factQuestion.test(text) && !/\b(?:dich|du|dir|finanzblick)\b/i.test(text)) return "facts";
  return undefined;
}

export const scopeSuggestions = ["Wie viel hab ich diesen Monat ausgegeben?", "Welche Abos habe ich?", "Was bleibt mir diesen Monat?"];

/** A friendly no for unrelated topics, with a way back to the finances. */
export function offTopicReply(input: string): AgentResult | undefined {
  const topic = offTopic(input);
  if (!topic) return undefined;
  return { text: `${reasons[topic]} – ich bin nur für deine Finanzen und die App da. Frag mich zum Beispiel nach deinen Ausgaben, Verträgen, Sparzielen oder deinem Budget.`,
    suggestions: scopeSuggestions };
}
