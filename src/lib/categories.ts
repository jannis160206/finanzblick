// Display categories describe a purpose, not a payment provider or contract.
export const categoryGroups = [
  { label: "Alltag", categories: ["Lebensmittel", "Mittagessen", "Restaurants", "Lieferdienste", "Cafés & Snacks", "Shopping", "Guthabenkarten", "Porto & Versand", "Drogerie", "Gesundheit", "Körperpflege"] },
  { label: "Freizeit & Leben", categories: ["Entertainment", "Freizeit", "Sport & Fitness", "Bildung", "Weiterbildung", "Geschenke & Spenden", "Haustiere", "Urlaub"] },
  { label: "Wohnen & Mobilität", categories: ["Wohnen & Haushalt", "Miete", "Energie & Nebenkosten", "Möbel & Einrichtung", "Reparaturen & Instandhaltung", "Mobilität", "Tanken", "Öffentliche Verkehrsmittel", "Parken & Maut", "Fahrzeugwartung", "Leasing"] },
  { label: "Verträge & Gebühren", categories: ["Abonnements", "Versicherungen", "Telefon & Internet", "Bankgebühren", "Rücklastschriftgebühren"] },
  { label: "Einnahmen", categories: ["Gehalt", "Rufbereitschaft", "Einkommen"] },
  { label: "Sonstiges & Umbuchungen", categories: ["Sonstiges", "Rückerstattungen", "Transfer", "Transfer intern", "Prüfen"] },
] as const;
type CurrentCategory = (typeof categoryGroups)[number]["categories"][number];
export const categories = categoryGroups.flatMap((group): CurrentCategory[] => [...group.categories]);
export const categoryAliases = {
  "Spotify": "Abonnements",
  "PayPal Abo": "Abonnements",
  "Vollkasko": "Versicherungen",
  "Haftpflicht": "Versicherungen",
  "Apple Care": "Versicherungen",
  "Handyvertrag": "Telefon & Internet",
  "AMEX Monatsgebühr": "Bankgebühren",
  "Barber": "Körperpflege",
  "Ausgehen": "Restaurants",
  "Kleidung & Schuhe": "Shopping",
  "Elektronik": "Shopping",
  "Bücher": "Bildung",
  "Unterkunft": "Urlaub",
  "Flugreisen": "Urlaub",
} as const satisfies Record<string, CurrentCategory>;
export type Category = CurrentCategory | keyof typeof categoryAliases;
export const allCategories: Category[] = [...categories, ...Object.keys(categoryAliases) as (keyof typeof categoryAliases)[]];
// Legacy values remain accepted at input boundaries; they are never offered in selectors.
export function canonicalCategory(category: Category): Category {
  return categoryAliases[category as keyof typeof categoryAliases] ?? category;
}
// Shops visited regularly (groceries, fuel, delivery) are spending, never a contract, subscription or price increase.
const everydaySpending = new Set<Category>([
  "Lebensmittel", "Mittagessen", "Restaurants", "Lieferdienste", "Cafés & Snacks", "Tanken", "Mobilität", "Drogerie",
  "Rückerstattungen", "Transfer", "Transfer intern", "Gehalt", "Einkommen", "Rufbereitschaft",
]);
export const isEverydayCategory = (category: Category) => everydaySpending.has(canonicalCategory(category));
export const groupedContractCategories: readonly Category[] = ["Abonnements", "Versicherungen", "Telefon & Internet", "Bankgebühren", "Miete", "Energie & Nebenkosten"];
export const travelCategories: readonly Category[] = ["Urlaub"];
export const isTravelCategory = (category: Category) => travelCategories.includes(canonicalCategory(category));

const suggestions: [RegExp, Category][] = [
  [/kontof[uü]hrungsgeb[uü]hr|kontogeb[uü]hr|kartengeb[uü]hr|bankgeb[uü]hr|kontof[uü]hrungsentgelt|\bkontokosten\b|\bentgelt\s+f[uü]r\s+(?:die\s+)?kontof[uü]hrung\b|(?:amex|american\s*express).*monatsgeb/i, "Bankgebühren"],
  [/\br(?:ü|ue|u)cklastschrift[-\s]*(?:geb(?:ü|ue|u)hr(?:en)?|entgelte?|kosten)\b|\b(?:geb(?:ü|ue|u)hr(?:en)?|entgelte?|kosten)\s+(?:f[uü]r|wegen)\s+(?:(?:eine|einer|der)\s+)?r(?:ü|ue|u)cklastschrift\b|\bgeb(?:ü|ue|u)hr(?:en)?\s+f(?:ü|ue|u)r\s+(?:eine\s+)?retournierte\s+lastschrift\b/i, "Rücklastschriftgebühren"],
  [/\bspotify\b|\bnetflix\b|disney\s*\+|disney\s*plus|youtube\s*premium|apple\s*music|icloud\s*\+?|microsoft\s*365|adobe\s*(?:creative|acrobat)|chatgpt|nordvpn/i, "Abonnements"],
  [/\b(?:abo|abonnement|subscription|recurring)\b|wiederkehrend/i, "Abonnements"],
  [/\bkino\b|cinema|cineplexx|cinemaxx|eventim|ticketmaster|oeticket|\bsteam(?:games)?\b|playstation|nintendo|xbox|epic\s*games|riot\s*games|battle\.net/i, "Entertainment"],
  [/europa[\s-]*park|freizeitpark|\btherme\b|\btierpark\b|\bzoo\b|minimundus|\bescape\s*room|\bwin2day\b|\btipico\b|\bbwin\b|\bcasino\b|\blotto\b/i, "Freizeit"],
  [/fitnessstudio|\bfitinn\b|\bmcfit\b|\bfitx\b|sportverein|\bdecathlon\b|\bintersport\b|deporvillag/i, "Sport & Fitness"],
  [/\budemy\b|\bcoursera\b|buchhandlung|\bthalia\b|studiengeb[uü]hr|kursgeb[uü]hr/i, "Bildung"],
  [/\bfressnapf\b|\bzooplus\b|tierarzt|tierbedarf/i, "Haustiere"],
  [/\bspende\b|\bcaritas\b|rotes\s*kreuz|geschenk|geburtstag|\bblumen\b|florist|fleurop/i, "Geschenke & Spenden"],
  [/\bapotheke\b|\barzt\b|zahnarzt|krankenhaus|optiker|\bfielmann\b|\bordination\b/i, "Gesundheit"],
  // Card texts of a practice start with the title: "DR LEGRADI VILLACH 9500".
  [/^(?!.*(?:anwalt|notar|steuerber|kanzlei))\s*dr\.?\s+(?:med\.?\s+)?\p{L}{3,}/iu, "Gesundheit"],
  [/\bdm\b|dm-drogerie|\bmueller\s*drogerie\b|\bmüller\s*drogerie\b/i, "Drogerie"],
  [/\bbarber\b|fris[eö]ur|friseur|frisör|kosmetikstudio/i, "Körperpflege"],
  [/\bg2a\b|\bkinguin(?:\s+digital)?\b|\beneba\b|\bmmoga\b|instant[\s-]*gaming|eldorado[\s.]*gg\b|\bguthabenkarten?\b|\b(?:apple|itunes)[\s-]*guthaben\b|\bpaysafecard\b/i, "Guthabenkarten"],
  [/\b(?:dhl|dpd|gls|ups|fedex)\b|general\s*logistics\s*systems|(?:^|\W)(?:österreichische|oesterreichische|deutsche|schweizer(?:ische)?)\s+post\b|\bpost\s*(?:ag|filiale)\b|\bpost\.(?:at|de|ch)\b|\bhermes\s*(?:paket|versand|germany)|\b(?:briefmarken?|paketmarken?|portogeb[uü]hr|paketversand)\b|^\s*post(?=\s|$)/i, "Porto & Versand"],
  [/\bikea\b|\bmömax\b|\bmoemax\b|\bxxxlutz\b/i, "Möbel & Einrichtung"],
  [/\bhornbach\b|\bobi\b|\bbauhaus\b|\bmiete\b|stromrechnung|heizkosten/i, "Wohnen & Haushalt"],
  [/\boebb\b|\böbb\b|\bwestbahn\b|\bflixbus\b|\bpostbus\b|wiener\s*linien|graz\s*linien|\bdeutsche\s*bahn\b|\btrenitalia\b|\bregiojet\b|\bsbb\s*(?:cff|ticket|app)\b/i, "Öffentliche Verkehrsmittel"],
  [/\bpark(?:haus|garage|platz|deck|automat|ticket|geb[uü]hr|sheriff)\w*|(?:park|tief|theater|stadt|city)garage|\bparken\b|\bapcoa\b|\bcontipark\b|\beasypark\b|handy\s*parken|\bparkster\b|\basfinag\b|\bvignette\b|\bmaut(?:stelle)?\b/i, "Parken & Maut"],
  [/\buber\b(?!\s*eats\b)|\btaxi\b/i, "Mobilität"],
];
export function suggestCategory(text: string): Category | undefined {
  const matches = new Set(suggestions.filter(([pattern]) => pattern.test(text)).map(([, category]) => category));
  return matches.size > 1 ? "Prüfen" : [...matches][0];
}

export const groceryMerchant = /\bbilla\b|\b(?:inter|euro)?spar\b|\bpenny\b/i;
export const amazonMerchant = /\bamazon\b|\bamzn?\b|\bamz-shop\b|\bprime\b/i;
const merchantCategories: [RegExp, Category][] = [
  [/\bbipa\b|\bhotspot\b|\bmensa\b|\bmensen\b/i, "Mittagessen"],
  // Tobacco, lottery and magazines: this household files a Trafik as leisure.
  [/\btrafik\b/i, "Freizeit"],
  [groceryMerchant, "Lebensmittel"],
  [/\bshell\b|\bomv\b|\beni\b|\bpace\s*pay\b|tankstelle|tanken/i, "Mobilität"],
  [/\bmc\s*donald'?s?\b|\bmcd\b|burger|pizzeria|sakura|burgschenke|\brestaurants?\b|\bgasthaus\b/i, "Restaurants"],
  [/\bwolt\b|\bfoodora\b|\blieferando\b|\blieferdienst\b|\buber\s*eats\b/i, "Lieferdienste"],
  [/\bmartin\s+auer\b|\bgams\b|\bstarbucks\b|\bcaf[eé]s?(?=\W|$)|\bsnacks?\b/i, "Cafés & Snacks"],
  [/\bdm\b|dm-fil|dm-drogerie/i, "Drogerie"],
  [amazonMerchant, "Shopping"],
  [/(?:^|\|)\s*h\s*&?\s*m\s+(?!\d)|\bh&m\b|\bzara\b|\bprimark\b|\bc&a\b|\bdeichmann\b|\bzalando\b|about\s*you\b|\bnew\s*yorker\b|\bmedia\s*markt\b|\bmediamarkt\b|\bsaturn\b|\betsy\b|\batrio\b/i, "Shopping"],
  [/porsche\s*bank|\bleasing\b/i, "Leasing"],
  [/allianz|vollkasko|haftpflicht|apple[\s+-]*care/i, "Versicherungen"],
  [/\ba1\b|handy(?:vertrag)?|telekom/i, "Telefon & Internet"],
  [/\bbarber\b/i, "Körperpflege"],
];
// The words a fixed keyword rule matched ("trafik", "omv", "tankstelle"): shops sharing such
// a word are comparable, so the household's own choices for them can refine the rule.
export function merchantKeywords(text: string): string[] {
  const words = new Set<string>();
  for (const [pattern] of [...merchantCategories, ...suggestions]) {
    const match = pattern.exec(text)?.[0].normalize("NFKC").toLocaleLowerCase("de-AT").replace(/\s+/g, " ").trim();
    if (match) words.add(match);
  }
  return [...words];
}
// Contradictory merchant signals are not a reason to choose the first regex.
const lodging = /\bhotel\b|\bhostel\b|\bairbnb\b|booking\.com|\bmotel\b/i;
export function knownMerchantCategory(text: string, amount: number): Category | undefined {
  const matches = new Set(merchantCategories.filter(([pattern]) => pattern.test(text)).map(([, category]) => category));
  // A drink at a local hotel is leisure; only a real stay is travel.
  if (lodging.test(text) && amount <= -50) matches.add("Urlaub");
  // Amex confirms the repayment from the giro; Amex sometimes drops the umlaut.
  if (amount > 0 && /zahlung\s*\/\s*(?:ü|ue|u)berweisung\s+erhalten/i.test(text)) return "Transfer intern";
  const suggested = suggestCategory(text);
  if (suggested && !(matches.has("Shopping") && amazonMerchant.test(text) && suggested === "Abonnements")) matches.add(suggested);
  if (/\batm\b|\bbankomat\b/i.test(text.replace(/\bban[ck]omat\s*\/\s*pos\b/gi, "")))
    matches.add(Math.abs(amount) === 20 ? "Körperpflege" : "Prüfen");
  return matches.size > 1 ? "Prüfen" : [...matches][0];
}
