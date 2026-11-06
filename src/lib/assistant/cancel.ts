import { round } from "@/lib/calc";
import { canonicalCategory } from "@/lib/categories";
import { currency, dateLabel } from "@/lib/format";
import { detectSubscriptions, ledger, type Subscription } from "@/lib/insights";
import type { AppState, AssistantCard } from "@/lib/types";
import { matchName } from "./tools";

type Result = { text: string; card?: AssistantCard; suggestions?: string[] };
type Line = AssistantCard["lines"][number];
type Link = NonNullable<AssistantCard["links"]>[number];

// Kündigungshilfe: recognises contracts from recurring charges, explains typical notice rules and writes the letter.
export const cancelQuestion = (lower: string) =>
  /k(?:ü|ue)ndig|k(?:ü|ue)ndbar|vertr(?:ä|ae)ge?\b.*\b(?:loswerden|beenden|aufl(?:ö|oe)sen)|abo\b.*\b(?:loswerden|beenden|abbestellen)|abbestellen/.test(lower) &&
  !/kündigungsfrist.*erinner|erinner.*kündig|was w(?:ä|ae)re|\bwenn ich\b|\bw(?:ü|ue)rde\b|\bh(?:ä|ae)tte\b|spar(?:e|t|en) ich|was bringt|^was (?:ist|bedeutet)|gekündigt\b.*\b(?:gehalt|job|arbeit)|mein (?:job|arbeitgeber|dienstverhältnis)/.test(lower);
const listQuestion = (lower: string) =>
  /welche (?:vertr(?:ä|ae)ge|abos?|abonnements)|was kann ich k(?:ü|ue)ndigen|alle (?:vertr(?:ä|ae)ge|abos)|k(?:ü|ue)ndbar/.test(lower);

export type ContractType = "streaming" | "mobile" | "internet" | "insurance" | "energy" | "gym" | "software" | "other";
const typeRules: [ContractType, RegExp][] = [
  ["streaming", /netflix|spotify|disney|dazn|sky\b|wow\b|joyn|paramount|apple tv|youtube|amazon prime|prime video|audible|deezer|tidal|crunchyroll|magenta tv/],
  ["mobile", /handy|mobil|spusu|\bhot\b|hofer telekom|\bdrei\b|\b3\b|magenta|\ba1\b|yesss|bob\b|georg|educom|lidl connect|tele2/],
  ["internet", /internet|breitband|glasfaser|kabel|liwest|salzburg ag|upc|wlan/],
  ["insurance", /versicherung|uniqa|generali|allianz|wiener städtische|wiener staedtische|grawe|donau|zürich|zuerich|helvetia|merkur|ergo|muki|haftpflicht|kasko/],
  ["energy", /strom|gas|energie|verbund|wien energie|evn|kelag|energie ag|tiwag|vkw|illwerke|e-control|maxenergy|go green/],
  ["gym", /fitness|gym|mcfit|clever fit|john harris|injoy|holmes place|urban sports|fitinn|fit inn/],
  ["software", /apple|icloud|google one|microsoft|office 365|adobe|dropbox|chatgpt|openai|1password|nordvpn|canva|duolingo|github/],
];
const typeOf = (subscription: Subscription): ContractType => {
  const text = subscription.merchant.toLowerCase();
  const category = canonicalCategory(subscription.category);
  const hit = typeRules.find(([, pattern]) => pattern.test(text));
  if (hit) return hit[0];
  if (category === "Versicherungen") return "insurance";
  if (category === "Telefon & Internet") return "mobile";
  if (category === "Energie & Nebenkosten") return "energy";
  if (category === "Abonnements") return "streaming";
  return "other";
};

// Generic consumer-law information for Austria; deliberately phrased as "meist", never as legal advice.
const notice: Record<ContractType, { label: string; text: string; days: number }> = {
  streaming: { label: "Streaming/Abo", text: "Meist monatlich kündbar, wirkt zum Ende des bezahlten Zeitraums.", days: 3 },
  mobile: { label: "Handy", text: "Meist 1 Monat Kündigungsfrist, frühestens nach Ablauf der Mindestvertragsdauer (oft 12–24 Monate).", days: 35 },
  internet: { label: "Internet", text: "Meist 1 Monat Kündigungsfrist, frühestens nach Ablauf der Mindestvertragsdauer.", days: 35 },
  insurance: { label: "Versicherung", text: "Meist zum Ende der Versicherungsperiode mit 1 Monat Frist (§ 8 VersVG); nach 3 Jahren Laufzeit jährlich kündbar.", days: 40 },
  energy: { label: "Strom/Gas", text: "Haushalte können meist mit 2 Wochen Frist wechseln; der neue Anbieter erledigt die Kündigung oft für dich.", days: 14 },
  gym: { label: "Fitnessstudio", text: "Frist laut Vertrag – meist 1 bis 3 Monate, oft erst nach der Mindestlaufzeit.", days: 95 },
  software: { label: "Software/Cloud", text: "Meist monatlich oder zum Ende der Jahreslaufzeit kündbar.", days: 7 },
  other: { label: "Vertrag", text: "Frist laut Vertrag oder AGB prüfen.", days: 35 },
};

const providers: [RegExp, Link][] = [
  [/netflix/, { label: "Netflix kündigen", url: "https://www.netflix.com/cancelplan" }],
  [/spotify/, { label: "Spotify-Abo verwalten", url: "https://www.spotify.com/at/account/subscription/" }],
  [/disney/, { label: "Disney+ kündigen", url: "https://www.disneyplus.com/de-at/commerce/subscription" }],
  [/amazon prime|prime video|amzn prime|amazon\.de prime/, { label: "Amazon Prime verwalten", url: "https://www.amazon.de/amazonprime" }],
  [/apple|icloud/, { label: "Apple-Abo kündigen", url: "https://support.apple.com/de-at/118428" }],
  [/magenta/, { label: "Magenta Kündigung", url: "https://www.magenta.at/kuendigung" }],
  [/\ba1\b/, { label: "A1 Kündigung", url: "https://www.a1.net/kuendigung" }],
  [/\bdrei\b|\b3 ?at\b/, { label: "Drei Kündigung", url: "https://www.drei.at/de/info/kuendigung/" }],
  [/\bhot\b|hofer telekom/, { label: "HoT Kundenbereich", url: "https://www.hot.at/" }],
  [/spusu/, { label: "spusu Kundenbereich", url: "https://www.spusu.at/" }],
];
const compare: Partial<Record<ContractType, Link[]>> = {
  mobile: [{ label: "Preis vergleichen (durchblicker.at)", url: "https://www.durchblicker.at/" }, { label: "tarife.at", url: "https://www.tarife.at/" }],
  internet: [{ label: "Preis vergleichen (durchblicker.at)", url: "https://www.durchblicker.at/" }, { label: "tarife.at", url: "https://www.tarife.at/" }],
  insurance: [{ label: "Preis vergleichen (durchblicker.at)", url: "https://www.durchblicker.at/" }],
  energy: [{ label: "Tarifkalkulator (E-Control)", url: "https://www.e-control.at/tarifkalkulator" }, { label: "durchblicker.at", url: "https://www.durchblicker.at/" }],
};

const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const shortDate = (date: string) => `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}.${date.slice(0, 4)}`;
const yearly = (subscription: Subscription) => round(subscription.monthlyCost * 12);

export function cancellationLetter(merchant: string, type: ContractType, today: string) {
  const what = type === "insurance" ? "meinen Versicherungsvertrag (Polizzennummer: [Polizzennummer])"
    : type === "mobile" || type === "internet" ? "meinen Vertrag (Rufnummer/Kundennummer: [Kundennummer])"
      : "mein Abonnement / meinen Vertrag (Kundennummer: [Kundennummer])";
  const when = type === "insurance" ? "zum Ende der laufenden Versicherungsperiode" : "zum nächstmöglichen Termin";
  return [
    "[Vor- und Nachname]", "[Straße Hausnummer]", "[PLZ Ort]", "[E-Mail]", "",
    merchant, "[Adresse des Anbieters]", "",
    `[Ort], ${shortDate(today)}`, "",
    `Kündigung ${what}`, "",
    "Sehr geehrte Damen und Herren,", "",
    `hiermit kündige ich ${what} ${when}.`,
    "Bitte bestätigen Sie mir die Kündigung schriftlich unter Angabe des Beendigungszeitpunkts.",
    "Eine erteilte Einzugsermächtigung (SEPA-Lastschriftmandat) widerrufe ich mit Wirksamkeit zum Vertragsende.", "",
    "Mit freundlichen Grüßen", "", "[Unterschrift]", "[Vor- und Nachname]",
  ].join("\n");
}

function reminderDate(subscription: Subscription, type: ContractType, today: string) {
  const date = shiftDate(subscription.nextDate, -notice[type].days);
  return date > today ? date : shiftDate(today, 1);
}

function contractCard(state: AppState, subscription: Subscription, today: string): Result {
  const type = typeOf(subscription);
  const info = notice[type];
  const key = subscription.merchant.toLowerCase();
  const charges = ledger(state)
    .filter(({ row }) => row.amount < 0 && (row.merchantAlias?.trim() || row.description.trim().slice(0, 60)).toLowerCase() === key)
    .map(({ row }) => row).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const fallbackIds = charges.length ? charges : ledger(state).map(({ row }) => row)
    .filter((row) => row.amount < 0 && `${row.merchantAlias ?? ""} ${row.description}`.toLowerCase().includes(key)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const provider = providers.find(([pattern]) => pattern.test(key))?.[1];
  const links = [...(provider ? [provider] : []), ...(compare[type] ?? [])].slice(0, 4);
  const change = subscription.priceChange;
  const lines: Line[] = [
    { label: subscription.interval === "jährlich" ? "Pro Jahr" : "Pro Monat", value: subscription.amount },
    { label: "Aufs Jahr gerechnet", value: yearly(subscription), detail: `${subscription.count} Abbuchungen erkannt · ${info.label}` },
    { label: "Letzte Abbuchung", detail: `${dateLabel(subscription.lastDate)} · nächste voraussichtlich ${dateLabel(subscription.nextDate)}`,
      ...(fallbackIds.length ? { transactionIds: fallbackIds.map((row) => row.id) } : {}) },
    change
      ? { label: "Preisentwicklung", detail: `${currency(change.from)} → ${currency(change.to)} seit ${dateLabel(change.date)} (${change.percent > 0 ? "+" : ""}${change.percent.toLocaleString("de-AT", { maximumFractionDigits: 1 })} %)`, tone: change.percent > 0 ? "warn" : "good" }
      : { label: "Preisentwicklung", detail: "Kein Preissprung erkannt" },
    { label: "Kündigungsfrist", detail: info.text },
  ];
  const due = reminderDate(subscription, type, today);
  const reminder = `Erinner mich am ${shortDate(due)}, ${subscription.merchant} zu kündigen`.slice(0, 120);
  return {
    text: `${subscription.merchant} kostet dich ${currency(subscription.amount)} ${subscription.interval === "jährlich" ? "im Jahr" : "im Monat"}, ` +
      `also ${currency(yearly(subscription))} im Jahr. ${info.text} Das Kündigungsschreiben ist fertig – nur noch deine Daten einsetzen.`,
    card: {
      kind: "cancel", title: `Kündigungshilfe · ${subscription.merchant}`.slice(0, 200), total: yearly(subscription), lines,
      letter: cancellationLetter(subscription.merchant, type, today), ...(links.length ? { links } : {}),
      note: "Allgemeine Infos ohne Gewähr, keine Rechtsberatung. Kündige nachweislich (Einschreiben oder E-Mail mit Bestätigung) und prüfe Mindestlaufzeit und AGB.",
    },
    suggestions: [reminder, "Welche Verträge kann ich kündigen?"],
  };
}

function contractList(subscriptions: Subscription[]): Result {
  const sorted = [...subscriptions].sort((a, b) => yearly(b) - yearly(a));
  const total = round(sorted.reduce((sum, item) => sum + yearly(item), 0));
  const lines: Line[] = sorted.slice(0, 40).map((item) => ({
    label: item.merchant.slice(0, 200), value: yearly(item),
    detail: `${currency(item.amount)} ${item.interval} · ${notice[typeOf(item)].label}${item.priceChange && item.priceChange.percent > 0 ? ` · teurer seit ${dateLabel(item.priceChange.date)}` : ""}`,
  }));
  return {
    text: `Ich habe ${sorted.length} laufende ${sorted.length === 1 ? "Vertrag" : "Verträge und Abos"} gefunden, zusammen ${currency(total)} im Jahr. Sortiert nach Jahreskosten:`,
    card: { kind: "cancel", title: "Kündbare Verträge & Abos", total, lines,
      note: "Jahreskosten aus den erkannten Abbuchungen berechnet. Sag „Kündige …“ für Frist, Vergleichslink und fertiges Kündigungsschreiben." },
    suggestions: sorted.slice(0, 3).map((item) => `Kündige ${item.merchant}`.slice(0, 120)),
  };
}

export function cancelAnswer(state: AppState, text: string, today: string): Result {
  const subscriptions = detectSubscriptions(state, today).filter((item) => canonicalCategory(item.category) !== "Miete");
  const lower = text.toLowerCase();
  const match = matchName(text, subscriptions, (item) => item.merchant)
    ?? subscriptions.find((item) => typeRules.some(([type, pattern]) => type === typeOf(item) && pattern.test(lower) && /handy|internet|versicherung|strom|gas|fitness|streaming/.test(lower)));
  if (match && !listQuestion(lower)) return contractCard(state, match, today);
  if (!subscriptions.length) return { text: "Ich habe in deinen Buchungen keine regelmäßigen Abos oder Verträge gefunden. Sobald mindestens zwei gleiche Abbuchungen da sind, erkenne ich sie." };
  if (!listQuestion(lower)) {
    const result = contractList(subscriptions);
    return { ...result, text: `Diesen Vertrag habe ich in deinen Abbuchungen nicht gefunden. ${result.text}` };
  }
  return contractList(subscriptions);
}

