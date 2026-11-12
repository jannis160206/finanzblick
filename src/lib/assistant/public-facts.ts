import { normalizeMessage } from "./normalize";

// Shared word lists for questions about public money rules, used by the orchestrator and the intent frames.

export const foldText = (value: string) => normalizeMessage(value).toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9€%]+/g, " ").trim();
export const explicitWeb = /\b(?:such|suche|sucht|schau|recherchier|googl)\w*\b.{0,40}\b(?:internet|netz|web|online|google)\b|\b(?:internet|web) ?(?:suche|recherche)\b|\bgoogle (?:mal|das|bitte)\b|\bwas sagt das (?:internet|netz)\b/;
// Public rules, benefits and limits that change every year or depend on the law (folded text, no umlauts).
export const publicTerms = /\b(?:neue\w* regel\w*|gesetz\w*|(?:geringfuegigkeits|einkommens|zuverdienst|verdienst|frei|beitrags|hoechstbeitrags|umsatz|kleinunternehmer)grenze|\w*freibetrag|\w*pauschale|\w*steuersatz|\w*zinssatz|foerder\w*|\w*bonus|\w*beihilfe|zuschu\w*|\w*absetzbetrag|kilometergeld|pendlereuro|sachbezug\w*|mindestlohn|mindestsicherung|arbeitslosengeld|notstandshilfe|karenz\w*|kinderbetreuungsgeld|pension\w*|rente|abfertigung|hoechstbeitrag\w*|beitragssatz|richtwert\w*|mietzins\w*|gebuehr\w*|steuerreform|kalte progression|tarifstufe\w*)\b/;
export const statedYear = /\b(?:aktuell\w*|derzeit\w*|momentan\w*|heuer|dieses jahr|20[2-3]\d)\b/;
// Figures and rules the curated knowledge cannot keep up to date: a public term, or any question about the current year.
export const changingFacts = new RegExp(`${publicTerms.source}|\\b(?:aktuell\\w*|derzeit\\w*|momentan\\w*|heuer|dieses jahr|ab (?:sofort|jaenner|januar)|20[2-3]\\d)\\b`);
export const ownData = /\b(?:mein\w*|mir|mich|ich|unser\w*|wir)\b/;

// A period or a booking verb makes it a question about the user's bookings ("Wann wurde der Bonus überwiesen?").
const bookingContext = new RegExp([
  "\\b(?:im|in|seit|vom|am|bis|letzte\\w*|vorige\\w*|diese[nm]?)\\s+(?:jaenner|januar|februar|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|monat|woche|jahr|quartal)\\b",
  "\\b(?:ueberwiesen|ueberweisung|kam|kamen|gekommen|eingegangen|abgebucht|ausbezahlt|ausgezahlt|verrechnet|bekommen|erhalten|gezahlt|bezahlt|gutgeschrieben|ausgegeben|buchung\\w*|zahlung\\w*|umsatz|umsaetze)\\b",
].join("|"));

/** "Geringfügigkeitsgrenze 2026 – wie viel ist das?": a public figure, not the user's own bookings. */
export const publicFactQuestion = (input: string) => {
  const text = foldText(input);
  return publicTerms.test(text) && !ownData.test(text) && !bookingContext.test(text);
};
