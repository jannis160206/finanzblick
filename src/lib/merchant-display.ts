import { recoverMerchant } from "@/lib/import/merchant-description";

/**
 * Readable merchant names for display and grouping. Raw bank texts such as
 * "AMZNPRIME DE*BT15Q46J4 AMZN.DE/INFO" become "Amazon Prime". Known brands win;
 * otherwise payment-processor prefixes, references, store numbers and place suffixes
 * are stripped and shouty text is title-cased. Never returns an empty string.
 */
const brands: [RegExp, string][] = [
  [/amzn\s*prime|amazon\s*prime|prime\s*video/i, "Amazon Prime"],
  [/audible/i, "Audible"],
  [/\bamzn|amazon/i, "Amazon"],
  [/netflix/i, "Netflix"],
  [/youtube\s*premium/i, "YouTube Premium"],
  [/youtube/i, "YouTube"],
  [/google/i, "Google"],
  [/spotify/i, "Spotify"],
  [/disney\s*(?:plus|\+)/i, "Disney+"],
  [/\bdazn\b/i, "DAZN"],
  [/playstation|\bpsn\b|sony\s*interactive/i, "PlayStation"],
  [/xbox/i, "Xbox"],
  [/microsoft|\bmsft\b/i, "Microsoft"],
  [/nintendo/i, "Nintendo"],
  [/steam\s*(?:games|powered|purchase)|^steam\b|\bvalve\b/i, "Steam"],
  [/\bg2a\b/i, "G2A"],
  [/apple\.com|itunes|\bapple\b/i, "Apple"],
  [/openai|chatgpt/i, "OpenAI"],
  [/github/i, "GitHub"],
  [/mc\s*donald'?s?|mcdonalds/i, "McDonald's"],
  [/burger\s*king/i, "Burger King"],
  [/\bkfc\b/i, "KFC"],
  [/starbucks/i, "Starbucks"],
  [/subway/i, "Subway"],
  [/uber\s*\*?\s*eats/i, "Uber Eats"],
  [/\buber\b/i, "Uber"],
  [/\bbolt\b/i, "Bolt"],
  [/\bwolt\b/i, "Wolt"],
  [/lieferando/i, "Lieferando"],
  [/\bmjam\b/i, "Mjam"],
  [/foodora/i, "Foodora"],
  [/\bshell\b/i, "Shell"],
  [/\bomv\b/i, "OMV"],
  [/\bbp\b/i, "BP"],
  [/\beni\b|\bagip\b/i, "Eni"],
  [/turm(?:ö|oe?)l/i, "Turmöl"],
  [/\bavanti\b/i, "Avanti"],
  [/interspar|eurospar|\bspar\b/i, "Spar"],
  [/\bbilla\b/i, "Billa"],
  [/\blidl\b/i, "Lidl"],
  [/\bhofer\b/i, "Hofer"],
  [/\bpenny\b/i, "Penny"],
  [/\bmerkur\b/i, "Merkur"],
  [/\bbipa\b/i, "BIPA"],
  [/\bdm\b|dm[-\s]drogerie/i, "dm"],
  [/\bm(?:ü|ue)ller\b/i, "Müller"],
  [/\bh\s*&\s*m\b|hennes\s*&?\s*mauritz/i, "H&M"],
  [/\bikea\b/i, "IKEA"],
  [/xxx\s*lutz/i, "XXXLutz"],
  [/media\s*markt/i, "MediaMarkt"],
  [/zalando/i, "Zalando"],
  [/aliexpress/i, "AliExpress"],
  [/\btemu\b/i, "Temu"],
  [/\bebay\b/i, "eBay"],
  [/booking\.com/i, "Booking.com"],
  [/airbnb/i, "Airbnb"],
  [/ryanair/i, "Ryanair"],
  [/austrian\s*airlines/i, "Austrian Airlines"],
  [/\b(?:ö|oe)bb\b/i, "ÖBB"],
  [/wiener\s*linien/i, "Wiener Linien"],
  [/\ba1\s*telekom\b/i, "A1"],
];

const processorPrefix = /^(?:paypal\s*\*|pp\s*\*|sq\s*\*|sumup\s*\*|zettle_?\*|ztl\s*\*|crv\s*\*|iz\s*\*|sp\s*\*|visa\s+|mastercard\s+|kartenzahlung\s*|lastschrift\s*|pos\s+)/i;
const legalForm = /\b(?:gmbh|ag|kg|og|e\.?\s?u\.?|ltd|inc|llc|bv|s\.?a\.?r\.?l\.?|s\.?a\.?|co\.?\s*kg)\b\.?/gi;
const storeWords = /\b(?:dankt|filiale|fil\.?|store|nr\.?|markt\s*nr\.?)\b/gi;
const placeSuffix = /^(?:de|at|ch|ie|lu|nl|gb|uk|us|fr|it|es|deu|aut|wien|vienna|graz|linz|salzburg|innsbruck|klagenfurt|villach|wolfsberg|st\.?\s*veit|bregenz|eisenstadt|st\.?\s*p(?:ö|oe)lten|berlin|m(?:ü|ue)nchen|munich|hamburg|k(?:ö|oe)ln|frankfurt|luxembourg|luxemburg|dublin|amsterdam|london|paris)$/i;
const keepUpper = new Set(["OMV", "BP", "DM", "H&M", "KFC", "ÖBB", "ADAC", "ÖAMTC", "OAMTC", "BMW", "VW", "IKEA", "BIPA", "XXL"]);

const collapse = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();

function brandOf(text: string): string | undefined {
  return brands.find(([pattern]) => pattern.test(text))?.[1];
}

function titleCase(word: string): string {
  const letters = word.replace(/[^\p{L}&]/gu, "");
  if (keepUpper.has(letters.toUpperCase()) && letters === letters.toUpperCase()) return word;
  if (letters.length <= 3 && letters === letters.toUpperCase() && !/[aeiouäöüy]/i.test(letters)) return word;
  return word.toLocaleLowerCase("de-AT").replace(/(^|[-'’/.])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toLocaleUpperCase("de-AT"));
}

function genericName(text: string): string {
  let value = text;
  for (let previous = ""; previous !== value;) {
    previous = value;
    value = value.replace(processorPrefix, "").trim();
  }
  // PayPal itself (no "PAYPAL *Shop" sub-merchant left after the prefix).
  if (!value || /^paypal\b/i.test(value)) return /paypal/i.test(text) ? "PayPal" : "";
  const domain = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]{2,})\.(?:com|de|at|net|org|io|eu|ch|co\.uk|shop)\b/i.exec(value);
  if (domain) return titleCase(domain[1]);
  const star = value.indexOf("*");
  if (star > 0) value = value.slice(0, star);
  else if (star === 0) value = value.slice(1);
  value = value
    .replace(legalForm, " ")
    .replace(storeWords, " ")
    .replace(/#\s*\d+/g, " ")
    .replace(/\b[\p{L}\p{N}-]*\d[\p{L}\p{N}-]*\b/gu, " ")
    .replace(/[|;:,_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.\-/]+|[\s.\-/]+$/g, "")
    .trim();
  const words = value.split(" ").filter(Boolean);
  while (words.length > 1 && placeSuffix.test(words.at(-1)!)) words.pop();
  while (words.length > 2 && placeSuffix.test(words.slice(-2).join(" "))) words.splice(-2, 2);
  value = words.join(" ");
  const letters = value.replace(/[^\p{L}]/gu, "");
  if (letters.length < 2) return "";
  const shouty = letters === letters.toUpperCase();
  const quiet = letters === letters.toLowerCase();
  return shouty || quiet ? words.map(titleCase).join(" ") : value;
}

export function cleanMerchantName(description: string): string {
  const original = collapse(description ?? "");
  if (!original) return description ?? "";
  const recovered = collapse(recoverMerchant({ description: original }).description) || original;
  const brand = brandOf(recovered) ?? (recovered === original ? undefined : brandOf(original));
  if (brand) return brand;
  return genericName(recovered) || genericName(original) || original;
}

/** Grouping key: same readable merchant, case-insensitive. */
export function merchantKey(description: string): string {
  return cleanMerchantName(description).toLocaleLowerCase("de-AT");
}
