import { z } from "zod";
import { categories } from "@/lib/categories";
import { merchantText } from "@/lib/import/merchant-description";
import { privateMerchantLogoSchema } from "./merchant-logo-metadata";
import { curatedMerchantIdentities } from "./merchant-identities";
import { expandedMerchantIdentities } from "./merchant-expansion";

const MAX_INPUT = 1024;
const MAX_NORMALIZED = 512;
const MAX_TOKENS = 32;
const MAX_ALIAS_TOKENS = 4;
const MAX_REGEX_PATTERNS = 256;
const MAX_POSTING = 64;
const MAX_FUZZY_CANDIDATES = 128;
export const MAX_MERCHANT_ALIASES = 40_000;
const providers =
  /\b(?:pay\s*pal|klarna|sum\s*up|stripe|adyen|mollie|worldline|revolut(?:\s+epayment)?|apple\s+pay|google\s+pay)\b/i;
const ibanLengths: Record<string, number> = {
  AT: 20,
  DE: 22,
  CH: 21,
  GB: 22,
  NL: 18,
  FR: 27,
  ES: 24,
  IT: 27,
  BE: 16,
  LU: 20,
  PL: 28,
  CZ: 24,
  HU: 28,
  SK: 24,
  RO: 24,
  IE: 22,
  PT: 25,
  DK: 18,
  FI: 18,
  NO: 15,
  SE: 24,
  GR: 27,
  HR: 21,
  SI: 19,
  BG: 22,
  EE: 20,
  LT: 20,
  LV: 21,
  MT: 31,
  CY: 28,
};
const iban = new RegExp(
  `\\b(?:iban\\s*:?\\s*)?(?:${Object.entries(ibanLengths)
    .map(
      ([country, length]) =>
        `${country}\\s*\\d\\s*\\d(?:\\s*[A-Z0-9]){${length - 4}}`,
    )
    .join("|")})\\b`,
  "gi",
);

/** Oversized inputs fail closed rather than hiding a conflicting trailing merchant. */
export function normalizeMerchantText(text: string): string {
  if (text.length > MAX_INPUT) return "";
  const metadataFree = text
    .normalize("NFKC")
    .replace(iban, " ")
    .replace(/\biban\s*:?\s*[A-Z]{2}\s*\d{2}[A-Z0-9]*/gi, " ")
    .replace(/\bmcc\s*[:=]\s*\d{4}\b/gi, " ")
    .replace(/\bbic\s*:?\s*[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/gi, " ")
    .replace(
      /\b(?:terminal|kartenterminal|kartenfolge)[-\s]*(?:id|nr|nummer)?\.?\s*[:=#]?\s*(?=[A-Z0-9*-]*\d)[A-Z0-9*-]+\b/gi,
      " ",
    )
    .replace(/\bpos[-\s]*(?:id|nr|nummer)\.?\s*[:=#]?\s*[A-Z0-9*-]+/gi, " ")
    .replace(
      /\b(?:zahlungsreferenz|auftraggeberreferenz|mandat(?:sreferenz)?|referenz|reference|ref|transaktions[-\s]*id|transaction[-\s]*id|end[-\s]*to[-\s]*end(?:[-\s]*id)?|id)\b\.?\s*[:=]\s*[^;|\r\n]*?(?=\s*(?:merchant|h(?:ä|ae)ndler)(?:[-\s]*name)?\s*:|[;|\r\n]|$)/gi,
      " ",
    )
    .replace(
      /\b(?:zahlungsreferenz|auftraggeberreferenz|mandat(?:sreferenz)?|referenz|reference|ref|transaktions[-\s]*id|transaction[-\s]*id|end[-\s]*to[-\s]*end(?:[-\s]*id)?|id)\b\.?\s*:?\s*[A-Z0-9][A-Z0-9_./*-]*/gi,
      " ",
    )
    .replace(
      /\b(?:filiale|fil|branch|store|nr|nummer)\b\.?\s*:?\s*#?\s*[A-Z]{0,3}\d+[A-Z0-9-]*/gi,
      " ",
    )
    .replace(
      /\b\d{4}[-/]\d{2}[-/]\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gi,
      " ",
    )
    .replace(/\b(?:h(?:ä|ae)ndler|merchant)(?:[-\s]*name)?\s*:/gi, " ");
  const paymentModeFree = metadataFree
    .replace(/\bpp(?=\s*[*\/])/gi, "PayPal")
    .trimStart()
    .replace(
      /^(?:(?:contactless(?:\s+card\s+payment)?|kontaktlos(?:e\s+(?:karten)?zahlung)?|karteneinsatz|(?:ec|debit|kredit)[ -]+kartenzahlung|ec[ -]+pos|nfc[ -]+zahlung)(?:\s*[:;|*]\s*|\s+))+/i,
      "",
    );
  const value = merchantText(paymentModeFree)
    .toLocaleLowerCase("de-AT")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/(\p{L})\+(?=\s|$)/gu, "$1 plus")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\b([a-z]{3,})\d{2,}\b/g, "$1")
    .replace(/\b(?=[a-z0-9-]*\d)[a-z0-9]{8,}(?:-[a-z0-9]+)*\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(
      /\b(?:iban|bic|sepa|pos|terminal|kartenterminal|kartenfolge|kartenzahlung|zahlung|debit|erstattung|rueckerstattung|rueckverguetung|refund|gutschrift|filiale|fil|branch|store|nr|nummer)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return value.length <= MAX_NORMALIZED ? value : "";
}

// Deliberately small regex language: literals, anchors, \b, ASCII classes,
// escaped punctuation, ? and {n,m} (max 8). No groups, alternation, wildcards,
// backreferences or unbounded repeats; at most two variable-repeat atoms.
function safeRegex(pattern: string): boolean {
  if (!pattern || pattern.length > 128) return false;
  let index = 0;
  let variableRepeats = 0;
  let expandedLength = 0;
  let consumingAtoms = 0;
  while (index < pattern.length) {
    const char = pattern[index++];
    if (char === "^" || char === "$") {
      if (
        (char === "^" && index !== 1) ||
        (char === "$" && index !== pattern.length)
      )
        return false;
      continue;
    }
    if (char === "\\") {
      const escape = pattern[index++];
      if (escape === "b") continue;
      if (!escape || !".-+()".includes(escape)) return false;
    } else if (char === "[") {
      const end = pattern.indexOf("]", index);
      if (end < 0) return false;
      const contents = pattern.slice(index, end);
      if (!contents || !/^[a-zA-Z0-9 -]+$/.test(contents)) return false;
      index = end + 1;
    } else if (!/[a-zA-Z0-9 _-]/.test(char)) return false;
    consumingAtoms++;
    let max = 1;
    if (pattern[index] === "?") {
      index++;
      variableRepeats++;
    } else if (pattern[index] === "{") {
      const quantifier = /^\{(\d+)(?:,(\d+))?\}/.exec(pattern.slice(index));
      if (!quantifier) return false;
      const min = Number(quantifier[1]);
      max = Number(quantifier[2] ?? quantifier[1]);
      if (min < 1 || max < min || max > 8) return false;
      if (min !== max) variableRepeats++;
      index += quantifier[0].length;
    }
    expandedLength += max;
    if (variableRepeats > 2 || expandedLength > 128) return false;
  }
  if (consumingAtoms < 3) return false;
  try {
    // Syntax-check classes/ranges, and disallow patterns that match an empty input.
    return !new RegExp(pattern, "iu").test("");
  } catch {
    return false;
  }
}

const nameSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .refine((name) => {
    const normalized = normalizeMerchantText(name);
    return (
      ((normalized.match(/\p{L}/gu)?.length ?? 0) >= 2 ||
        /^[\p{L}]\d$|^\d[\p{L}]$/u.test(normalized)) &&
      normalized.split(" ").length <= MAX_ALIAS_TOKENS &&
      !providers.test(name)
    );
  }, "A specific merchant name of at most four words is required; payment providers are not merchants.");

export const merchantLogoSchema = privateMerchantLogoSchema;

export const merchantSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    canonicalName: nameSchema,
    aliases: z.array(nameSchema).max(32),
    regexPatterns: z
      .array(
        z.string().refine(safeRegex, "Unsafe or unsupported merchant regex."),
      )
      .max(8),
    defaultCategory: z.enum(categories).nullable(),
    region: z.string().trim().min(2).max(20),
    source: z.string().trim().min(1).max(80),
    wikidataId: z
      .string()
      .regex(/^Q[1-9]\d{0,13}$/)
      .nullable()
      .default(null),
    requiresCategoryEvidence: z.boolean().default(false),
    city: z.string().trim().min(1).max(150).nullable().default(null),
    license: z.string().trim().min(1).max(200).nullable().default(null),
    attribution: z.string().trim().min(1).max(2000).nullable().default(null),
    logo: merchantLogoSchema.nullable().default(null),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((merchant, context) => {
    if (merchant.regexPatterns.length && merchant.source !== "local") {
      context.addIssue({
        code: "custom",
        path: ["regexPatterns"],
        message: "Only trusted local merchant patterns are accepted.",
      });
    }
  });

export type Merchant = z.infer<typeof merchantSchema>;
export interface MerchantMatch {
  merchant?: Merchant;
  requiresManualReview: boolean;
  method: "exact" | "regex" | "fuzzy" | "none";
}

const localMerchant = (
  id: string,
  canonicalName: string,
  aliases: string[],
  defaultCategory: Merchant["defaultCategory"],
  regexPatterns: string[] = [],
  wikidataId: string | null = null,
  requiresCategoryEvidence = false,
): Merchant =>
  merchantSchema.parse({
    id,
    canonicalName,
    aliases,
    regexPatterns,
    wikidataId: wikidataId ?? curatedMerchantIdentities[id] ?? null,
    requiresCategoryEvidence,
    defaultCategory,
    region: "AT",
    source: "local",
    license: "Local factual merchant rules; no logo rights asserted",
    attribution: "Finanzblick: lokal gepflegte Händlerregeln",
    updatedAt: Date.UTC(2026, 9, 9, 19, 30),
  });

/** Curated offline identities, not account-specific learned category overrides. */
export const seedMerchants: Merchant[] = [
  localMerchant(
    "brunello-cucinelli",
    "Brunello Cucinelli",
    [],
    null,
    [],
    "Q3645582",
  ),
  localMerchant("vom-fass", "vomFASS", [], null, [], "Q2533008"),
  localMerchant(
    "segafredo",
    "Segafredo",
    [],
    "Cafés & Snacks",
    [],
    "Q21282762",
  ),
  localMerchant("audi", "Audi", [], null, [], "Q124983953", true),
  localMerchant("bmw", "BMW", [], null, [], "Q796364", true),
  localMerchant("volkswagen", "Volkswagen", ["VW"], null, [], "Q246", true),
  localMerchant("porsche", "Porsche", [], null, [], "Q40993", true),
  localMerchant(
    "mercedes-benz",
    "Mercedes-Benz",
    ["Mercedes Benz"],
    null,
    [],
    "Q36008",
    true,
  ),
  localMerchant(
    "skoda",
    "Škoda Auto",
    ["Skoda", "Škoda"],
    null,
    [],
    "Q29637",
    true,
  ),
  localMerchant("seat", "SEAT", [], null, [], "Q188217", true),
  localMerchant("cupra", "CUPRA", [], null, [], "Q8352675", true),
  localMerchant("opel", "Opel", [], null, [], "Q40966", true),
  localMerchant("renault", "Renault", [], null, [], "Q125544573", true),
  localMerchant("peugeot", "Peugeot", [], null, [], "Q6742", true),
  localMerchant("citroen", "Citroën", ["Citroen"], null, [], "Q6746", true),
  localMerchant("dacia", "Dacia", [], null, [], "Q131701890", true),
  localMerchant("hyundai", "Hyundai", [], null, [], "Q125054811", true),
  localMerchant("kia", "Kia", [], null, [], "Q35349", true),
  localMerchant("toyota", "Toyota", [], null, [], "Q53268", true),
  localMerchant("honda", "Honda", [], null, [], "Q124966298", true),
  localMerchant("tesla", "Tesla", [], null, [], "Q124981765", true),
  localMerchant(
    "at-billa",
    "BILLA",
    ["Billa Plus", "Billa AG", "Billa dankt"],
    "Lebensmittel",
    ["\\bbilla[ ]?online\\b"],
    "Q537781",
  ),
  localMerchant(
    "at-penny",
    "PENNY",
    ["Penny Markt", "Penny Markt GmbH"],
    "Lebensmittel",
    [],
    "Q284688",
  ),
  localMerchant(
    "at-mueller",
    "Müller",
    ["Mueller", "Müller Drogerie", "Mueller Handels"],
    "Drogerie",
    [],
    "Q1958759",
  ),
  localMerchant(
    "at-spar",
    "SPAR",
    ["INTERSPAR", "EUROSPAR", "Spar Markt"],
    "Lebensmittel",
    [],
    "Q610492",
  ),
  localMerchant(
    "at-hofer",
    "HOFER",
    ["Hofer KG"],
    "Lebensmittel",
    [],
    "Q15815751",
  ),
  localMerchant(
    "at-lidl",
    "Lidl",
    ["Lidl Österreich"],
    "Lebensmittel",
    [],
    "Q151954",
  ),
  localMerchant(
    "at-dm",
    "dm",
    ["dm-drogerie", "dm Drogerie Markt"],
    "Drogerie",
    [],
    "Q266572",
  ),
  localMerchant(
    "at-bipa",
    "BIPA",
    ["Bipa Parfumerien"],
    "Drogerie",
    [],
    "Q864933",
  ),
  localMerchant(
    "at-ikea",
    "IKEA",
    ["Ikea Österreich"],
    "Möbel & Einrichtung",
    [],
    "Q54078",
  ),
  localMerchant(
    "at-oebb",
    "ÖBB",
    ["OEBB", "ÖBB Personenverkehr"],
    "Öffentliche Verkehrsmittel",
    [],
    "Q83822",
  ),
  localMerchant("at-westbahn", "WESTbahn", [], "Öffentliche Verkehrsmittel"),
  localMerchant("at-omv", "OMV", ["OMV Tankstelle"], "Tanken", [], null, true),
  localMerchant(
    "at-shell",
    "Shell",
    ["Shell Tankstelle"],
    "Tanken",
    [],
    null,
    true,
  ),
  localMerchant(
    "at-thalia",
    "Thalia",
    ["Thalia Buchhandlung", "Thalia Bücher", "Thalia Bücher GmbH", "Thalia.at"],
    "Bildung",
    [],
    "Q2408854",
  ),
  localMerchant(
    "at-fressnapf",
    "Fressnapf",
    ["Fressnapf GmbH", "Fressnapf Tiernahrungs GmbH", "Freßnapf"],
    "Haustiere",
    [],
    "Q875796",
  ),
  localMerchant("at-martin-auer", "Martin Auer", [], "Cafés & Snacks"),
  localMerchant(
    "amazon",
    "Amazon",
    ["AMZN", "AMZN Mktp", "AMZNMktp", "Amazon EU", "Amazon Marketplace"],
    "Shopping",
    [],
    "Q3884",
    true,
  ),
  localMerchant(
    "spotify",
    "Spotify",
    ["Spotify AB"],
    "Abonnements",
    [],
    "Q689141",
  ),
  localMerchant(
    "netflix",
    "Netflix",
    ["Netflix.com", "Netflix International"],
    "Abonnements",
    [],
    "Q907311",
  ),
  localMerchant(
    "disney-plus",
    "Disney Plus",
    ["Disney+", "Disneyplus"],
    "Abonnements",
  ),
  localMerchant(
    "youtube-premium",
    "YouTube Premium",
    ["YouTubePremium"],
    "Abonnements",
  ),
  localMerchant("nordvpn", "NordVPN", ["NordVPN.com"], "Abonnements"),
  localMerchant("chatgpt", "ChatGPT", ["OpenAI ChatGPT"], "Abonnements"),
  localMerchant(
    "apple",
    "Apple",
    ["Apple.com/bill", "iTunes", "App Store"],
    null,
  ),
  localMerchant(
    "mcdonalds",
    "McDonald's",
    ["McDonalds", "Mc Donalds", "McD"],
    "Restaurants",
    [],
    "Q38076",
  ),
  localMerchant(
    "burger-king",
    "Burger King",
    ["BurgerKing", "Burger King Corporation"],
    "Restaurants",
    [],
    "Q177054",
  ),
  localMerchant(
    "starbucks",
    "Starbucks",
    ["Starbucks Coffee"],
    "Cafés & Snacks",
  ),
  localMerchant("wolt", "Wolt", [], "Lieferdienste"),
  localMerchant("foodora", "foodora", [], "Lieferdienste"),
  localMerchant("lieferando", "Lieferando", ["Lieferando.at"], "Lieferdienste"),
  localMerchant("uber-eats", "Uber Eats", ["UberEats"], "Lieferdienste"),
  localMerchant(
    "uber-trips",
    "Uber Trip",
    ["UberTrip", "Uber Trips"],
    "Mobilität",
  ),
  localMerchant("booking", "Booking.com", ["BookingCom"], "Urlaub"),
  localMerchant("airbnb", "Airbnb", [], "Urlaub"),
  localMerchant("ryanair", "Ryanair", [], "Urlaub"),
  localMerchant(
    "austrian-airlines",
    "Austrian Airlines",
    ["AustrianAirlines"],
    "Urlaub",
  ),
  localMerchant("eurowings", "Eurowings", [], "Urlaub"),
  localMerchant("wizz-air", "Wizz Air", ["WizzAir"], "Urlaub"),
  localMerchant("flixbus", "FlixBus", [], "Öffentliche Verkehrsmittel"),
  localMerchant("cineplexx", "Cineplexx", [], "Entertainment"),
  localMerchant("cinemaxx", "CineMaxx", [], "Entertainment"),
  localMerchant(
    "steam",
    "Steam",
    ["SteamGames", "SteamPowered", "SteamPowered.com"],
    "Entertainment",
  ),
  localMerchant(
    "playstation",
    "PlayStation",
    ["PlayStation Network", "Sony PlayStation"],
    "Entertainment",
  ),
  localMerchant("nintendo", "Nintendo", ["Nintendo eShop"], "Entertainment"),
  localMerchant("decathlon", "Decathlon", [], "Sport & Fitness"),
  localMerchant("intersport", "Intersport", [], "Sport & Fitness"),
  localMerchant("fitinn", "Fitinn", [], "Sport & Fitness"),
  localMerchant("mcfit", "McFit", [], "Sport & Fitness"),
  localMerchant("zooplus", "Zooplus", [], "Haustiere"),
  localMerchant("zalando", "Zalando", [], "Shopping"),
  localMerchant(
    "hm",
    "H&M",
    ["Hennes & Mauritz", "HM.com"],
    "Shopping",
    [],
    "Q188326",
  ),
  localMerchant("ca", "C&A", ["C&A Mode"], "Shopping", [], "Q701338"),
  localMerchant("deichmann", "Deichmann", [], "Shopping"),
  localMerchant(
    "mediamarkt",
    "MediaMarkt",
    ["Media Markt"],
    "Shopping",
    [],
    "Q2381223",
  ),
  localMerchant(
    "moemax",
    "Mömax",
    ["Moemax"],
    "Möbel & Einrichtung",
    [],
    "Q56388481",
  ),
  localMerchant(
    "xxxlutz",
    "XXXLutz",
    [],
    "Möbel & Einrichtung",
    [],
    "Q70339467",
  ),
  localMerchant(
    "obi",
    "OBI",
    ["OBI Baumarkt", "OBI Markt"],
    "Wohnen & Haushalt",
    [],
    "Q300518",
  ),
  localMerchant(
    "bauhaus",
    "Bauhaus",
    ["Bauhaus AG", "InterBAUHAUS AG"],
    "Wohnen & Haushalt",
    [],
    "Q672043",
  ),
  localMerchant(
    "hornbach",
    "Hornbach",
    ["Hornbach-Baumarkt"],
    "Wohnen & Haushalt",
    [],
    "Q685926",
  ),
  localMerchant(
    "at-post",
    "Österreichische Post",
    ["Oesterreichische Post", "Post.at"],
    "Porto & Versand",
  ),
  localMerchant("dhl", "DHL", ["DHL Express"], "Porto & Versand"),
  localMerchant("dpd", "DPD", [], "Porto & Versand"),
  localMerchant("gls", "GLS", [], "Porto & Versand"),
  localMerchant("ups", "UPS", [], "Porto & Versand"),
  localMerchant("allianz", "Allianz", [], "Versicherungen"),
  localMerchant("uniqa", "UNIQA", [], "Versicherungen"),
  localMerchant("generali", "Generali", [], "Versicherungen"),
  localMerchant(
    "at-a1",
    "A1 Telekom",
    ["A1", "A1 Telekom Austria", "A1 Austria"],
    "Telefon & Internet",
    [],
    "Q279847",
  ),
  localMerchant(
    "at-drei",
    "Drei",
    [
      "Hutchison Drei",
      "Hutchison Drei Austria",
      "Hutchison Drei Austria GmbH",
      "Drei Österreich",
    ],
    "Telefon & Internet",
    [],
    "Q28956333",
  ),
  localMerchant(
    "at-magenta",
    "Magenta",
    ["Magenta Telekom", "T-Mobile Austria", "Magenta Österreich"],
    "Telefon & Internet",
    [],
    "Q63537385",
  ),
  localMerchant("at-adeg", "ADEG", ["ADEG Markt"], "Lebensmittel"),
  localMerchant("at-mpreis", "MPREIS", ["M-Preis", "M Preis"], "Lebensmittel"),
  localMerchant(
    "at-sutterluety",
    "Sutterlüty",
    ["Sutterluety"],
    "Lebensmittel",
  ),
  localMerchant(
    "denns",
    "denn's Biomarkt",
    ["Denns Biomarkt", "Denns"],
    "Lebensmittel",
  ),
  localMerchant("rewe", "REWE", ["REWE Markt"], "Lebensmittel"),
  localMerchant("edeka", "EDEKA", ["EDEKA Markt"], "Lebensmittel"),
  localMerchant("kaufland", "Kaufland", [], "Lebensmittel"),
  localMerchant(
    "at-stroeck",
    "Ströck",
    ["Stroeck", "Ströck Brot"],
    "Cafés & Snacks",
  ),
  localMerchant("at-anker", "Ankerbrot", ["Anker Brot"], "Cafés & Snacks"),
  localMerchant(
    "at-der-mann",
    "Der Mann",
    ["Der Mann Bäckerei"],
    "Cafés & Snacks",
  ),
  localMerchant("backwerk", "BackWerk", ["Back Werk"], "Cafés & Snacks"),
  localMerchant("kfc", "KFC", ["Kentucky Fried Chicken"], "Restaurants"),
  localMerchant("subway", "Subway", [], "Restaurants"),
  localMerchant("pizza-hut", "Pizza Hut", ["PizzaHut"], "Restaurants"),
  localMerchant("five-guys", "Five Guys", ["FiveGuys"], "Restaurants"),
  localMerchant("vapiano", "Vapiano", [], "Restaurants"),
  localMerchant("le-burger", "Le Burger", ["LeBurger"], "Restaurants"),
  localMerchant("dazn", "DAZN", [], "Abonnements"),
  localMerchant("sky-x", "Sky X", ["SkyX"], "Abonnements"),
  localMerchant(
    "paramount-plus",
    "Paramount Plus",
    ["Paramount+"],
    "Abonnements",
  ),
  localMerchant("deezer", "Deezer", [], "Abonnements"),
  localMerchant("tidal", "Tidal", [], "Abonnements"),
  localMerchant("adobe", "Adobe", [], null),
  localMerchant("microsoft", "Microsoft", [], null),
  localMerchant(
    "at-grawe",
    "GRAWE",
    ["Grazer Wechselseitige"],
    "Versicherungen",
  ),
  localMerchant(
    "at-wiener-staedtische",
    "Wiener Städtische",
    ["Wiener Staedtische"],
    "Versicherungen",
  ),
  localMerchant(
    "at-hdi",
    "HDI Versicherung",
    ["HDI Versicherungen"],
    "Versicherungen",
  ),
  localMerchant("esso", "Esso", [], "Tanken", [], null, true),
  localMerchant("bp", "BP", [], "Tanken", [], null, true),
  localMerchant("jet", "JET", ["JET Tankstelle"], "Tanken", [], null, true),
  localMerchant("avia", "AVIA", ["AVIA Tankstelle"], "Tanken", [], null, true),
  ...expandedMerchantIdentities.map((identity) =>
    merchantSchema.parse({
      ...identity,
      aliases: [...identity.aliases],
      regexPatterns: [],
      region: "AT",
      source: "local",
      requiresCategoryEvidence: true,
      license: "Local factual merchant rules; no logo rights asserted",
      attribution: `Finanzblick: verified public identity https://www.wikidata.org/wiki/${identity.wikidataId}`,
      updatedAt: Date.UTC(2026, 9, 10, 0, 0),
    }),
  ),
];

interface AliasEntry {
  text: string;
  merchants: Set<Merchant>;
  ambiguous?: true;
}

function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index < text.length - 1; index++)
    grams.add(text.slice(index, index + 2));
  return grams;
}

function windows(tokens: string[]): string[] {
  const phrases = new Set<string>();
  for (let start = 0; start < tokens.length; start++) {
    for (
      let size = 1;
      size <= MAX_ALIAS_TOKENS && start + size <= tokens.length;
      size++
    ) {
      phrases.add(tokens.slice(start, start + size).join(" "));
    }
  }
  return [...phrases];
}

// A single insertion, deletion, substitution or adjacent transposition.
function oneEditApart(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let first = 0;
  while (
    first < Math.min(left.length, right.length) &&
    left[first] === right[first]
  )
    first++;
  if (first === Math.min(left.length, right.length))
    return left.length !== right.length;
  if (left.length === right.length) {
    return (
      left.slice(first + 1) === right.slice(first + 1) ||
      (left[first] === right[first + 1] &&
        left[first + 1] === right[first] &&
        left.slice(first + 2) === right.slice(first + 2))
    );
  }
  return left.length > right.length
    ? left.slice(first + 1) === right.slice(first)
    : left.slice(first) === right.slice(first + 1);
}

const unresolved = (
  method: MerchantMatch["method"] = "none",
): MerchantMatch => ({ requiresManualReview: true, method });
function resolved(
  matches: Set<Merchant>,
  method: MerchantMatch["method"],
): MerchantMatch {
  const merchant = matches.values().next().value;
  if (!merchant || matches.size !== 1) return unresolved(method);
  return {
    merchant,
    requiresManualReview:
      method === "fuzzy" || merchant.defaultCategory === null,
    method,
  };
}

export function normalizeMerchantDescriptor(text: string): string {
  return normalizeMerchantText(text)
    .replace(
      /\bpay\s*pal(?:\s+europe)?(?:\s+s\s+a\s+r\s+l(?:\s+et\s+cie)?(?:\s+s\s+c\s+a)?)?/gi,
      " ",
    )
    .replace(new RegExp(providers.source, "gi"), " ")
    .replace(
      /^(?:(?:lastschrift|purchase|card payment|payment|bezahlung|bezahlt bei|einkauf bei)\s+)+/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Snapshot index: construct again after database changes. Regex and fuzzy work
 * are globally bounded. Saturated fuzzy buckets fail closed, never pick a subset.
 * Unique fuzzy matches need >=6 characters, >=85% similarity and only one edit.
 */
export class MerchantIndex {
  private readonly exact = new Map<string, AliasEntry>();
  private readonly regex: { merchant: Merchant; pattern: RegExp }[] = [];
  private readonly fuzzy = new Map<string, Set<AliasEntry> | null>();
  private readonly identities = new Map<
    string,
    { original: Merchant; representative: Merchant }
  >();

  constructor(merchants: Merchant[]) {
    if (merchants.length > 10_000)
      throw new RangeError("Merchant index supports at most 10,000 merchants.");
    const ids = new Set<string>();
    const definitions = merchants.map((source) => merchantSchema.parse(source));
    const groups = new Map<
      string,
      { representative: Merchant; members: Merchant[] }
    >();
    for (const merchant of definitions) {
      if (ids.has(merchant.id))
        throw new Error(`Duplicate merchant ID: ${merchant.id}`);
      ids.add(merchant.id);
      const key = merchant.wikidataId
        ? JSON.stringify([
            merchant.wikidataId,
            merchant.region,
            normalizeMerchantText(merchant.canonicalName),
            merchant.defaultCategory,
            merchant.requiresCategoryEvidence,
          ])
        : JSON.stringify([merchant.id]);
      const group = groups.get(key);
      if (!group)
        groups.set(key, { representative: merchant, members: [merchant] });
      else {
        group.members.push(merchant);
        if (
          (merchant.source === "local" &&
            group.representative.source !== "local") ||
          ((merchant.source === "local") ===
            (group.representative.source === "local") &&
            merchant.id.localeCompare(group.representative.id) < 0)
        )
          group.representative = merchant;
      }
    }
    for (const { representative, members } of groups.values())
      for (const original of members)
        this.identities.set(original.id, { original, representative });
    for (const source of definitions) {
      const identity = this.identities.get(source.id);
      if (!identity) throw new Error("Merchant identity was not indexed.");
      const merchant = identity.representative;
      for (const name of [source.canonicalName, ...source.aliases]) {
        const text = normalizeMerchantText(name);
        const entry = this.exact.get(text) ?? {
          text,
          merchants: new Set<Merchant>(),
        };
        entry.merchants.add(merchant);
        this.exact.set(text, entry);
        if (this.exact.size > MAX_MERCHANT_ALIASES)
          throw new RangeError(
            "Merchant index supports at most 40,000 aliases.",
          );
      }
      for (const pattern of source.regexPatterns) {
        if (this.regex.length >= MAX_REGEX_PATTERNS)
          throw new RangeError("Too many merchant regex patterns.");
        this.regex.push({ merchant, pattern: new RegExp(pattern, "iu") });
      }
    }
    for (const entry of this.exact.values()) {
      if (entry.merchants.size > 1) {
        entry.ambiguous = true;
        entry.merchants.clear();
      }
      if (entry.text.length < 6) continue;
      for (const gram of bigrams(entry.text)) {
        const key = `${entry.text.length}:${gram}`;
        const bucket = this.fuzzy.get(key);
        if (bucket === null) continue;
        const entries = bucket ?? new Set<AliasEntry>();
        entries.add(entry);
        this.fuzzy.set(key, entries.size > MAX_POSTING ? null : entries);
      }
    }
  }

  private preserveIdentity(
    result: MerchantMatch,
    preferredId?: string,
  ): MerchantMatch {
    const identity = preferredId ? this.identities.get(preferredId) : undefined;
    return identity && identity.representative === result.merchant
      ? { ...result, merchant: identity.original }
      : result;
  }

  match(text: string, preferredId?: string): MerchantMatch {
    if (text.length > MAX_INPUT) return unresolved();
    // Remove IDs before providers: stripping "Stripe" inside an ID must not
    // expose its remaining "BILLA" component as a merchant.
    const normalized = normalizeMerchantDescriptor(text);
    if (!normalized) return unresolved();
    const tokens = normalized.split(" ");
    if (tokens.length > MAX_TOKENS) return unresolved();
    const phrases = windows(tokens);
    const exactMatches = new Set<Merchant>();
    for (const phrase of phrases) {
      const entry = this.exact.get(phrase);
      if (entry?.ambiguous) return unresolved("exact");
      for (const merchant of entry?.merchants ?? []) exactMatches.add(merchant);
    }
    const regexMatches = new Set<Merchant>();
    for (const { merchant, pattern } of this.regex) {
      if (pattern.test(normalized)) regexMatches.add(merchant);
    }
    // Check regex conflicts even when an exact alias exists.
    if (exactMatches.size) {
      const result = resolved(
        new Set([...exactMatches, ...regexMatches]),
        "exact",
      );
      if (!result.merchant) return result;
      const merchant = result.merchant;
      const leading = phrases.some((phrase) =>
        normalized.startsWith(`${phrase} `) || normalized === phrase
          ? this.exact.get(phrase)?.merchants.has(merchant)
          : false,
      );
      return leading
        ? this.preserveIdentity(result, preferredId)
        : unresolved("exact");
    }
    if (regexMatches.size) {
      const result = resolved(regexMatches, "regex");
      return !result.merchant ||
        this.regex.some(
          (entry) =>
            entry.merchant === result.merchant &&
            entry.pattern.exec(normalized)?.index === 0,
        )
        ? this.preserveIdentity(result, preferredId)
        : unresolved("regex");
    }
    return this.preserveIdentity(this.matchFuzzy(phrases), preferredId);
  }

  private matchFuzzy(phrases: string[]): MerchantMatch {
    const matches = new Set<Merchant>();
    let comparisons = 0;
    for (const phrase of phrases) {
      if (phrase.length < 6 || phrase.length > 100) continue;
      const candidates = new Set<AliasEntry>();
      for (const gram of bigrams(phrase)) {
        for (
          let length = phrase.length - 1;
          length <= phrase.length + 1;
          length++
        ) {
          const bucket = this.fuzzy.get(`${length}:${gram}`);
          if (bucket === null) return unresolved("fuzzy");
          for (const entry of bucket ?? []) {
            candidates.add(entry);
            if (candidates.size > MAX_FUZZY_CANDIDATES)
              return unresolved("fuzzy");
          }
        }
      }
      for (const entry of candidates) {
        if (++comparisons > MAX_FUZZY_CANDIDATES) return unresolved("fuzzy");
        if (
          1 - 1 / Math.max(phrase.length, entry.text.length) >= 0.85 &&
          oneEditApart(phrase, entry.text)
        ) {
          if (entry.ambiguous) return unresolved("fuzzy");
          for (const merchant of entry.merchants) matches.add(merchant);
        }
      }
    }
    return matches.size ? resolved(matches, "fuzzy") : unresolved();
  }
}
