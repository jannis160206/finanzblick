import { canonicalCategory, type Category } from "@/lib/categories";

export type ContractType = "streaming" | "mobile" | "internet" | "insurance" | "energy" | "gym" | "software" | "other";

export const contractTypeRules: [ContractType, RegExp][] = [
  ["streaming", /netflix|spotify|disney|dazn|sky\b|wow\b|joyn|paramount|apple tv|youtube|amazon prime|prime video|audible|deezer|tidal|crunchyroll|magenta tv/],
  ["mobile", /handy|mobil|spusu|\bhot\b|hofer telekom|\bdrei\b|\b3\b|magenta|\ba1\b|yesss|bob\b|georg|educom|lidl connect|tele2/],
  ["internet", /internet|breitband|glasfaser|kabel|liwest|salzburg ag|upc|wlan/],
  ["insurance", /versicherung|uniqa|generali|allianz|wiener städtische|wiener staedtische|grawe|donau|zürich|zuerich|helvetia|merkur|ergo|muki|haftpflicht|kasko/],
  ["energy", /strom|gas|energie|verbund|wien energie|evn|kelag|energie ag|tiwag|vkw|illwerke|e-control|maxenergy|go green/],
  ["gym", /fitness|gym|mcfit|clever fit|john harris|injoy|holmes place|urban sports|fitinn|fit inn/],
  ["software", /apple|icloud|google one|microsoft|office 365|adobe|dropbox|chatgpt|openai|1password|nordvpn|canva|duolingo|github/],
];

export function contractTypeOf(merchant: string, category: Category): ContractType {
  const text = merchant.toLowerCase();
  const canonical = canonicalCategory(category);
  const hit = contractTypeRules.find(([, pattern]) => pattern.test(text));
  if (hit) return hit[0];
  if (canonical === "Versicherungen") return "insurance";
  if (canonical === "Telefon & Internet") return "mobile";
  if (canonical === "Energie & Nebenkosten") return "energy";
  if (canonical === "Abonnements") return "streaming";
  return "other";
}

// Generic consumer-law information for Austria; deliberately phrased as "meist", never as legal advice.
export const contractNotice: Record<ContractType, { label: string; text: string; days: number }> = {
  streaming: { label: "Streaming/Abo", text: "Meist monatlich kündbar, wirkt zum Ende des bezahlten Zeitraums.", days: 3 },
  mobile: { label: "Handy", text: "Meist 1 Monat Kündigungsfrist, frühestens nach Ablauf der Mindestvertragsdauer (oft 12–24 Monate).", days: 35 },
  internet: { label: "Internet", text: "Meist 1 Monat Kündigungsfrist, frühestens nach Ablauf der Mindestvertragsdauer.", days: 35 },
  insurance: { label: "Versicherung", text: "Meist zum Ende der Versicherungsperiode mit 1 Monat Frist (§ 8 VersVG); nach 3 Jahren Laufzeit jährlich kündbar.", days: 40 },
  energy: { label: "Strom/Gas", text: "Haushalte können meist mit 2 Wochen Frist wechseln; der neue Anbieter erledigt die Kündigung oft für dich.", days: 14 },
  gym: { label: "Fitnessstudio", text: "Frist laut Vertrag – meist 1 bis 3 Monate, oft erst nach der Mindestlaufzeit.", days: 95 },
  software: { label: "Software/Cloud", text: "Meist monatlich oder zum Ende der Jahreslaufzeit kündbar.", days: 7 },
  other: { label: "Vertrag", text: "Frist laut Vertrag oder AGB prüfen.", days: 35 },
};
