import { z } from "zod";
import { categories } from "@/lib/categories";
import { merchantText } from "@/lib/import/merchant-description";
import { privateMerchantLogoSchema } from "./merchant-logo-metadata";

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
  const value = merchantText(metadataFree)
    .toLocaleLowerCase("de-AT")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
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
      /\p{L}{2}/u.test(normalized) &&
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
): Merchant =>
  merchantSchema.parse({
    id,
    canonicalName,
    aliases,
    regexPatterns,
    defaultCategory,
    region: "AT",
    source: "local",
    license: "Local factual merchant rules; no logo rights asserted",
    attribution: "Finanzblick: lokal gepflegte Händlerregeln",
    updatedAt: Date.UTC(2026, 9, 8, 17),
  });

/** Curated offline identities, not account-specific learned category overrides. */
export const seedMerchants: Merchant[] = [
  localMerchant(
    "at-billa",
    "BILLA",
    ["Billa Plus", "Billa AG", "Billa dankt"],
    "Lebensmittel",
    ["\\bbilla[ ]?online\\b"],
  ),
  localMerchant(
    "at-penny",
    "PENNY",
    ["Penny Markt", "Penny Markt GmbH"],
    "Lebensmittel",
  ),
  localMerchant(
    "at-mueller",
    "Müller",
    ["Mueller", "Müller Drogerie", "Mueller Handels"],
    "Drogerie",
  ),
  localMerchant(
    "at-spar",
    "SPAR",
    ["INTERSPAR", "EUROSPAR", "Spar Markt"],
    "Lebensmittel",
  ),
  localMerchant("at-hofer", "HOFER", ["Hofer KG"], "Lebensmittel"),
  localMerchant("at-lidl", "Lidl", ["Lidl Österreich"], "Lebensmittel"),
  localMerchant(
    "at-dm",
    "dm",
    ["dm-drogerie", "dm Drogerie Markt"],
    "Drogerie",
  ),
  localMerchant("at-bipa", "BIPA", ["Bipa Parfumerien"], "Drogerie"),
  localMerchant("at-ikea", "IKEA", ["Ikea Österreich"], "Möbel & Einrichtung"),
  localMerchant(
    "at-oebb",
    "ÖBB",
    ["OEBB", "ÖBB Personenverkehr"],
    "Öffentliche Verkehrsmittel",
  ),
  localMerchant("at-westbahn", "WESTbahn", [], "Öffentliche Verkehrsmittel"),
  localMerchant("at-omv", "OMV", ["OMV Tankstelle"], "Tanken"),
  localMerchant("at-shell", "Shell", ["Shell Tankstelle"], "Tanken"),
  localMerchant("at-thalia", "Thalia", ["Thalia Buchhandlung"], "Bildung"),
  localMerchant("at-fressnapf", "Fressnapf", [], "Haustiere"),
  localMerchant("at-martin-auer", "Martin Auer", [], "Cafés & Snacks"),
];

interface AliasEntry {
  text: string;
  merchants: Set<Merchant>;
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
const resolved = (
  matches: Set<Merchant>,
  method: MerchantMatch["method"],
): MerchantMatch =>
  matches.size === 1
    ? {
        merchant: matches.values().next().value,
        requiresManualReview:
          method === "fuzzy" ||
          matches.values().next().value?.defaultCategory === null,
        method,
      }
    : unresolved(method);

/**
 * Snapshot index: construct again after database changes. Regex and fuzzy work
 * are globally bounded. Saturated fuzzy buckets fail closed, never pick a subset.
 * Unique fuzzy matches need >=6 characters, >=85% similarity and only one edit.
 */
export class MerchantIndex {
  private readonly exact = new Map<string, AliasEntry>();
  private readonly regex: { merchant: Merchant; pattern: RegExp }[] = [];
  private readonly fuzzy = new Map<string, Set<AliasEntry> | null>();

  constructor(merchants: Merchant[]) {
    if (merchants.length > 10_000)
      throw new RangeError("Merchant index supports at most 10,000 merchants.");
    const ids = new Set<string>();
    for (const source of merchants) {
      const merchant = merchantSchema.parse(source);
      if (ids.has(merchant.id))
        throw new Error(`Duplicate merchant ID: ${merchant.id}`);
      ids.add(merchant.id);
      for (const name of [merchant.canonicalName, ...merchant.aliases]) {
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
      for (const pattern of merchant.regexPatterns) {
        if (this.regex.length >= MAX_REGEX_PATTERNS)
          throw new RangeError("Too many merchant regex patterns.");
        this.regex.push({ merchant, pattern: new RegExp(pattern, "iu") });
      }
    }
    for (const entry of this.exact.values()) {
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

  match(text: string): MerchantMatch {
    if (text.length > MAX_INPUT) return unresolved();
    // Remove IDs before providers: stripping "Stripe" inside an ID must not
    // expose its remaining "BILLA" component as a merchant.
    const normalized = normalizeMerchantText(text)
      .replace(
        /\bpay\s*pal(?:\s+europe)?(?:\s+s\s+a\s+r\s+l(?:\s+et\s+cie)?(?:\s+s\s+c\s+a)?)?/gi,
        " ",
      )
      .replace(new RegExp(providers.source, "gi"), " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return unresolved();
    const tokens = normalized.split(" ");
    if (tokens.length > MAX_TOKENS) return unresolved();
    const phrases = windows(tokens);
    const exactMatches = new Set<Merchant>();
    for (const phrase of phrases) {
      for (const merchant of this.exact.get(phrase)?.merchants ?? [])
        exactMatches.add(merchant);
    }
    const regexMatches = new Set<Merchant>();
    for (const { merchant, pattern } of this.regex) {
      if (pattern.test(normalized)) regexMatches.add(merchant);
    }
    // Check regex conflicts even when an exact alias exists.
    if (exactMatches.size)
      return resolved(new Set([...exactMatches, ...regexMatches]), "exact");
    if (regexMatches.size) return resolved(regexMatches, "regex");
    return this.matchFuzzy(phrases);
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
          if (bucket === null) return unresolved();
          for (const entry of bucket ?? []) {
            candidates.add(entry);
            if (candidates.size > MAX_FUZZY_CANDIDATES) return unresolved();
          }
        }
      }
      for (const entry of candidates) {
        if (++comparisons > MAX_FUZZY_CANDIDATES) return unresolved();
        if (
          1 - 1 / Math.max(phrase.length, entry.text.length) >= 0.85 &&
          oneEditApart(phrase, entry.text)
        ) {
          for (const merchant of entry.merchants) matches.add(merchant);
        }
      }
    }
    return matches.size ? resolved(matches, "fuzzy") : unresolved();
  }
}
