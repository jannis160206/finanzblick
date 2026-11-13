import type { Transaction } from "@/lib/types";

type AtmBooking = Partial<
  Pick<Transaction, "description" | "rawDescription" | "rawDetails">
>;

export type AtmBankReference = {
  name: string;
  aliases?: readonly string[];
};

const raiffeisen: AtmBankReference = {
  name: "Raiffeisen",
  aliases: [
    "Raiffeisenbank",
    "Raiffeisen Bank",
    "Raiffeisen Bank International",
    "Raiffeisen Giro",
    "Raiffeisen Hauptkonto",
  ],
};
const familiarBanks: readonly AtmBankReference[] = [
  raiffeisen,
  { name: "Revolut" },
  { name: "Sparkasse" },
  { name: "Volksbank" },
  { name: "ING" },
  { name: "N26" },
  { name: "bunq" },
  { name: "Santander" },
  { name: "HSBC" },
  { name: "Citi", aliases: ["Citibank"] },
  { name: "Chase" },
  { name: "Barclays" },
];

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase("de-AT")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const operatorLabel = String.raw`(?:bank|(?:atm[-\s]*)?(?:operator|betreiber)|automatenbetreiber)`;

function bookingSourceTexts(row: AtmBooking) {
  const texts = [
    row.description ?? "",
    row.rawDescription ?? "",
    ...(row.rawDetails ?? []),
  ];
  if (
    texts.length > 22 ||
    texts.some((text) => text.length > 10_000) ||
    texts.reduce((length, text) => length + text.length, 0) > 32_000
  )
    return [];
  return texts;
}

function bookingTexts(row: AtmBooking) {
  return bookingSourceTexts(row).map((text) =>
    normalize(
      text
        .normalize("NFKC")
        // The combined source label describes ordinary card terminals, not withdrawals.
        .replace(/\bban[ck]omat\s*\/\s*pos\b/giu, " ")
        .replace(new RegExp(`\\b${operatorLabel}\\s*[:=]\\s*`, "giu"), " "),
    ),
  );
}

// Austrian machines ("BANKOMAT 00092293", "SB-BEHEBUNG") and withdrawals abroad ("Bargeldbehebung Flughafen", "ATM 1142").
const DOMESTIC_ATM = /(?:^| )(?:bankomat(?:en)?|bank ?automat(?:en)?|sb behebung)(?= |$|\d)/u;
const ANY_ATM = /(?:^| )(?:bankomat(?:en)?|bank ?automat(?:en)?|sb behebung|bargeldbehebung|geldautomat(?:en)?|cash withdrawal|atm)(?= |$|\d)/u;

export function isAtmBooking(row: AtmBooking) {
  return bookingTexts(row).some((text) => ANY_ATM.test(text));
}

export function isBankLogoName(name: string) {
  const normalized = normalize(name);
  return (
    familiarBanks.some((bank) =>
      [bank.name, ...(bank.aliases ?? [])].some(
        (alias) => normalize(alias) === normalized,
      ),
    ) ||
    /(?:^| )(?:bank|[\p{L}]+bank|sparkasse|raiffeisen|volksbank)(?: |$)/u.test(
      normalized,
    )
  );
}

export function atmLogoBank(
  row: AtmBooking,
  references: readonly AtmBankReference[] = [],
): (AtmBankReference & { explicit: boolean }) | null {
  if (!isAtmBooking(row)) return null;
  const banks: { name: string; aliases: string[] }[] = [];
  for (const reference of [...familiarBanks, ...references]) {
    const aliases = [
      ...new Set([reference.name, ...(reference.aliases ?? [])]),
    ].filter((name) => normalize(name) && normalize(name) !== "bank");
    const keys = new Set(aliases.map(normalize));
    const existing = banks.filter((bank) =>
      bank.aliases.some((alias) => keys.has(normalize(alias))),
    );
    if (existing.length === 1)
      existing[0].aliases = [...new Set([...existing[0].aliases, ...aliases])];
    else banks.push({ name: reference.name, aliases });
  }
  const matches = bookingTexts(row).flatMap((text) =>
    banks.flatMap((bank) =>
      bank.aliases.flatMap((alias) => {
        const name = normalize(alias);
        const expression = new RegExp(`(?:^| )(${name})(?= |$|\\d)`, "gu");
        return [...text.matchAll(expression)].map((match) => ({
          bank,
          text,
          start: match.index + match[0].length - match[1].length,
          end: match.index + match[0].length,
        }));
      }),
    ),
  );
  // Prefer a full bank name to an overlapping shorter brand, never a fuzzy match.
  const specific = matches.filter(
    (match) =>
      !matches.some(
        (other) =>
          other.text === match.text &&
          other.start <= match.start &&
          other.end >= match.end &&
          other.end - other.start > match.end - match.start,
      ),
  );
  const otherBanks = new Set(
    specific
      .map((match) => match.bank)
      .filter((bank) => normalize(bank.name) !== "raiffeisen"),
  );
  if (otherBanks.size > 1) return null;
  const operators = bookingSourceTexts(row).flatMap((text) =>
    [
      ...text
        .normalize("NFKC")
        .matchAll(
          new RegExp(`\\b${operatorLabel}\\s*[:=]\\s*([^;|\\r\\n]*)`, "giu"),
        ),
    ].map((match) => normalize(match[1])),
  );
  if (
    operators.some(
      (operator) =>
        !banks.some((bank) =>
          bank.aliases.some((alias) =>
            new RegExp(`^${normalize(alias)}(?= |$|\\d)`, "u").test(operator),
          ),
        ),
    )
  )
    return null;
  // An unknown explicitly named bank must not inherit the default artwork.
  const unknownBank = bookingTexts(row).some((text) => {
    const remainder = specific
      .filter((match) => match.text === text)
      .sort((a, b) => b.start - a.start)
      .reduce(
        (value, match) =>
          value.slice(0, match.start) +
          " ".repeat(match.end - match.start) +
          value.slice(match.end),
        text,
      );
    return /(?:^| )(?:bank|[\p{L}]+bank|sparkasse|volksbank)(?= |$|\d)/u.test(
      remainder.replace(/\bbank automat(?:en)?(?= |$|\d)/gu, ""),
    );
  });
  if (unknownBank) return null;
  const selected =
    [...otherBanks][0] ??
    specific.find((match) => normalize(match.bank.name) === "raiffeisen")?.bank;
  if (selected) return { ...selected, explicit: true };
  // An unnamed machine abroad belongs to some local bank, not to the household's own.
  return bookingTexts(row).some((text) => DOMESTIC_ATM.test(text))
    ? { ...raiffeisen, explicit: false }
    : null;
}
