import { round, type Dashboard } from "@/lib/calc";
import { currency } from "@/lib/format";
import type { AssistantCard } from "@/lib/types";
import type { MarketSnapshot } from "@/lib/web/mcp-server";
import { parseAmount } from "./intent";

export type { MarketSnapshot };
type Line = AssistantCard["lines"][number];
type Result = { text: string; card?: AssistantCard; suggestions?: string[] };

// Country, city and currency words that point to a foreign currency. Only these codes are sent to the ECB.
const currencyWords: [string, RegExp][] = [
  ["AUD", /australi|\baud\b/], ["CAD", /kanad|\bcad\b/], ["NZD", /neuseeland|\bnzd\b/], ["SGD", /singapur|\bsgd\b/], ["HKD", /hong ?kong|\bhkd\b/],
  ["USD", /\busa\b|\bus\b|amerika|vereinigte staaten|new york|kalifornien|florida|\bus-?dollar|\bdollar\b|\busd\b/],
  ["JPY", /japan|\byen\b|tokio|tokyo|osaka|kyoto|\bjpy\b/], ["GBP", /england|großbritannien|grossbritannien|london|schottland|\bpfund\b|\bgbp\b|\buk\b/],
  ["CHF", /schweiz|franken|zürich|zuerich|\bchf\b/], ["THB", /thailand|\bbaht\b|bangkok|phuket|\bthb\b/], ["MYR", /malaysia|ringgit|kuala lumpur|\bmyr\b/],
  ["NOK", /norweg|\bnok\b/], ["SEK", /schwed|stockholm|\bsek\b/], ["DKK", /dänemark|daenemark|dänisch|daenisch|kopenhagen|\bdkk\b/],
  ["CZK", /tschech|\bprag\b|\bczk\b/], ["HUF", /ungarn|budapest|forint|\bhuf\b/], ["PLN", /\bpolen\b|zloty|złoty|krakau|warschau|\bpln\b/],
  ["TRY", /türkei|tuerkei|\blira\b|istanbul|antalya|\btry\b/], ["CNY", /china|\byuan\b|renminbi|peking|shanghai|\bcny\b/],
  ["KRW", /korea|seoul|\bwon\b|\bkrw\b/], ["IDR", /indonesi|\bbali\b|rupiah|\bidr\b/], ["MXN", /mexiko|\bpeso\b|\bmxn\b/],
  ["BRL", /brasilien|\breais\b|\bbrl\b/], ["INR", /indien|rupie|\binr\b/], ["ISK", /\bisland\b|isländ|islaend|reykjavik|\bisk\b/],
  ["ZAR", /südafrika|suedafrika|kapstadt|\bzar\b/], ["PHP", /philippinen|\bphp\b/],
];
const otherDollar = ["AUD", "CAD", "NZD", "SGD", "HKD"];
const unitWords = /\b(?:yen|dollar|us-dollar|pfund|franken|baht|ringgit|kronen?|forint|zloty|lira|yuan|won|rupiah|pesos?|reais|rupien)\b/;
const currencyNames: Record<string, string> = {
  USD: "US-Dollar", JPY: "Yen", GBP: "Pfund", CHF: "Franken", THB: "Baht", MYR: "Ringgit", AUD: "Austral-Dollar", CAD: "Kanada-Dollar",
  NOK: "Norw. Kronen", SEK: "Schwed. Kronen", DKK: "Dän. Kronen", CZK: "Tschech. Kronen", HUF: "Forint", PLN: "Złoty", TRY: "Lira", CNY: "Yuan",
  KRW: "Won", IDR: "Rupiah", MXN: "Pesos", BRL: "Reais", INR: "Rupien", ISK: "Isl. Kronen", NZD: "NZ-Dollar", SGD: "Sing.-Dollar", ZAR: "Rand",
  PHP: "Pesos", HKD: "HK-Dollar",
};

export function currenciesIn(text: string): string[] {
  const lower = text.toLowerCase();
  const found = currencyWords.filter(([, pattern]) => pattern.test(lower)).map(([code]) => code);
  const plainUsd = /\busa\b|amerika|vereinigte staaten|us-?dollar|\busd\b/.test(lower);
  return found.filter((code) => code !== "USD" || plainUsd || !found.some((other) => otherDollar.includes(other))).slice(0, 5);
}

const inflationWords = /inflation|teuerung|preissteigerung|kaufkraft|geldentwertung|\bhvpi\b|\bvpi\b|in \d{1,2} jahren (?:noch )?wert|wert in \d{1,2} jahren|was (?:sind|ist) .{1,25} in \d{1,2} jahren/;
const rateWords = /leitzins|\bezb\b|einlagesatz|einlagenzins|sparzins|tagesgeld|festgeld|sparbuch|zinssatz|zinsniveau|(?:welche|wie ?viel|wie hohe?|aktuelle|gute) zinsen|zinsen (?:für|fürs|fuer|am|auf dem|aufs|beim|bei der)\s+\w+|\bzinsen\b.*\b(?:sparkonto|notgroschen|reserve|bank|konto|ersparnis)/;
const fxWords = /wechselkurs|umrechn|\bkurs (?:des|vom|von|für|fuer)\b|devisen|wie viel (?:ist|sind|bekomme ich|kriege ich)\b.*\b(?:in|für|fuer)\s+\w+|marktdaten|\bin\s+(?:yen|dollar|us-dollar|pfund|franken|baht|ringgit|kronen|forint|zloty|lira|yuan|won|rupiah|pesos?|reais|rupien)\b/;

export function marketQuestion(lower: string): boolean {
  if (/zinseszins|\betfs?\b|\bdepot\b|aktien|\bfonds\b|\brendite\b/.test(lower)) return false;
  // Interest already received is a question about the own bookings, not about market rates.
  if (/\bzinsen\b/.test(lower) && /\b(?:hab|habe|hat|wurden?|sind)\b.*\b(?:bekommen|erhalten|gutgeschrieben|kassiert|eingegangen)\b/.test(lower)) return false;
  if (/marktdaten|wirtschaftslage|zinsen und inflation|inflation und zinsen/.test(lower)) return true;
  if (inflationWords.test(lower) || rateWords.test(lower)) return true;
  return fxWords.test(lower) && (currenciesIn(lower).length > 0 || unitWords.test(lower)) || /\d/.test(lower) && unitWords.test(lower) && /\b(?:in|auf)\s+euro\b/.test(lower);
}

const percent = (value: number, digits = 2) => `${value.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: digits })} %`;
const foreign = (value: number, code: string) =>
  `${value.toLocaleString("de-DE", { maximumFractionDigits: value >= 1000 ? 0 : 2 })} ${currencyNames[code] ?? code}`;
const monthNames = ["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const periodLabel = (period: string) => /^\d{4}-\d{2}-\d{2}$/.test(period) ? period.split("-").reverse().join(".")
  : /^\d{4}-\d{2}$/.test(period) ? `${monthNames[Number(period.slice(5)) - 1]} ${period.slice(0, 4)}` : period;

function amounts(text: string): { value: number; unit?: string }[] {
  const clean = text.replace(/\b\d{1,2}\s*(?:jahr\w*|monat\w*|%|prozent)/gi, " ");
  const result: { value: number; unit?: string }[] = [];
  for (const match of clean.matchAll(/(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d{1,2}))?\s*(k\b|tsd|tausend)?\s*(€|euro|eur\b|[a-zäöüł-]+)?/gi)) {
    const value = parseAmount(`${match[1]}${match[2] ? `,${match[2]}` : ""}`);
    if (value === undefined || value <= 0) continue;
    const unit = match[4]?.toLowerCase();
    result.push({ value: match[3] ? value * 1000 : value, unit: unit && unitWords.test(unit) ? unit : undefined });
  }
  return result;
}

function inflationPart(text: string, snapshot: MarketSnapshot, dashboard: Dashboard, lines: Line[]): string | undefined {
  const inflation = snapshot.inflation;
  if (!inflation) return undefined;
  const rate = inflation.value / 100;
  lines.push({ label: "Inflation Österreich", detail: `${percent(inflation.value, 1)} zum Vorjahresmonat · ${periodLabel(inflation.period)}`, tone: inflation.value > 3 ? "warn" : "info" });
  const years = /(\d{1,2})\s*jahr/i.exec(text);
  const amount = amounts(text).find((item) => !item.unit)?.value;
  if (years && amount) {
    const count = Math.min(50, Math.max(1, Number(years[1])));
    const real = round(amount / (1 + rate) ** count);
    lines.push({ label: `Kaufkraft von ${currency(amount)} in ${count} Jahren`, value: real, tone: "warn", detail: `wenn die Inflation bei ${percent(inflation.value, 1)} bleibt` });
    return `${currency(amount)} sind in ${count} Jahren nur noch so viel wert wie heute ${currency(real)}, wenn die Inflation bei ${percent(inflation.value, 1)} bleibt.`;
  }
  const loss = round(dashboard.totalAssets * rate);
  if (loss > 0) lines.push({ label: "Kaufkraftverlust deiner Reserve pro Jahr", value: loss, tone: "warn", detail: `auf ${currency(round(dashboard.totalAssets))} ohne Zinsen` });
  return `Die Inflation in Österreich liegt bei ${percent(inflation.value, 1)} (${periodLabel(inflation.period)}).` +
    (loss > 0 ? ` Unverzinst verliert deine Reserve damit rund ${currency(loss)} Kaufkraft pro Jahr.` : "");
}

function ratesPart(snapshot: MarketSnapshot, dashboard: Dashboard, lines: Line[]): string | undefined {
  const rates = snapshot.rates;
  if (!rates) return undefined;
  const reserve = round(dashboard.totalAssets);
  const yearly = (value: number) => round(reserve * value / 100);
  if (rates.overnight) lines.push({ label: "Tagesgeld / täglich fällig (Ø Banken AT)", ...(reserve > 0 ? { value: yearly(rates.overnight.value) } : {}),
    detail: `${percent(rates.overnight.value)} p. a.${reserve > 0 ? " · Zinsen pro Jahr auf deine Reserve" : ""} · ${periodLabel(rates.overnight.period)}`, tone: "info" });
  if (rates.fixedUpToOneYear) lines.push({ label: "Gebunden bis 1 Jahr (Ø Banken AT)", ...(reserve > 0 ? { value: yearly(rates.fixedUpToOneYear.value) } : {}),
    detail: `${percent(rates.fixedUpToOneYear.value)} p. a. · ${periodLabel(rates.fixedUpToOneYear.period)}`, tone: "info" });
  if (rates.ecbDeposit) lines.push({ label: "EZB-Einlagesatz", detail: `${percent(rates.ecbDeposit.value)} · Richtwert für gute Tagesgeld-Angebote · ${periodLabel(rates.ecbDeposit.period)}`, tone: "info" });
  const parts: string[] = [];
  if (rates.overnight && rates.fixedUpToOneYear)
    parts.push(`Österreichische Banken zahlen im Schnitt ${percent(rates.overnight.value)} fürs täglich verfügbare Sparen und ${percent(rates.fixedUpToOneYear.value)} bei Bindung bis 1 Jahr.`);
  if (rates.ecbDeposit) parts.push(`Der EZB-Einlagesatz liegt bei ${percent(rates.ecbDeposit.value)}; gute Tagesgeld-Angebote kommen nahe an diesen Wert.`);
  const best = rates.ecbDeposit?.value ?? rates.fixedUpToOneYear?.value;
  if (reserve > 0 && rates.overnight && best !== undefined && best > rates.overnight.value)
    parts.push(`Auf deine Reserve von ${currency(reserve)} macht das ${currency(yearly(best) - yearly(rates.overnight.value))} pro Jahr Unterschied.`);
  if (snapshot.inflation && best !== undefined)
    parts.push(best >= snapshot.inflation.value ? "Damit liegst du über der Inflation." : `Selbst damit bleibt man unter der Inflation von ${percent(snapshot.inflation.value, 1)}.`);
  return parts.join(" ") || undefined;
}

function fxPart(text: string, snapshot: MarketSnapshot, lines: Line[]): string | undefined {
  if (!snapshot.fx.length) return undefined;
  const values = amounts(text);
  const sentences: string[] = [];
  for (const rate of snapshot.fx) {
    lines.push({ label: `1 € = ${foreign(rate.value, rate.currency)}`, detail: `EZB-Referenzkurs · ${periodLabel(rate.period)}`, tone: "info" });
    const foreignAmount = values.find((item) => item.unit);
    const euroAmount = values.find((item) => !item.unit);
    if (foreignAmount && snapshot.fx.length === 1) {
      const euro = round(foreignAmount.value / rate.value);
      lines.push({ label: foreign(foreignAmount.value, rate.currency), value: euro });
      sentences.push(`${foreign(foreignAmount.value, rate.currency)} sind aktuell etwa ${currency(euro)}.`);
    } else if (euroAmount) {
      const converted = round(euroAmount.value * rate.value);
      lines.push({ label: `${currency(euroAmount.value)} in ${currencyNames[rate.currency] ?? rate.currency}`, detail: foreign(converted, rate.currency) });
      sentences.push(`${currency(euroAmount.value)} sind aktuell etwa ${foreign(converted, rate.currency)}.`);
    } else sentences.push(`1 € bekommst du aktuell für ${foreign(rate.value, rate.currency)}.`);
  }
  return sentences.join(" ");
}

// Answers market questions from the MCP snapshot; amounts come from code, the internet only provides public rates.
export function marketAnswer(input: string, snapshot: MarketSnapshot | undefined, dashboard: Dashboard): Result {
  if (!snapshot || (!snapshot.inflation && !snapshot.rates && !snapshot.fx.length))
    return { text: "Gerade komme ich nicht an die aktuellen Marktdaten (EZB/Eurostat). Prüf bitte die Internetverbindung und frag gleich noch einmal.",
      suggestions: ["Wie stehe ich finanziell da?"] };
  const text = input.toLowerCase();
  const lines: Line[] = [];
  const wantsFx = currenciesIn(text).length > 0 && (fxWords.test(text) || unitWords.test(text) || /\d/.test(text));
  const wantsInflation = inflationWords.test(text);
  const wantsRates = rateWords.test(text);
  const all = !wantsFx && !wantsInflation && !wantsRates;
  const parts = [
    wantsFx ? fxPart(text, snapshot, lines) : undefined,
    wantsInflation || all ? inflationPart(text, snapshot, dashboard, lines) : undefined,
    wantsRates || all ? ratesPart(snapshot, dashboard, lines) : undefined,
  ].filter((part): part is string => Boolean(part));
  if (!parts.length) return { text: `Die Daten zu ${[wantsFx && "Wechselkursen", wantsInflation && "Inflation", wantsRates && "Zinsen"].filter(Boolean).join(" und ")} sind gerade nicht erreichbar. Versuch es bitte gleich noch einmal.` };
  const sources = [...new Set([snapshot.inflation && lines.some((line) => /Inflation|Kaufkraft/.test(line.label)) ? "Eurostat" : "",
    lines.some((line) => /EZB|Banken|1 €/.test(line.label)) ? "EZB/OeNB" : ""].filter(Boolean))];
  return {
    text: parts.join(" "),
    card: { kind: "answer", title: wantsFx && !wantsInflation && !wantsRates ? "Wechselkurs" : all ? "Marktdaten für deine Planung" : wantsInflation && !wantsRates ? "Inflation" : "Sparzinsen",
      lines: lines.slice(0, 40),
      note: `Live über den MCP-Server „finanzblick-web“ · Quelle: ${sources.join(", ") || "EZB, Eurostat"}. Ans Internet gehen nur öffentliche Abfragen, keine Daten von dir. Keine Anlageberatung.` },
    suggestions: wantsFx ? ["Wie hoch ist die Inflation gerade?", "Welche Zinsen bekomme ich fürs Sparkonto?"]
      : wantsRates ? ["Wie hoch ist die Inflation gerade?", "Was sind 10.000 € in 10 Jahren wert?"]
      : ["Welche Zinsen bekomme ich fürs Sparkonto?", "Wie viel sind 3.000 € in Yen?"],
  };
}

// Extra line for other answers (depot, goal previews) when live inflation is known.
export function realValue(amount: number, years: number, snapshot?: MarketSnapshot): number | undefined {
  const value = snapshot?.inflation?.value;
  return value === undefined ? undefined : round(amount / (1 + value / 100) ** years);
}
