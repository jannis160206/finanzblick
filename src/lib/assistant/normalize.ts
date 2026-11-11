// Brings casual chat input into the spelling the parsers expect, so "wv hab ich im okt fuer essen bezahlt"
// reads like "wie viel hab ich im oktober für essen bezahlt". Idempotent: running it twice changes nothing.

const keepCase = (source: string, replacement: string) =>
  source.charAt(0) === source.charAt(0).toUpperCase() && source.charAt(0) !== source.charAt(0).toLowerCase()
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;

// ASCII spellings of umlauts in word stems that the parsers look for.
const umlauts: [RegExp, string][] = [
  [/\bfuer(s)?\b/gi, "für$1"], [/\bueber/gi, "über"], [/\brueck/gi, "rück"], [/zurueck/gi, "zurück"], [/gaengig/gi, "gängig"],
  [/\baender/gi, "änder"], [/\berhoeh/gi, "erhöh"], [/\bnaechst/gi, "nächst"], [/zusaetzlich/gi, "zusätzlich"], [/\bmaerz\b/gi, "märz"],
  [/\bjaenner\b/gi, "jänner"], [/\bgroesst/gi, "größt"], [/gedaechtnis/gi, "gedächtnis"], [/\bmoecht/gi, "möcht"], [/\bkoennt/gi, "könnt"],
  [/\bwuerd/gi, "würd"], [/\bloesch/gi, "lösch"], [/\buebrig/gi, "übrig"], [/\bkuendig/gi, "kündig"], [/\bfaellig/gi, "fällig"],
  [/\bgehoer/gi, "gehör"], [/\bkoenn/gi, "könn"], [/\bmuess/gi, "müss"], [/\bspaeter\b/gi, "später"], [/\bfrueher\b/gi, "früher"],
  [/\bschliess/gi, "schließ"], [/\bweisst\b/gi, "weißt"], [/\bheiss/gi, "heiß"], [/\bmonatsuebersicht/gi, "monatsübersicht"],
  [/\bwaere\b/gi, "wäre"], [/\bhaette\b/gi, "hätte"], [/\bwaehl/gi, "wähl"], [/\berklaer/gi, "erklär"], [/\btaeglich/gi, "täglich"],
];

const months: Record<string, string> = { feb: "februar", mrz: "märz", "mär": "märz", apr: "april", jun: "juni", jul: "juli",
  aug: "august", sep: "september", sept: "september", okt: "oktober", nov: "november", dez: "dezember" };

const englishMonths: Record<string, string> = { january: "jänner", february: "februar", march: "märz", june: "juni", july: "juli",
  october: "oktober", december: "dezember" };

const slang: [RegExp, string][] = [
  [/\b(?:wv|wieviel|wie vieel+|wievieel+)\b/gi, "wie viel"],
  [/\b(?:kohle|knete|kröten|kroeten|zaster|moneten|asche)\b/gi, "geld"],
  [/(?:\b|')nen\b/gi, "einen"], [/(?:\b|')nem\b/gi, "einem"],
  [/\bfernsehr\b|\btv\b|\bfernseh\b/gi, "Fernseher"], [/\bhandy\b|\bsmartphone\b/gi, "Handy"],
  [/\bkrieg(?=e?\b)/gi, "bekomm"], [/\bkriegst\b/gi, "bekommst"], [/\bmtl\.?(?=\s|$)/gi, "monatlich"], [/\bp\.?\s?m\.?(?=\s|$)/gi, "pro monat"],
  [/\bbtw\b|\bpls\b|\bplz\b|\bbitteschön\b/gi, ""], [/\bnimma\b/gi, "nicht mehr"], [/\bnet\b(?=\s|[.!?]|$)/gi, "nicht"], [/\bhob\b/gi, "hab"],
  [/\bi\b(?=\s+(?:hab|will|möcht|brauch|kann|krieg|bekomm|spar|bin|muss))/gi, "ich"], [/\bmei\b(?=\s)/gi, "mein"],
];

export function normalizeMessage(text: string): string {
  let result = text.slice(0, 1000).replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of umlauts) result = result.replace(pattern, (match, ...groups) =>
    keepCase(match, replacement.replace("$1", typeof groups[0] === "string" ? groups[0] : "")));
  for (const [pattern, replacement] of slang) result = result.replace(pattern, (match) => keepCase(match.replace(/^'/, ""), replacement));
  // "okt", "sept." → full month names; "Jan" stays because it is also a first name.
  result = result.replace(/\b(feb|mrz|mär|apr|jun|jul|aug|sept|sep|okt|nov|dez)\b\.?/gi, (match, word: string) => keepCase(match, months[word.toLowerCase()]));
  // English month names ("in october"); "may" stays because it is also a verb.
  result = result.replace(/\b(january|february|march|june|july|october|december)\b/gi, (match, word: string) =>
    keepCase(match, englishMonths[word.toLowerCase()]));
  // "Juli 27" → "Juli 2027" (a two-digit year right after a month, not an amount).
  result = result.replace(/\b(jänner|januar|februar|feber|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+'?(2[4-9]|3\d)\b(?!\s*(?:€|euro|eur|\.\d|,\d|\d))/gi,
    (_, month: string, year: string) => `${month} 20${year}`);
  // "3k", "1,5k", "4 tsd" → full numbers.
  result = result.replace(/\b(\d{1,3})(?:,(\d))?\s?(?:k|tsd\.?|tausend)(?![a-zäöüß])(?!\s*(?:fernseher|monitor|bildschirm|display|video))/gi, (_, whole: string, decimal: string | undefined) =>
    String(Number(whole) * 1000 + (decimal ? Number(decimal) * 100 : 0)));
  // "Lieferando = Lieferdienste" → a rule sentence.
  result = result.replace(/^([^=\d]{2,40}?)\s*(?:=|->|→|=>)\s*([^=\d]{2,40})$/, "$1 ist immer $2");
  return result.replace(/\s{2,}/g, " ").trim();
}
