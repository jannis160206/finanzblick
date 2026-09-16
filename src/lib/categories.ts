// Display categories describe a purpose, not a payment provider or contract.
export const categoryGroups = [
  { label: "Alltag", categories: ["Lebensmittel", "Mittagessen", "Ausgehen", "Shopping", "Drogerie", "Gesundheit", "Körperpflege"] },
  { label: "Freizeit & Leben", categories: ["Entertainment", "Freizeit", "Sport & Fitness", "Bildung", "Geschenke & Spenden", "Haustiere", "Urlaub"] },
  { label: "Wohnen & Mobilität", categories: ["Wohnen & Haushalt", "Mobilität", "Leasing"] },
  { label: "Verträge & Gebühren", categories: ["Abonnements", "Versicherungen", "Telefon & Internet", "Bankgebühren"] },
  { label: "Einnahmen", categories: ["Gehalt", "Rufbereitschaft", "Einkommen"] },
  { label: "Sonstiges & Umbuchungen", categories: ["Sonstiges", "Transfer", "Transfer intern", "Prüfen"] },
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
} as const satisfies Record<string, CurrentCategory>;
export type Category = CurrentCategory | keyof typeof categoryAliases;
export const allCategories: Category[] = [...categories, ...Object.keys(categoryAliases) as (keyof typeof categoryAliases)[]];
// Legacy values remain accepted at input boundaries; they are never offered in selectors.
export function canonicalCategory(category: Category): Category {
  return categoryAliases[category as keyof typeof categoryAliases] ?? category;
}
export const groupedContractCategories: readonly Category[] = ["Abonnements", "Versicherungen", "Telefon & Internet", "Bankgebühren"];

const suggestions: [RegExp, Category][] = [
  [/kontof[uü]hrungsgeb[uü]hr|kontogeb[uü]hr|kartengeb[uü]hr|(?:amex|american\s*express).*monatsgeb/i, "Bankgebühren"],
  [/\bspotify\b|\bnetflix\b|disney\s*\+|disney\s*plus|youtube\s*premium|apple\s*music|icloud\s*\+?|microsoft\s*365|adobe\s*(?:creative|acrobat)|chatgpt|nordvpn/i, "Abonnements"],
  [/\b(?:abo|abonnement|subscription|recurring)\b|wiederkehrend/i, "Abonnements"],
  [/\bkino\b|cinema|cineplexx|cinemaxx|eventim|ticketmaster|oeticket|\bsteam(?:games)?\b|playstation|nintendo|xbox/i, "Entertainment"],
  [/fitnessstudio|\bfitinn\b|\bmcfit\b|\bfitx\b|sportverein|\bdecathlon\b|\bintersport\b/i, "Sport & Fitness"],
  [/\budemy\b|\bcoursera\b|buchhandlung|\bthalia\b|studiengeb[uü]hr|kursgeb[uü]hr/i, "Bildung"],
  [/\bfressnapf\b|\bzooplus\b|tierarzt|tierbedarf/i, "Haustiere"],
  [/\bspende\b|\bcaritas\b|rotes\s*kreuz|geschenk/i, "Geschenke & Spenden"],
  [/\bapotheke\b|\barzt\b|zahnarzt|krankenhaus|optiker|\bfielmann\b/i, "Gesundheit"],
  [/\bdm\b|dm-drogerie|\bmueller\s*drogerie\b|\bmüller\s*drogerie\b/i, "Drogerie"],
  [/\bbarber\b|fris[eö]ur|friseur|frisör|kosmetikstudio/i, "Körperpflege"],
  [/\bikea\b|\bmömax\b|\bmoemax\b|\bxxxlutz\b|\bhornbach\b|\bobi\b|\bbauhaus\b|\bmiete\b|stromrechnung|heizkosten/i, "Wohnen & Haushalt"],
  [/\boebb\b|\böbb\b|\bwestbahn\b|\bflixbus\b|\buber\b|\btaxi\b|parkgeb[uü]hr|\bparken\b/i, "Mobilität"],
];
export function suggestCategory(text: string): Category | undefined {
  const matches = new Set(suggestions.filter(([pattern]) => pattern.test(text)).map(([, category]) => category));
  return matches.size > 1 ? "Prüfen" : [...matches][0];
}

export const groceryMerchant = /\bbilla\b|\b(?:inter|euro)?spar\b|\bpenny\b/i;
export const amazonMerchant = /\bamazon\b|\bamzn?\b|\bamz-shop\b|\bprime\b/i;
const merchantCategories: [RegExp, Category][] = [
  [/\bbipa\b|\bhotspot\b|\bmensa\b|\bmensen\b/i, "Mittagessen"],
  [/\btrafik\b/i, "Shopping"],
  [groceryMerchant, "Lebensmittel"],
  [/\bshell\b|\bomv\b|\beni\b|\bpace\s*pay\b|tankstelle|tanken/i, "Mobilität"],
  [/\bmc\s*donald'?s?\b|\bmcd\b|burger|pizzeria|\bgams\b|sakura|wolt|foodora|burgschenke/i, "Ausgehen"],
  [/\bmartin\s+auer\b|\bg2a\b/i, "Freizeit"],
  [/\bdm\b|dm-fil|dm-drogerie/i, "Drogerie"],
  [amazonMerchant, "Shopping"],
  [/porsche\s*bank|\bleasing\b/i, "Leasing"],
  [/allianz|vollkasko|haftpflicht|apple[\s+-]*care/i, "Versicherungen"],
  [/\ba1\b|handy(?:vertrag)?|telekom/i, "Telefon & Internet"],
  [/\bbarber\b/i, "Körperpflege"],
];
// Contradictory merchant signals are not a reason to choose the first regex.
export function knownMerchantCategory(text: string, amount: number): Category | undefined {
  const matches = new Set(merchantCategories.filter(([pattern]) => pattern.test(text)).map(([, category]) => category));
  const suggested = suggestCategory(text);
  if (suggested && !(matches.has("Shopping") && amazonMerchant.test(text) && suggested === "Abonnements")) matches.add(suggested);
  if (/\batm\b|\bbankomat\b/i.test(text.replace(/\bban[ck]omat\s*\/\s*pos\b/gi, "")))
    matches.add(Math.abs(amount) === 20 ? "Körperpflege" : "Prüfen");
  return matches.size > 1 ? "Prüfen" : [...matches][0];
}
