import { classify, knownMerchantName } from "@/lib/calc";
import type { AppState } from "@/lib/types";

// Session-scoped, reversible masking for data that leaves the machine (external MCP clients such as
// Claude or ChatGPT). People, IBANs, e-mails, phone, card and account numbers become stable placeholders;
// shop and company names stay readable. reveal() turns placeholders in tool arguments back into real values.

export type PseudonymKind = "Person" | "IBAN" | "email" | "Telefon" | "Karte" | "Nummer";

const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const PHONE = /(?:\+|\b00)\d[\d /-]{7,}\d|\b0\d{3}[ /-]?\d{6,8}\b/g;
const CARD = /\b(?:\d{4}[ -]?){3}\d{1,7}\b|(?:\*+|\bx{4,}|\bX{4,}) ?\d{4}\b/g;
const NUMBER = /\b\d{9,}\b/g;
const TOKEN = /\b(Person|IBAN|email|Telefon|Karte|Nummer)-(\d+)\b/g;
const PLACEHOLDER = /^(?:Person|IBAN|email|Telefon|Karte|Nummer)-/;
const STREET = /(?:stra(?:ss|ß)e|gasse|weg|platz|allee|ring)$/i;
const HOLDER_POCKET = /^(?:Amex|Karte)\s+(\p{Lu}\p{Ll}+)$/u;

// Words that make a "name" a business, a bank product or an own pocket instead of a person.
const NOT_PERSON = new Set([
  "gmbh", "mbh", "ag", "kg", "og", "eu", "e.u.", "co", "ltd", "inc", "llc", "se", "sa", "limited", "gesmbh", "verein", "stiftung",
  "bank", "sparkasse", "raiffeisen", "revolut", "amex", "american", "express", "paypal", "klarna", "trade", "republic", "erste", "bawag",
  "finanzamt", "magistrat", "stadt", "gemeinde", "republik", "österreich", "versicherung", "service", "services", "shop", "store",
  "eur", "usd", "chf", "gbp", "konto", "pocket", "sparen", "spar", "urlaub", "notgroschen", "depot", "card", "karte", "kreditkarte",
  "online", "banking", "apple", "google", "pay", "sepa", "transfer", "payment", "zahlung", "überweisung", "gutschrift", "lastschrift",
  "miete", "gehalt", "lohn", "iban", "bic", "swift", "tel", "telefon", "mail", "email", "e-mail", "ref", "referenz", "verwendungszweck", "zahlungsreferenz", "mandat", "datum", "betrag", "danke", "dankt", "rückzahlung", "abrechnung", "einzahlung", "auszahlung", "aufladung", "bargeld", "ich", "mich", "mir",
]);

const NAME = String.raw`(\p{Lu}[\p{L}'’.-]+(?:[ ]+\p{Lu}[\p{L}'’.-]+){0,2})(?![\p{L}\d])`;
const TRIGGERS = [
  String.raw`^(?:To|From)[ ]+`,
  String.raw`(?<![\p{L}\d])(?:Transfer|Payment|Money)[ ]+(?:to|from)[ ]+`,
  String.raw`(?<![\p{L}\d])(?:Überweisung|Ueberweisung|Zahlung|Gutschrift|Geld|Dauerauftrag|Transfer|Sofortüberweisung)[ ]+(?:an|von|from|to)[ ]+`,
  String.raw`(?<![\p{L}\d])(?:Name[ ]+)?(?:Auftraggeber|Empf(?:ä|ae)nger|Zahlungsempf(?:ä|ae)nger|Beg(?:ü|ue)nstigter|Zahlungspflichtiger|Sender|Recipient|Kontoinhaber|Karteninhaber)(?:[ ]*name)?[ ]*:?[ ]+`,
];
const PERSON_PATTERNS = TRIGGERS.map((trigger) => new RegExp(trigger + NAME, "gmu"));

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameKey = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("de-AT");

function personCandidate(raw: string, merchants: Set<string>): string | undefined {
  if (PLACEHOLDER.test(raw)) return undefined;
  const words = raw.replace(/[.,;:'’-]+$/, "").split(/ +/).filter(Boolean);
  // Trailing payment words ("Max Muster Miete") are not part of the name.
  while (words.length && NOT_PERSON.has(words[words.length - 1].toLocaleLowerCase("de-AT"))) words.pop();
  if (!words.length || words.length > 3) return undefined;
  // Short all-caps words are abbreviations (EUR, OK, AT), not names.
  if (words.some((word) => word.length <= 3 && word === word.toLocaleUpperCase("de-AT"))) return undefined;
  if (words.some((word) => NOT_PERSON.has(word.toLocaleLowerCase("de-AT").replace(/[.]$/, "")) || word.length < 2 || STREET.test(word))) return undefined;
  const name = words.join(" ");
  if (merchants.has(nameKey(name)) || knownMerchantName(name)) return undefined;
  return name;
}

export function findPersonNames(text: string, merchants: Set<string> = new Set()): string[] {
  const found: string[] = [];
  for (const pattern of PERSON_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = personCandidate(match[1], merchants);
      if (name) found.push(name);
    }
  }
  return found;
}

// Shop names the user confirmed for ordinary purchases stay readable; transfers can carry a person's name as alias.
// Own pockets and savings goals ("To Urlaub") are not people either.
export function merchantNames(state: AppState): Set<string> {
  const names = new Set<string>();
  for (const row of state.transactions) {
    if (row.pocket && !HOLDER_POCKET.test(row.pocket)) names.add(nameKey(row.pocket));
    if (!row.merchantAlias) continue;
    let transfer = false;
    try { transfer = classify(row).isTransfer; } catch { transfer = true; }
    if (!transfer) names.add(nameKey(row.merchantAlias));
  }
  for (const goal of state.savingsGoals ?? []) names.add(nameKey(goal.name));
  for (const snapshot of state.accountSnapshots ?? []) if (!HOLDER_POCKET.test(snapshot.name)) names.add(nameKey(snapshot.name));
  return names;
}


// Names of people that appear in the user's own data: counterparties of transfers and secondary card holders.
export function personNamesFrom(state: AppState, extra: string[] = []): string[] {
  const merchants = merchantNames(state);
  const names = new Map<string, string>();
  const add = (name: string) => { if (!names.has(nameKey(name))) names.set(nameKey(name), name); };
  for (const name of extra) if (name.trim().length >= 2) add(name.trim());
  const texts = [
    ...state.transactions.flatMap((row) => [row.description, row.rawDescription ?? "", ...(row.rawDetails ?? [])]),
    ...(state.reviewQueue ?? []).flatMap((item) => item.kind === "booking" ? [item.draft.description, item.draft.rawDescription ?? ""] : []),
  ];
  for (const text of texts) for (const name of findPersonNames(text, merchants)) add(name);
  // "Amex Raphael": the pocket of a second card holder.
  const pockets = new Set(state.transactions.map((row) => row.pocket ?? ""));
  for (const pocket of pockets) {
    const holder = HOLDER_POCKET.exec(pocket)?.[1];
    if (holder && !NOT_PERSON.has(holder.toLocaleLowerCase("de-AT"))) add(holder);
  }
  return [...names.values()];
}

export type Pseudonymizer = {
  learn: (names: string[]) => void;
  maskText: (text: string) => string;
  mask: <T>(value: T) => T;
  reveal: <T>(value: T) => T;
  readonly size: number;
};

// Keys whose values are internal ids or structural data, never personal text.
const SKIP_KEY = /(?:^id$|Id$|Ids$|^ids$|^date$|^dates$|^month$|^from$|^to$|^category$|^interval$|^source$|^kind$|^bank$)/;

export function createPseudonymizer(names: string[] = [], keep: Set<string> = new Set()): Pseudonymizer {
  const tokens = new Map<string, string>(); // kind|key -> token
  const originals = new Map<string, string>(); // token -> real value
  const counters = new Map<PseudonymKind, number>();
  const people = new Map<string, string>(); // name key -> token
  let personPattern: RegExp | undefined;

  const tokenFor = (kind: PseudonymKind, key: string, original: string) => {
    const id = `${kind}|${key}`;
    let token = tokens.get(id);
    if (!token) {
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      token = `${kind}-${next}`;
      tokens.set(id, token);
      originals.set(token, original);
    }
    return token;
  };

  const learn = (list: string[]) => {
    let changed = false;
    for (const raw of list) {
      const name = raw.replace(/\s+/g, " ").trim();
      if (name.length < 2) continue;
      const key = nameKey(name);
      if (people.has(key)) continue;
      const token = tokenFor("Person", key, name);
      people.set(key, token);
      // Standalone first or last names of a known person ("Raphael") map to the same person.
      const parts = name.split(" ");
      if (parts.length > 1) for (const part of parts) {
        const partKey = nameKey(part);
        if (part.length >= 3 && !people.has(partKey) && !NOT_PERSON.has(partKey)) people.set(partKey, token);
      }
      changed = true;
    }
    if (changed && people.size) {
      const alternatives = [...people.keys()].sort((a, b) => b.length - a.length).map((key) => key.split(" ").map(escapeRegExp).join("\\s+"));
      personPattern = new RegExp(`(?<![\\p{L}\\d])(?:${alternatives.join("|")})(?![\\p{L}\\d])`, "giu");
    }
  };

  const maskText = (text: string) => {
    if (!text) return text;
    let result = text
      .replace(EMAIL, (match) => tokenFor("email", match.toLowerCase(), match))
      .replace(IBAN, (match) => tokenFor("IBAN", match.replace(/ /g, ""), match.replace(/ /g, "")))
      .replace(CARD, (match) => tokenFor("Karte", match.replace(/[^\dX*x]/g, ""), match))
      .replace(PHONE, (match) => tokenFor("Telefon", match.replace(/\D/g, ""), match))
      .replace(NUMBER, (match) => tokenFor("Nummer", match, match));
    // People seen for the first time in this text, then every known person.
    const fresh = findPersonNames(result, keep).filter((name) => !people.has(nameKey(name)));
    if (fresh.length) learn(fresh);
    if (personPattern) result = result.replace(personPattern, (match) => people.get(nameKey(match)) ?? match);
    return result;
  };

  const walk = <T>(value: T, transform: (text: string) => string, key = ""): T => {
    if (typeof value === "string") return (SKIP_KEY.test(key) ? value : transform(value)) as T;
    if (Array.isArray(value)) return value.map((item) => walk(item, transform, key)) as T;
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, transform, name)])) as T;
    return value;
  };

  const revealText = (text: string) => text.replace(TOKEN, (match) => originals.get(match) ?? match);

  learn(names);
  return {
    learn,
    maskText,
    mask: (value) => walk(value, maskText),
    reveal: (value) => walk(value, revealText, ""),
    get size() { return originals.size; },
  };
}

type ToolContent = { type: string; text?: string; [key: string]: unknown };

// Masks the text parts of an MCP tool result; JSON payloads are masked value by value.
export function maskToolResult<T extends { content: ToolContent[] }>(result: T, pseudonymizer: Pseudonymizer): T {
  return {
    ...result,
    content: result.content.map((part) => {
      if (part.type !== "text" || typeof part.text !== "string") return part;
      try {
        const parsed: unknown = JSON.parse(part.text);
        if (parsed && typeof parsed === "object") return { ...part, text: JSON.stringify(pseudonymizer.mask(parsed)) };
      } catch { /* plain text */ }
      return { ...part, text: pseudonymizer.maskText(part.text) };
    }),
  };
}

export const PSEUDONYM_NOTE = "Datenschutz: Personennamen, IBANs, E-Mail-Adressen, Telefon-, Karten- und Kontonummern sind pseudonymisiert " +
  "(z. B. Person-1, IBAN-2, Karte-1). Die Platzhalter bleiben innerhalb der Sitzung gleich und können in Tool-Argumenten verwendet werden. " +
  "Händler- und Firmennamen sind lesbar.";
