import { normalizeMessage } from "./normalize";
import { foldText, ownData, publicTerms } from "./public-facts";

/**
 * Questions about values that change all the time: quotes, news, current prices, rates and this year's tax figures.
 * They always go to the web (live quotes, news feed, web search) and are never answered from local knowledge.
 */
export type CurrentKind = "quote" | "news" | "price" | "rate" | "tax";
export type CurrentInfo = { kind: CurrentKind; subject: string };

// Folded text (no umlauts). Assets whose price changes by the minute.
const assets = /\b(?:bitcoin\w*|btc|ethereum|ether|eth|krypto\w*|crypto\w*|solana|ripple|xrp|dogecoin|cardano|litecoin|aktie\w*|\w+aktie|boerse\w*|dax|atx|dow jones|nasdaq|s ?p ?500|msci world|gold\w*|silber\w*|oel\w*|brent|rohoel|platin|wechselkurs\w*|devisen\w*)\b/;
const quoteWords = /\b(?:preis\w*|\w*kurs\w*|wert|stand|steht|stehen|notiert|kostet|kosten|chart|entwickelt|entwicklung|gestiegen|gefallen|plus|minus)\b/;
const now = /\b(?:aktuell\w*|derzeit\w*|momentan\w*|heute|gerade|jetzt|zurzeit|live|neueste\w*|diese woche|dieser woche|heuer|20[2-3]\d)\b/;
const news = /\b(?:nachricht\w*|news|neuigkeit\w*|schlagzeile\w*|was gibt(?: es|s) neues|was ist (?:heute|gestern) (?:los|passiert)|aktuelle lage|was tut sich)\b/;
const taxes = /\b(?:\w*steuersatz\w*|steuerstufe\w*|kest|lohnsteuer\w*|einkommensteuer\w*|mehrwertsteuer|mwst|umsatzsteuer|grenzsteuersatz)\b/;
const rates = /\b(?:\w*zins\w*|euribor|inflation\w*|teuerung\w*)\b/;
const prices = /\b(?:\w*preis\w*|kostet|kosten|tarif\w*|gebuehr\w*)\b/;

// Well-known assets by their folded name, as the live sources and the answer call them.
const knownAssets: [RegExp, string][] = [
  [/\bbitcoin\w*|\bbtc\b/, "Bitcoin"], [/\bethereum\b|\bether\b|\beth\b/, "Ethereum"], [/\bsolana\b/, "Solana"], [/\bripple\b|\bxrp\b/, "XRP"],
  [/\bdogecoin\b/, "Dogecoin"], [/\bcardano\b/, "Cardano"], [/\blitecoin\b/, "Litecoin"], [/\bgold\w*/, "Gold"], [/\bsilber\w*/, "Silber"],
  [/\bplatin\b/, "Platin"], [/\b(?:oel\w*|brent|rohoel)\b/, "Öl"], [/\bdax\b/, "DAX"], [/\batx\b/, "ATX"], [/\bnasdaq\b/, "Nasdaq"],
  [/\bdow jones\b/, "Dow Jones"], [/\bs ?p ?500\b/, "S&P 500"], [/\bmsci world\b/, "MSCI World"],
];

// Words that ask for the value but do not name the thing.
const asking = new Set(["was", "wie", "wo", "ist", "sind", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "einen", "hoch", "viel", "steht",
  "stehen", "kostet", "kosten", "aktuell", "aktuelle", "aktuellen", "aktueller", "derzeit", "momentan", "heute", "gerade", "jetzt", "zurzeit", "live", "preis",
  "kurs", "wert", "stand", "von", "vom", "fuer", "für", "im", "in", "am", "an", "bei", "zu", "zum", "zur", "mir", "bitte", "sag", "zeig", "nenn", "gibt", "es",
  "neues", "nachrichten", "news", "neuigkeiten", "heuer", "und", "oder", "mal", "noch", "liegt", "aktie", "aktien", "notiert", "einer", "aus", "welche",
  "hat", "haben", "sich", "letzten", "letzte", "tag", "tage", "tagen", "woche", "wochen", "monat", "monate", "monaten", "jahr", "jahren", "entwickelt",
  "entwicklung", "seit", "gestiegen", "gefallen", "mehr", "weniger", "gibt's", "wieviel", "teuer", "lage"]);

/** The thing the value is about ("Bitcoin", "Apple", "Diesel"), without the words that only ask for it. */
export function currentSubject(question: string): string {
  const folded = foldText(question);
  const known = knownAssets.find(([pattern]) => pattern.test(folded));
  if (known) return known[1];
  const words = normalizeMessage(question).replace(/[?!.,;:„“"()]/g, " ").replace(/-(?:aktie|kurs|preis|wert)\b/gi, " ")
    .split(/\s+/).filter((word) => word && !asking.has(word.toLowerCase()) && !/^20[2-3]\d$/.test(word));
  return words.filter((word) => !/^\d+$/.test(word)).slice(0, 4).join(" ").trim();
}

/** Whether a question asks for a value that changes, and what kind of live source answers it. */
export function currentInfo(question: string): CurrentInfo | undefined {
  const text = foldText(question);
  if (text.split(" ").length < 2) return undefined;
  const subject = currentSubject(question);
  if (news.test(text)) return { kind: "news", subject };
  // "Wie viel ist mein Depot wert?" or "Was kosten mich meine Abos?" is about the user's own data.
  if (ownData.test(text)) return undefined;
  // The asking word must stand on its own: "Was ist ein Wechselkurs?" explains, "Bitcoin Kurs" asks for the value.
  if (assets.test(text) && (quoteWords.test(text.replace(new RegExp(assets.source, "g"), " ")) || now.test(text))) return { kind: "quote", subject };
  if (!now.test(text)) return undefined;
  if (taxes.test(text) || publicTerms.test(text)) return { kind: "tax", subject };
  if (rates.test(text)) return { kind: "rate", subject };
  if (prices.test(text)) return { kind: "price", subject };
  return undefined;
}
