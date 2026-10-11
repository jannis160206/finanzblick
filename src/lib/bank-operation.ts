import type { Transaction } from "@/lib/types";
import type { Category } from "@/lib/categories";

type BankBooking = Pick<Transaction, "description"> &
  Partial<
    Pick<
      Transaction,
      "bank" | "rawDescription" | "rawDetails" | "sourceCategory"
    >
  > & { amount?: number | null };

export type BankOperation =
  | {
      kind: "fee";
      category: "Bankgebühren" | "Rücklastschriftgebühren" | "Rückerstattungen";
    }
  | { kind: "interest"; category: "Einkommen" }
  | { kind: "internal-transfer"; category: "Transfer intern" }
  | { kind: "external-transfer" | "ambiguous"; category: "Prüfen" };

const normalize = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss");
const refund =
  /\b(?:r(?:ue|u)ck(?:erstattung|verg(?:ue|u)tung)|erstattung|refund|retoure|storno)\b/;
const returnedFee =
  /\br(?:ue|u)cklastschrift[-\s]*(?:geb(?:ue|u)hr(?:en)?|entgelte?|kosten)\b|\b(?:geb(?:ue|u)hr(?:en)?|entgelte?|kosten)\s+(?:f(?:ue|u)r|wegen)\s+(?:(?:eine|einer|der)\s+)?r(?:ue|u)cklastschrift\b/;
const accountFee =
  /\b(?:kontof(?:ue|u)hrung(?:s(?:geb(?:ue|u)hr(?:en)?|entgelte?|kosten))?|konto(?:geb(?:ue|u)hr(?:en)?|entgelte?|kosten|spesen)|bank(?:geb(?:ue|u)hr(?:en)?|spesen)|karten(?:geb(?:ue|u)hr(?:en)?|entgelte?)|buchungs(?:geb(?:ue|u)hr(?:en)?|entgelte?)|(?:sepa[-\s]*)?(?:ue|u)berweisungs(?:geb(?:ue|u)hr(?:en)?|entgelte?)|transfer[-\s]*geb(?:ue|u)hr(?:en)?)\b|\b(?:entgelte?|geb(?:ue|u)hr(?:en)?)\s+f(?:ue|u)r\s+(?:die\s+)?(?:konto|karten)f(?:ue|u)hrung\b|\b(?:geb(?:ue|u)hr(?:en)?|entgelte?)\s+f(?:ue|u)r\s+(?:eine\s+)?(?:sepa[-\s]*)?(?:ue|u)berweisung\b|\b(?:amex|american\s*express)\b.*\b(?:monats|mitglieds|jahres)geb(?:ue|u)hr\b|\b(?:account\s+maintenance\s+fee|monthly\s+account\s+fee|annual\s+card\s+fee|bank\s+charges?|transfer\s+fee)\b/;
const internal =
  /\b(?:interne?\s+(?:(?:ue|u)berweisung|umbuchung)|eigen(?:ue|u)bertrag|eigen(?:ue|u)berweisung|umbuchung\s+(?:zwischen|auf)\s+(?:den\s+|die\s+)?eigenen?\s+kont(?:en|o)|(?:ue|u)bertrag\s+(?:auf|zwischen)\s+(?:mein(?:e|en)?\s+|das\s+)?eigen(?:e|es|en)\s+kont(?:o|en))\b/;
const external =
  /\b(?:konto(?:ue|u)berweisung|sepa[-\s]*(?:(?:ue|u)berweisung|(?:instant[-\s]*)?credit\s+transfer)|bank[-\s]*transfer|(?:ue|u)berweisung\s+(?:an|von)|echtzeit(?:ue|u)berweisung|dauerauftrag|standing\s+order)\b|^(?:ue|u)berweisung\b/;
const operationField =
  /^(?:buchungs(?:art|typ|text)|transaktions(?:art|typ)|transaction\s*type|payment\s*type|verwendungszweck|purpose)\s*[:=]\s*(.*)$/i;
const providerFee =
  /\b(?:pay\s*pal(?:\s*[*\/]\s*|\s+)|pp\s*[*\/]\s*)(?:transaktionsgeb(?:ue|u)hr(?:en)?|geb(?:ue|u)hr(?:en)?)\b/;
const withdrawalFee =
  /\b(?:bankomatgeb(?:ue|u)hr(?:en)?|bargeld(?:behebungs|abhebungs)(?:geb(?:ue|u)hr(?:en)?|entgelte?)|atm[-\s]*fee|cash\s+withdrawal\s+fee)\b|\bgeb(?:ue|u)hr\s+f(?:ue|u)r\s+(?:die\s+)?bargeld(?:behebung|abhebung)\b/;
const capitalTax = /\b(?:kapitalertragsteuer|kapitalertragssteuer|kest)\b/;
const creditInterest =
  /\b(?:haben[-\s]*zinsen|zinsertrag|zinsgutschrift|credit\s+interest|interest\s+earned)\b/;
const walletTopUp =
  /^(?:pay\s*pal\s*\*?|pp\s*[*\/])\s*(?:guthaben(?:s)?[-\s]*(?:aufladung|aufgeladen)|guthaben\s+aufladen|wallet\s+top[-\s]*up|balance\s+top[-\s]*up)\s*(?:[\d.,+\-/\s]+\s*(?:eur|usd|gbp)?)?$/;

function operationTexts(row: BankBooking): string[] | undefined {
  const fields = [row.description, row.rawDescription, row.sourceCategory];
  for (const detail of row.rawDetails ?? []) {
    const match = operationField.exec(detail.trim());
    if (match) fields.push(match[1]);
  }
  if (
    fields.some((field) => field && field.length > 4096) ||
    fields.reduce((size, field) => size + (field?.length ?? 0), 0) > 8192
  )
    return;
  return fields.filter((field): field is string => !!field).map(normalize);
}

export function bankOperation(row: BankBooking): BankOperation | undefined {
  const texts = operationTexts(row);
  if (!texts) return { kind: "ambiguous", category: "Prüfen" };
  const text = texts.join(" | ");
  const returnFee = returnedFee.test(text);
  const issuerFee =
    /^(?:amex|american\s+express)$/i.test(row.bank?.trim() ?? "") &&
    texts.some((value) =>
      /^(?:(?:erstattung|storno)\s+)?(?:monats|mitglieds|jahres)geb(?:ue|u)hr(?:en)?\b/.test(
        value.trim(),
      ),
    );
  const fee =
    returnFee ||
    issuerFee ||
    accountFee.test(text) ||
    providerFee.test(text) ||
    withdrawalFee.test(text) ||
    capitalTax.test(text);
  if (creditInterest.test(text)) {
    if (
      fee ||
      refund.test(text) ||
      typeof row.amount !== "number" ||
      row.amount <= 0 ||
      /\b(?:keine?|ohne|nicht|not|no|sollzinsen|debitor|debit)\b/.test(text)
    )
      return { kind: "ambiguous", category: "Prüfen" };
    return { kind: "interest", category: "Einkommen" };
  }
  if (fee) {
    if (
      /\b(?:inkl(?:usive)?|einschliesslich|zzgl|zuz(?:ue|u)glich|plus|samt)\b[^|]*\b[a-z-]*(?:geb(?:ue|u)hr|entgelt|spesen)/.test(
        text,
      ) ||
      /\b(?:keine?|ohne|nicht|not|no)\b[^|]{0,40}\b(?:kontof(?:ue|u)hrung|geb(?:ue|u)hr|fee|entgelt|spesen|kapitalertrags?steuer|kest)/.test(
        text,
      ) ||
      row.amount === null ||
      (typeof row.amount === "number" && row.amount >= 0 && !refund.test(text))
    )
      return { kind: "ambiguous", category: "Prüfen" };
    return {
      kind: "fee",
      category:
        typeof row.amount === "number" && row.amount > 0
          ? "Rückerstattungen"
          : returnFee
            ? "Rücklastschriftgebühren"
            : "Bankgebühren",
    };
  }

  if (refund.test(text)) return;
  if (
    texts.some(
      (value) => internal.test(value) || walletTopUp.test(value.trim()),
    )
  )
    return { kind: "internal-transfer", category: "Transfer intern" };
  if (
    texts.some((value) => external.test(value)) ||
    /^(?:(?:ue|u)berweisung|bank[-\s]*transfer|transfer|credit\s*transfer|dauerauftrag|standing\s*order)$/.test(
      normalize(row.sourceCategory ?? ""),
    )
  )
    return { kind: "external-transfer", category: "Prüfen" };
}

const transferPurposes: readonly [RegExp, Category][] = [
  [
    /\b(?:vollkasko|haftpflicht|versicherungs(?:beitrag|praemie|pramie))\b/,
    "Versicherungen",
  ],
  [/\b(?:leasing(?:rate|raten)?|autokreditrate)\b/, "Leasing"],
  [
    /\b(?:miete|mietzahlung|mietzins|mietvorschreibung|rent\s+payment)\b/,
    "Miete",
  ],
  [
    /\b(?:stromrechnung|gasrechnung|heizkosten|energiekosten)\b/,
    "Energie & Nebenkosten",
  ],
  [
    /\b(?:telefonrechnung|mobilfunkrechnung|internetrechnung)\b/,
    "Telefon & Internet",
  ],
];

export function bankTransferPurpose(row: BankBooking): Category | undefined {
  if (typeof row.amount !== "number" || row.amount >= 0) return;
  const texts = operationTexts(row);
  if (!texts) return "Prüfen";
  const matches = new Set(
    transferPurposes
      .filter(([pattern]) => texts.some((text) => pattern.test(text)))
      .map(([, category]) => category),
  );
  return matches.size > 1 ? "Prüfen" : [...matches][0];
}

export function bankOperationReviewMessage(
  row: BankBooking,
): string | undefined {
  const operation = bankOperation(row);
  if (operation?.kind === "external-transfer")
    return "Verwendungszweck der Überweisung noch offen – bitte prüfen.";
  if (operation?.kind === "ambiguous")
    return "Bankvorgang widersprüchlich – bitte prüfen.";
}
