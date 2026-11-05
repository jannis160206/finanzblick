import { assistantDraftSchema, type AssistantDraft } from "@/lib/types";

export type AssistantAction = AssistantDraft["action"];
export type DateHint = { month: string; day?: number | "end" };
export type ParsedMessage = {
  action?: AssistantAction;
  name?: string;
  amount?: number;
  monthly?: number;
  startCapital?: number;
  installments?: number;
  fromAccount?: string;
  shared?: boolean;
  whatIf?: boolean;
  extra?: AssistantDraft["extra"];
  date?: DateHint;
  // Every amount written in the message; model values must come from this list.
  numbers: number[];
};

const monthNames: [RegExp, number][] = [
  [/^(?:jänner|jaenner|januar|jan)$/, 1], [/^(?:februar|feber|feb)$/, 2], [/^(?:märz|maerz|mär|mrz)$/, 3],
  [/^(?:april|apr)$/, 4], [/^mai$/, 5], [/^(?:juni|jun)$/, 6], [/^(?:juli|jul)$/, 7], [/^(?:august|aug)$/, 8],
  [/^(?:september|sept|sep)$/, 9], [/^(?:oktober|okt)$/, 10], [/^(?:november|nov)$/, 11], [/^(?:dezember|dez)$/, 12],
];
const monthPattern = "jänner|jaenner|januar|jan|februar|feber|feb|märz|maerz|mär|mrz|april|apr|mai|juni|jun|juli|jul|august|aug|september|sept|sep|oktober|okt|november|nov|dezember|dez";
const accounts: [RegExp, string][] = [
  [/\bsparkonto\b/i, "Sparkonto"], [/\bnotgroschen\b|\btrade republic\b|\btagesgeld\b/i, "Notgroschen"],
  [/\bgiro(?:konto)?\b|\braiffeisen\b|\bhauptkonto\b/i, "Giro"], [/\burlaubs?(?:konto|pocket|topf)\b/i, "Urlaub"],
  [/\bmotorrad(?:konto|pocket)\b/i, "Motorrad"], [/\brevolut\b/i, "Revolut"],
];
const numberWords: Record<string, number> = { einen: 1, ein: 1, einem: 1, zwei: 2, drei: 3, vier: 4, "fünf": 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, "zwölf": 12 };
const countPattern = "(\\d{1,2}|einen|ein|einem|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf)";
const moneyPattern = "(\\d{1,3}(?:[.\\s]\\d{3})+|\\d+)(?:,(\\d{1,2}))?\\s*(?:€|euro|eur)";
const extraSources: [RegExp, NonNullable<AssistantDraft["extra"]>["from"]][] = [
  [/sparkonto/i, "Sparkonto"], [/notgroschen|trade republic|tagesgeld/i, "Notgroschen"], [/urlaub/i, "Urlaub"],
  [/motorrad/i, "Motorrad"], [/giro|raiffeisen|hauptkonto|gehalt/i, "Giro"],
];
export type ExtraHint = { amount: number; months: number; from?: NonNullable<AssistantDraft["extra"]>["from"]; start: number; end: number };

// "die ersten 2 Monate je 60 € vom Sparkonto", "60 € extra für 3 Monate aus dem Notgroschen", "2 × 60 € vom Sparkonto zum Start".
export function findExtra(text: string): ExtraHint | undefined {
  const lower = text.toLowerCase();
  const lead = "(?:(?:die|den|in den|für die|fuer die)\\s+)?(?:(?:ersten|nächsten|naechsten|kommenden)\\s+)?";
  const patterns: [RegExp, "countFirst" | "amountFirst"][] = [
    [new RegExp(`${lead}${countPattern}\\s+monate?n?\\s+(?:lang\\s+)?(?:(?:je(?:weils)?|à|a|zusätzlich|zusaetzlich|extra|nochmal)\\s+)*${moneyPattern}`, "i"), "countFirst"],
    [new RegExp(`${moneyPattern}\\s+(?:(?:extra|zusätzlich|zusaetzlich|mehr)\\s+)?(?:(?:für|fuer|in)\\s+)?${lead}${countPattern}\\s+monate?n?`, "i"), "amountFirst"],
    [new RegExp(`\\b${countPattern}\\s*[x×]\\s*${moneyPattern}`, "i"), "countFirst"],
  ];
  for (const [pattern, order] of patterns) {
    const match = pattern.exec(lower);
    if (!match) continue;
    const [count, whole, decimals] = order === "countFirst" ? [match[1], match[2], match[3]] : [match[3], match[1], match[2]];
    const months = numberWords[count] ?? Number(count);
    const amount = parseAmount(`${whole}${decimals ? `,${decimals}` : ""}`);
    if (!amount || !Number.isInteger(months) || months < 1 || months > 24) continue;
    // Plain "6 Monate 60 € im Monat" is a monthly rate, not an extra, unless a start phase or source is named.
    const tail = lower.slice(match.index + match[0].length, match.index + match[0].length + 50);
    const source = /^\s*(?:extra\s+|zusätzlich\s+)?(?:\w+\s+)?(?:vom|von|aus dem|aus der|aus|vom konto)\s+(?:dem\s+|der\s+|meinem\s+|meiner\s+)?([a-zäöüß ]{3,30})/.exec(tail);
    const from = source ? extraSources.find(([test]) => test.test(source[1]))?.[1] : undefined;
    const phrase = match[0];
    if (order === "countFirst" && /\bin\s+$/.test(lower.slice(Math.max(0, match.index - 4), match.index)) && !/ersten|nächsten|naechsten|kommenden/.test(phrase)) continue;
    const startPhase = /ersten|nächsten|naechsten|kommenden|zum start|am anfang|anfangs|zu beginn|extra|zusätzlich|zusaetzlich|[x×]/.test(`${phrase} ${tail.slice(0, 25)} ${lower.slice(Math.max(0, match.index - 25), match.index)}`);
    if (!from && !startPhase) continue;
    const end = match.index + match[0].length + (source ? source.index + source[0].length : 0);
    return { amount, months, ...(from ? { from } : {}), start: match.index, end };
  }
  return undefined;
}
const stopWords = new Set(["ich", "du", "wir", "im", "in", "am", "an", "bis", "ab", "kann", "könnte", "wie", "was", "wann", "wo",
  "mein", "meine", "meinen", "ein", "eine", "einen", "der", "die", "das", "den", "dem", "euro", "eur", "monat", "monate", "monaten",
  "rate", "raten", "sparziel", "sparkonto", "giro", "girokonto", "konto", "startkapital", "geld", "ende", "anfang", "mitte", "jahr",
  "jahren", "sparen", "ausgabe", "ausgaben", "und", "oder", "mit", "für", "von", "vom", "zum", "zur", "noch", "schon", "bereits",
  "jetzt", "heute", "nächsten", "nächster", "übernächsten", "geht", "sich", "leisten", "neues", "neuen", "neue", "neuer", "plane",
  "planen", "will", "möchte", "würde", "brauche", "kommt", "habe", "hab", "liegen", "liegt", "es", "er", "sie", "mir", "mich",
  "lege", "zurück", "wäre", "wenn", "angenommen", "monatlich", "pro", "je", "dann", "also", "bitte", "hallo", "hi", "danke", "ja", "nein"]);

const cents = (value: number) => Math.round(value * 100) / 100;
const pad = (value: number) => String(value).padStart(2, "0");
export const addMonth = (month: string, count: number) => {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 + count, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
};
export const lastDay = (month: string) => {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value, 0)).getUTCDate();
};
const monthNumber = (word: string) => monthNames.find(([pattern]) => pattern.test(word.toLowerCase()))?.[1];
const fullYear = (value: string | undefined) => {
  if (!value) return undefined;
  const digits = Number(value.replace(/\D/g, ""));
  return digits < 100 ? 2000 + digits : digits;
};
// Without a year the month means its next occurrence, never the past.
const nextMonth = (asOf: string, month: number, year?: number) => {
  const current = asOf.slice(0, 7);
  if (year) return `${year}-${pad(month)}`;
  const candidate = `${asOf.slice(0, 4)}-${pad(month)}`;
  return candidate < current ? `${Number(asOf.slice(0, 4)) + 1}-${pad(month)}` : candidate;
};

export function parseAmount(raw: string): number | undefined {
  const match = raw.trim().match(/^(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d{1,2}))?$/);
  if (!match) return undefined;
  const value = Number(`${match[1].replace(/[.\s]/g, "")}.${match[2] ?? "0"}`);
  return Number.isFinite(value) ? cents(value) : undefined;
}

type Token = { start: number; end: number };
function blank(text: string, tokens: Token[]) {
  let result = text;
  for (const token of tokens) result = result.slice(0, token.start) + " ".repeat(token.end - token.start) + result.slice(token.end);
  return result;
}

function findDate(text: string, asOf: string): { hint?: DateHint; tokens: Token[]; duration?: number } {
  const tokens: Token[] = [];
  const lower = text.toLowerCase();
  const take = (match: RegExpExecArray) => tokens.push({ start: match.index, end: match.index + match[0].length });
  let hint: DateHint | undefined;
  let duration: number | undefined;
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(lower);
  const dotted = /\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?![\d.])/.exec(lower);
  const slash = /\b(\d{1,2})\s*\/\s*(\d{4}|\d{2})\b/.exec(lower);
  const named = new RegExp(`(?:\\b(anfang|mitte|ende)\\s+)?\\b(${monthPattern})\\b\\.?(?:\\s*/?\\s*(20\\d{2}|'\\d{2}))?`, "i").exec(lower);
  const yearOnly = /\b(?:bis|ende|in|anfang)\s+(20\d{2})\b/.exec(lower);
  const relative = /\b(übernächsten|uebernächsten|nächsten|naechsten|kommenden|diesen|dieses)\s+monat\b|\b(jetzt|heute|sofort|gleich)\b/.exec(lower);
  const span = /\bin\s+(\d{1,3}|einem halben|einem|zwei|drei|vier|fünf|sechs|zwölf)\s+(monat(?:en)?|jahr(?:en)?)\b/.exec(lower);
  const words: Record<string, number> = { einem: 1, zwei: 2, drei: 3, vier: 4, "fünf": 5, sechs: 6, "zwölf": 12 };
  if (iso) { hint = { month: `${iso[1]}-${iso[2]}`, day: Number(iso[3]) }; take(iso); }
  if (dotted && !hint) {
    const month = Number(dotted[2]);
    if (month >= 1 && month <= 12) {
      hint = { month: nextMonth(asOf, month, fullYear(dotted[3])), day: Number(dotted[1]) };
      take(dotted);
    }
  }
  if (slash && !hint && Number(slash[1]) >= 1 && Number(slash[1]) <= 12) {
    hint = { month: `${fullYear(slash[2])}-${pad(Number(slash[1]))}`, day: "end" };
    take(slash);
  }
  if (named && !hint) {
    const month = monthNumber(named[2])!;
    const position = named[1];
    hint = { month: nextMonth(asOf, month, fullYear(named[3])),
      ...(position === "anfang" ? { day: 1 } : position === "mitte" ? { day: 15 } : position === "ende" ? { day: "end" as const } : {}) };
    take(named);
  }
  if (yearOnly && !hint) { hint = { month: `${yearOnly[1]}-12`, day: "end" }; take(yearOnly); }
  if (span) {
    const count = span[1] === "einem halben" ? 6 : words[span[1]] ?? Number(span[1]);
    const months = span[2].startsWith("jahr") && span[1] !== "einem halben" ? count * 12 : count;
    if (months >= 1 && months <= 600) {
      duration = months;
      take(span);
    }
  }
  if (relative && !hint) {
    const offset = /übernächsten|uebernächsten/.test(relative[1] ?? "") ? 2 : /nächsten|naechsten|kommenden/.test(relative[1] ?? "") ? 1 : 0;
    hint = { month: addMonth(asOf.slice(0, 7), offset), ...(offset === 0 ? { day: Number(asOf.slice(8, 10)) } : {}) };
    take(relative);
  }
  return { hint, tokens, duration };
}

function findName(text: string): string | undefined {
  const clean = (value: string) => {
    const words = value.replace(/[.,!?;:"„“]+$/g, "").trim().split(/\s+/);
    while (words.length && /^(?:ein|eine|einen|der|die|das|den|dem|mein|meine|meinen|unser|unsere|neue[snr]?)$/i.test(words[0])) words.shift();
    const name = words.join(" ").slice(0, 40).trim();
    if (!name || stopWords.has(name.toLowerCase()) || monthNumber(name) || /^\d/.test(name)) return undefined;
    return name.charAt(0).toUpperCase() + name.slice(1);
  };
  const stop = "(?=\\s+(?:bis|ab|im|in|um|mit|und|von|vom|am|zu|für|über|sparen|ansparen|zurücklegen|kaufen|leisten|planen|kostet|ca\\.?|etwa|rund|\\d)|\\s*[,.!?;:]|\\s*$)";
  const word = "[A-Za-zÄÖÜäöüß][\\wÄÖÜäöüß'-]*";
  const patterns = [
    new RegExp(`\\b(?:für|fuer)\\s+((?:(?:ein|eine|einen|den|die|das|mein|meine|meinen|unser|unsere|neue[snr]?)\\s+){0,2}${word}(?:\\s+(?:nach|in)\\s+[A-ZÄÖÜ][\\wÄÖÜäöüß-]*|\\s+[A-ZÄÖÜ][\\wÄÖÜäöüß-]*){0,2})${stop}`),
    new RegExp(`\\b(?:kommt|kommen|fällig ist|kaufe|kaufen|brauche|zahle|plane)\\s+((?:(?:ein|eine|einen|der|die|das|den|mein|meine|meinen|neue[snr]?)\\s+){0,2}[A-ZÄÖÜ][\\wÄÖÜäöüß-]*)${stop}`),
    /\b(?:ein|eine|einen|neue[snr]?|das|den|die|der)\s+((?:neue[snr]?\s+)?[A-ZÄÖÜ][\wÄÖÜäöüß-]*)/,
    /^\s*([A-ZÄÖÜ][\wÄÖÜäöüß-]*)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const name = match ? clean(match[1]) : undefined;
    if (name) return name;
  }
  return undefined;
}

export function detectAction(text: string): AssistantAction | undefined {
  const lower = text.toLowerCase();
  if (/leisten|geht\s+sich\b.*\baus|ausgehen|geht das\b|reicht (?:das|es)|schaffe ich|kann ich mir/.test(lower)) return "affordability";
  if (/sparziel|\bspar(?:e|en|t)\b|anspar|zurückleg|zuruecklegen|zurück legen|auf die seite/.test(lower)) return "savings_goal";
  if (/geplante ausgabe|\braten?\b|\bkommt\b|fällig|faellig|\bplane?n?\b|kaufe|kaufen|bezahlen|zahlen|anschaff|rechnung|pickerl|versicherung|reparatur|service/.test(lower)) return "expense";
  return undefined;
}

type AmountToken = { value: number; before: string; after: string };

export function parseAssistantMessage(text: string, asOf: string): ParsedMessage {
  const input = text.slice(0, 1000);
  const lower = input.toLowerCase();
  const date = findDate(input, asOf);
  const result: ParsedMessage = { numbers: [] };
  const action = detectAction(input);
  if (action) result.action = action;
  if (/was wäre,? wenn|was waere wenn|\bwas,? wenn\b|angenommen|hypothetisch|nur durchrechnen|nur rechnen|rein theoretisch/.test(lower)) result.whatIf = true;
  if (/mit raphael|geteilt|halbe[ -]halbe|teilen uns|zur hälfte/.test(lower)) result.shared = true;
  const tokens = [...date.tokens];
  const extra = action === "expense" || action === "affordability" ? undefined : findExtra(input);
  if (extra) {
    result.extra = { amount: extra.amount, months: extra.months, ...(extra.from ? { from: extra.from } : {}) };
    tokens.push({ start: extra.start, end: extra.end });
  }
  const withoutExtra = extra ? blank(input, [{ start: extra.start, end: extra.end }]) : input;
  for (const [pattern, name] of accounts) if (pattern.test(withoutExtra)) { result.fromAccount = name; break; }
  const installments = /\b(?:in\s+)?(\d{1,3})\s*(?:monats)?raten\b/i.exec(withoutExtra) ?? /\b(\d{1,3})\s*[x×]\s*(?=\d)/i.exec(withoutExtra);
  if (installments) {
    const count = Number(installments[1]);
    if (count >= 1 && count <= 120) result.installments = count;
    tokens.push({ start: installments.index, end: installments.index + installments[0].length });
  }
  const rest = blank(input, tokens);
  const amounts: AmountToken[] = [];
  const amountPattern = /(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d{1,2}|-))?\s*(k\b|tsd\.?|tausend)?/gi;
  for (const match of rest.matchAll(amountPattern)) {
    let value = parseAmount(`${match[1]}${match[2] && match[2] !== "-" ? `,${match[2]}` : ""}`);
    if (value === undefined || value <= 0) continue;
    if (match[3]) value = cents(value * 1000);
    const before = rest.slice(Math.max(0, match.index - 40), match.index).toLowerCase();
    const after = rest.slice(match.index + match[0].length, match.index + match[0].length + 40).toLowerCase();
    // Bare years are dates, not amounts.
    if (!match[2] && !match[3] && value >= 2020 && value <= 2100 && !/^\s*(?:€|euro|eur)/.test(after)) continue;
    amounts.push({ value, before, after });
  }
  result.numbers = [...new Set(amounts.map((item) => item.value))];
  const remaining = [...amounts];
  const takeWhere = (test: (item: AmountToken) => boolean) => {
    const index = remaining.findIndex(test);
    return index < 0 ? undefined : remaining.splice(index, 1)[0];
  };
  const isMonthly = (item: AmountToken) =>
    /^\s*(?:€|euro|eur)?\s*(?:im|pro|je|jeden|\/|a|per)\s*monat|^\s*(?:€|euro|eur)?\s*(?:monatlich|mtl)/.test(item.after) ||
    /(?:monatlich|pro monat|monatsrate(?: von)?|im monat)\s*(?:€|euro)?\s*$/.test(item.before);
  const isPerRate = (item: AmountToken) => isMonthly(item) ||
    /^\s*(?:€|euro|eur)?\s*(?:pro|je)\s+rate/.test(item.after) || /(?:à|zu je|je|zu|von je)\s*(?:€|euro)?\s*$/.test(item.before);
  const isStart = (item: AmountToken) =>
    /(?:schon|bereits|startkapital|start(?:betrag)?|anfangs|vorhanden|habe ich|hab ich)\s*(?:von|mit)?\s*(?:€|euro)?\s*$/.test(item.before) ||
    /^\s*(?:€|euro|eur)?\s*(?:liegen|liegt|habe ich|hab ich|sind|ist|hab|habe)?\s*(?:schon|bereits|als start|startkapital|drauf|vorhanden)/.test(item.after);
  if (result.installments && result.installments > 1) {
    const rate = takeWhere(isPerRate);
    if (rate) result.amount = cents(rate.value * result.installments);
  } else {
    const monthly = takeWhere(isMonthly);
    if (monthly) result.monthly = monthly.value;
  }
  const start = takeWhere(isStart);
  if (start) result.startCapital = start.value;
  if (result.amount === undefined && remaining.length) result.amount = Math.max(...remaining.map((item) => item.value));
  if (date.duration && !date.hint) {
    result.date = result.action === "savings_goal" || !result.action
      ? { month: addMonth(asOf.slice(0, 7), date.duration - 1), day: "end" }
      : { month: addMonth(asOf.slice(0, 7), date.duration), day: 1 };
  } else if (date.hint) result.date = date.hint;
  const name = findName(blank(input, tokens));
  if (name) result.name = name;
  return result;
}

export function resolveDate(hint: DateHint, action: AssistantAction, asOf: string): string {
  const end = lastDay(hint.month);
  const day = hint.day === "end" ? end : hint.day ?? (action === "savings_goal" ? end
    : hint.month === asOf.slice(0, 7) ? Number(asOf.slice(8, 10)) : 1);
  return `${hint.month}-${pad(Math.min(Math.max(1, day), end))}`;
}

export type ModelExtraction = {
  action?: string | null;
  name?: string | null;
  amount?: number | null;
  monthly?: number | null;
  startCapital?: number | null;
  installments?: number | null;
  fromAccount?: string | null;
  shared?: boolean | null;
  whatIf?: boolean | null;
};

// The model may only assign roles: amounts must be written in the message, names must appear in it.
export function groundModelExtraction(model: ModelExtraction | undefined, parsed: ParsedMessage, text: string): Partial<ParsedMessage> {
  if (!model) return {};
  const known = new Set(parsed.numbers.map((value) => value.toFixed(2)));
  const backed = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && known.has(cents(value).toFixed(2)) ? cents(value) : undefined;
  const lower = text.toLowerCase();
  const result: Partial<ParsedMessage> = {};
  if (model.action === "savings_goal" || model.action === "expense" || model.action === "affordability") result.action = model.action;
  const name = typeof model.name === "string" ? model.name.trim().slice(0, 80) : "";
  if (name && name.toLowerCase().split(/\s+/).every((word) => lower.includes(word))) result.name = name.charAt(0).toUpperCase() + name.slice(1);
  const amount = backed(model.amount);
  const monthly = backed(model.monthly);
  const start = backed(model.startCapital);
  if (amount !== undefined) result.amount = amount;
  if (monthly !== undefined && monthly !== amount) result.monthly = monthly;
  if (start !== undefined && start !== amount) result.startCapital = start;
  if (typeof model.installments === "number" && Number.isInteger(model.installments) && model.installments > 1 &&
    model.installments <= 120 && new RegExp(`\\b${model.installments}\\b`).test(text)) result.installments = model.installments;
  if (typeof model.fromAccount === "string") {
    const account = accounts.find(([pattern]) => pattern.test(model.fromAccount!))?.[1];
    if (account && accounts.find(([, value]) => value === account)?.[0].test(text)) result.fromAccount = account;
  }
  if (model.shared === true && parsed.shared) result.shared = true;
  if (model.whatIf === true && parsed.whatIf) result.whatIf = true;
  return result;
}

const definedEntries = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== "numbers" && item !== undefined && item !== null)) as Partial<T>;

// Follow-up answers ("Sparkonto", "Juli 2027", "400") fill the open question of the pending draft.
export function mergeDraft(pending: AssistantDraft | undefined, parsed: ParsedMessage, model: Partial<ParsedMessage>, text: string, asOf: string): AssistantDraft | undefined {
  const values: Partial<ParsedMessage> = { ...definedEntries(parsed), ...definedEntries(model) };
  const action = values.action;
  const startOver = !pending || (!!action && action !== pending.action);
  const resolvedAction = startOver ? action : pending.action;
  if (!resolvedAction) return undefined;
  const draft: Partial<AssistantDraft> = startOver ? { action: resolvedAction } : { ...pending };
  const missing = startOver ? undefined : missingField(pending);
  if (!startOver && missing === "monthly_or_date" && values.amount !== undefined && values.monthly === undefined && values.startCapital === undefined) {
    values.monthly = values.amount;
    delete values.amount;
  }
  if (!startOver && missing === "name") {
    const plain = text.trim().replace(/[.!?]+$/, "");
    if (!values.name && plain && plain.length <= 60 && !/\d/.test(plain)) values.name = plain.charAt(0).toUpperCase() + plain.slice(1);
  } else if (!startOver && pending.name && !action) delete values.name;
  for (const key of ["name", "amount", "monthly", "startCapital", "installments", "fromAccount", "shared", "whatIf", "extra"] as const) {
    if (values[key] !== undefined) Object.assign(draft, { [key]: values[key] });
  }
  if (values.date) draft.date = resolveDate(values.date, resolvedAction, asOf);
  if (draft.installments === 1) delete draft.installments;
  if (resolvedAction !== "savings_goal") delete draft.extra;
  const result = assistantDraftSchema.safeParse(draft);
  return result.success ? result.data : undefined;
}

export type MissingField = "name" | "amount" | "date" | "monthly_or_date" | "fromAccount";

export function missingField(draft: AssistantDraft): MissingField | undefined {
  if (draft.action === "savings_goal") {
    if (!draft.name) return "name";
    if (!draft.amount) return "amount";
    if (!draft.date && !draft.monthly) return "monthly_or_date";
    if (draft.startCapital && !draft.fromAccount) return "fromAccount";
    return undefined;
  }
  if (draft.action === "expense" && !draft.name) return "name";
  if (!draft.amount) return "amount";
  if (!draft.date) return "date";
  return undefined;
}

export function missingQuestion(draft: AssistantDraft): string | undefined {
  const field = missingField(draft);
  if (!field) return undefined;
  if (draft.action === "savings_goal") return {
    name: "Wie soll das Sparziel heißen?",
    amount: `Wie viel möchtest du für „${draft.name}“ insgesamt ansparen?`,
    monthly_or_date: "Bis wann möchtest du das Ziel erreichen? Oder sag mir, wie viel du monatlich zurücklegen kannst.",
    fromAccount: "Von welchem Konto kommt das Startkapital, zum Beispiel Sparkonto oder Giro?",
    date: "Bis wann möchtest du das Ziel erreichen?",
  }[field];
  if (draft.action === "expense") return {
    name: "Wofür ist die Ausgabe?",
    amount: `Wie viel kostet „${draft.name}“ ungefähr?`,
    date: "Wann ist die Ausgabe fällig? Ein Monat reicht, zum Beispiel „im März“.",
    monthly_or_date: "", fromAccount: "",
  }[field];
  return field === "amount" ? "Um welchen Betrag geht es?" : "Für welchen Monat soll ich das prüfen?";
}
