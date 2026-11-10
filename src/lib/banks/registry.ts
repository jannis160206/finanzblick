// Local bank directory: names, aliases, BIC prefixes and official domains. Data only, no logos.

export type BankCountry = "AT" | "DE";

export type BankEntry = {
  id: string;
  name: string;
  /** Strings match the whole normalized name or its leading words; patterns run on the normalized name. */
  aliases: readonly (string | RegExp)[];
  bic?: readonly string[];
  domain: string;
  /** Other official domains the website loads its icons from (group CDN). */
  assetDomains?: readonly string[];
  /** Home market; decides between entries sharing an alias ("Sparkasse", "Volksbank"). */
  country?: BankCountry;
  /** Monogram background, dark enough for white text. */
  color?: string;
  monogram?: string;
};

export const BANKS: readonly BankEntry[] = [
  {
    id: "raiffeisen",
    name: "Raiffeisen",
    aliases: [
      "raiffeisen", "raiffeisenbank", "raiffeisen bank", "raiffeisenlandesbank", "raiffeisen landesbank",
      "raiffeisen bank international", "rlb", "rbi", /^raiffeisen(?:bank|kasse|landesbank)?\b/,
    ],
    bic: ["RZ", "RLNW", "RVSA", "RVVG"],
    domain: "raiffeisen.at",
    country: "AT",
    color: "#6b5a00",
  },
  {
    id: "erste",
    name: "Erste Bank",
    aliases: ["erste", "erste bank", "erste bank und sparkassen", "erste group"],
    bic: ["GIBA"],
    domain: "sparkasse.at",
    assetDomains: ["erstegroup.com"],
    country: "AT",
    color: "#1f5fd1",
  },
  {
    id: "sparkasse-at",
    name: "Sparkasse",
    aliases: ["sparkasse", "sparkassen", /(?:^| )(?:stadt|kreis)?sparkassen?\b/],
    bic: ["ASPK", "KSPK", "SBGS", "SPIH", "STSP"],
    domain: "sparkasse.at",
    assetDomains: ["erstegroup.com"],
    country: "AT",
    color: "#d0021b",
  },
  {
    id: "bank-austria",
    name: "Bank Austria",
    aliases: ["bank austria", "unicredit bank austria", "unicredit", "ba ca"],
    bic: ["BKAU"],
    domain: "bankaustria.at",
    country: "AT",
    color: "#c8102e",
  },
  {
    id: "bawag",
    name: "BAWAG",
    aliases: ["bawag", "bawag psk", "psk", "p s k"],
    bic: ["BAWA"],
    domain: "bawag.at",
    country: "AT",
    color: "#b5121b",
  },
  {
    id: "easybank",
    name: "easybank",
    aliases: ["easybank", "easy bank"],
    bic: ["EASY"],
    domain: "easybank.at",
    country: "AT",
  },
  {
    id: "oberbank",
    name: "Oberbank",
    aliases: ["oberbank"],
    bic: ["OBKL"],
    domain: "oberbank.at",
    country: "AT",
    color: "#003d7c",
  },
  {
    id: "volksbank-at",
    name: "Volksbank",
    aliases: ["volksbank", "volksbanken"],
    bic: ["VBOE"],
    domain: "volksbank.at",
    country: "AT",
    color: "#00508c",
  },
  {
    id: "hypo",
    name: "Hypo",
    aliases: ["hypo", "hypobank", "landes hypothekenbank"],
    bic: ["HYPN", "HYPT", "HYPV"],
    domain: "hypo.at",
    country: "AT",
  },
  {
    id: "n26",
    name: "N26",
    aliases: ["n26", "number26"],
    bic: ["NTSB"],
    domain: "n26.com",
    color: "#23786a",
  },
  {
    id: "revolut",
    name: "Revolut",
    aliases: ["revolut"],
    bic: ["REVO"],
    domain: "revolut.com",
    color: "#191c1f",
  },
  {
    id: "trade-republic",
    name: "Trade Republic",
    aliases: ["trade republic", "traderepublic"],
    bic: ["TRBK"],
    domain: "traderepublic.com",
    color: "#111111",
  },
  {
    id: "amex",
    name: "American Express",
    aliases: ["american express", "amex"],
    domain: "americanexpress.com",
    color: "#006fcf",
  },
  {
    id: "paypal",
    name: "PayPal",
    aliases: ["paypal"],
    bic: ["PPLX"],
    domain: "paypal.com",
    assetDomains: ["paypalobjects.com"],
    color: "#003087",
  },
  {
    id: "ing",
    name: "ING",
    // A bare "ing" prefix would also catch the title "Ing." in front of a person's name.
    aliases: [/^ing(?: diba| bank| deutschland| de| austria)?$/, "ing diba", "ingdiba"],
    bic: ["INGD"],
    domain: "ing.de",
    country: "DE",
    color: "#b84500",
  },
  {
    id: "dkb",
    name: "DKB",
    aliases: ["dkb", "deutsche kreditbank"],
    bic: ["BYLADEM1001"],
    domain: "dkb.de",
    country: "DE",
    color: "#005a9c",
  },
  {
    id: "comdirect",
    name: "comdirect",
    aliases: ["comdirect"],
    bic: ["COBADEHD001"],
    domain: "comdirect.de",
    country: "DE",
    color: "#2b2b2b",
  },
  {
    id: "commerzbank",
    name: "Commerzbank",
    aliases: ["commerzbank"],
    bic: ["COBA"],
    domain: "commerzbank.de",
    country: "DE",
    color: "#003c46",
  },
  {
    id: "deutsche-bank",
    name: "Deutsche Bank",
    aliases: ["deutsche bank"],
    bic: ["DEUT"],
    domain: "deutsche-bank.de",
    country: "DE",
    color: "#0018a8",
  },
  {
    id: "sparkasse-de",
    name: "Sparkasse",
    aliases: ["sparkasse", "sparkassen", /(?:^| )(?:stadt|kreis)?sparkassen?\b/],
    domain: "sparkasse.de",
    country: "DE",
    color: "#d0021b",
  },
  {
    id: "vr-de",
    name: "Volksbank Raiffeisenbank",
    aliases: [
      "volksbank", "volksbanken", "raiffeisenbank", "volksbanken raiffeisenbanken", "vr bank",
      /^vr ?bank\b/, /^volks und raiffeisenbank\b/,
    ],
    bic: ["GENO"],
    domain: "vr.de",
    country: "DE",
    color: "#0066b3",
    monogram: "VR",
  },
  {
    id: "wise",
    name: "Wise",
    aliases: ["wise", "transferwise"],
    bic: ["TRWI"],
    domain: "wise.com",
    color: "#163300",
  },
  {
    id: "bunq",
    name: "bunq",
    aliases: ["bunq"],
    bic: ["BUNQ"],
    domain: "bunq.com",
  },
  {
    id: "klarna",
    name: "Klarna",
    aliases: ["klarna"],
    domain: "klarna.com",
    color: "#17120f",
  },
];

const BIC = /^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;
const SKIPPED_WORDS = new Set(["ag", "eg", "gmbh", "mbh", "se", "sa", "nv", "plc", "ltd", "kg", "und", "der", "die", "das", "of", "the", "von"]);

const upperCountry = (country: string | undefined) => {
  const code = country?.trim().toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) ? code : undefined;
};

/** Bank part of an account label: "Raiffeisen · Giro (EUR)" → "Raiffeisen". */
export function bankLabel(name: string | null | undefined): string {
  return (name ?? "").split("·")[0].replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

/** Case-, accent- and punctuation-insensitive form of a bank label. */
export function normalizeBankName(name: string | null | undefined): string {
  return bankLabel(name).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const aliasTable = new Map(BANKS.map((entry) => [
  entry.id,
  entry.aliases.map((alias) => typeof alias === "string" ? normalizeBankName(alias) : alias),
]));

const compactOf = (text: string) => text.replace(/ /g, "");

// The registry name itself only matches exactly; leading-word matches come from the aliases.
function matches(entry: BankEntry, normalized: string) {
  const compact = compactOf(normalized);
  if (compact === compactOf(normalizeBankName(entry.name))) return true;
  return aliasTable.get(entry.id)!.some((alias) => typeof alias === "string"
    ? compact === compactOf(alias) || normalized.startsWith(`${alias} `)
    : alias.test(normalized));
}

function preferCountry(entries: BankEntry[], country: string | undefined) {
  const code = upperCountry(country);
  if (!code) return entries[0];
  return entries.find((entry) => entry.country === code) ?? entries.find((entry) => !entry.country) ?? entries[0];
}

/** Registry entry for a BIC; the longest matching prefix wins. */
export function bankByBic(bic: string | null | undefined, country?: string): BankEntry | undefined {
  const code = (bic ?? "").replace(/\s/g, "").toUpperCase();
  if (!BIC.test(code)) return undefined;
  const found = BANKS.flatMap((entry) => (entry.bic ?? [])
    .filter((prefix) => code.startsWith(prefix))
    .map((prefix) => ({ entry, length: prefix.length })));
  const longest = Math.max(0, ...found.map((match) => match.length));
  return preferCountry(found.filter((match) => match.length === longest).map((match) => match.entry), country);
}

/** Registry entry for a free-text bank name, an account label ("Raiffeisen · Giro") or a BIC. */
export function canonicalBank(name: string | null | undefined, country?: string): BankEntry | undefined {
  const normalized = normalizeBankName(name);
  if (!normalized) return undefined;
  const found = BANKS.filter((entry) => matches(entry, normalized));
  if (found.length) return preferCountry(found, country);
  return bankByBic(bankLabel(name), country);
}

export function bankDisplayName(name: string | null | undefined, country?: string): string {
  return canonicalBank(name, country)?.name ?? bankLabel(name);
}

/** One letter for one-word names, two for longer ones: "Raiffeisen" → "R", "Trade Republic" → "TR". */
export function bankMonogram(name: string | null | undefined, country?: string): string {
  const entry = canonicalBank(name, country);
  if (entry?.monogram) return entry.monogram;
  const words = (entry?.name ?? bankLabel(name)).match(/[\p{L}\p{N}]+/gu) ?? [];
  const significant = words.filter((word, index) => index === 0 || !SKIPPED_WORDS.has(word.toLowerCase()));
  return significant.slice(0, 2).map((word) => [...word][0]).join("").toLocaleUpperCase("de-AT");
}

// FNV-1a keeps the hue stable across sessions and machines.
function hueOf(text: string) {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/** Registry brand color, otherwise a calm hue derived from the name; both stay readable with white text. */
export function bankColor(name: string | null | undefined, country?: string): string {
  const entry = canonicalBank(name, country);
  if (entry?.color) return entry.color;
  const normalized = normalizeBankName(entry?.name ?? name);
  return normalized ? `oklch(0.5 0.11 ${hueOf(normalized)})` : "oklch(0.5 0.02 260)";
}

/** Same-origin logo URL; known banks use their registry name so every label shares one cached file. */
export function bankLogoUrl(name: string, country?: string): string {
  const entry = canonicalBank(name, country);
  const label = (entry?.name ?? bankLabel(name)).slice(0, 120).trim();
  if (!label) return "";
  const market = upperCountry(country) ?? entry?.country ?? "AT";
  return `/api/banks/logo?${new URLSearchParams({ name: label, country: market })}`;
}
