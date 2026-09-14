import type { Transaction } from "@/lib/types";

type MerchantSource = Pick<Transaction, "description"> & Partial<Pick<Transaction, "rawDescription" | "rawDetails">>;
const clean = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
const terminal = /(?:^|\b)(?:pos|ban[ck]omat\s*\/\s*pos|kartenterminal|terminal|kartenfolge(?:[-\s]*nr\.?)?)\b|\b[A-Z]{2}\s+[DK]\d\b/i;

export function hasTerminalText(text: string): boolean {
  return terminal.test(text);
}

// Strip only payment metadata. Never use a timestamp, reference, IBAN or
// currency-only cell as a merchant, nor fabricate a merchant from a POS amount.
export function merchantText(text: string): string {
  const labeled = text.replace(/^(?:verwendungszweck(?:\/text)?|details|transaktionsdetails|händler|merchant|zusatztext)\s*:\s*/i, "");
  const value = clean(labeled
    .replace(/\bterminal[-\s]*(?:id|nr|nummer)\.?\s*:?\s*[A-Z\d*-]+/gi, " ")
    .replace(/\b(?:kartenfolge(?:[-\s]*(?:nr|nummer)\.?)?|karten(?:nummer|[-\s]*nr\.?)|terminal(?:[-\s]*(?:id|nr)\.?)?)\s*:?\s*[\d*X-]+/gi, " ")
    .replace(/\bban[ck]omat\s*\/\s*pos\b|\b(?:pos|kartenterminal|terminal|kartenzahlung|zahlung|debit)\b/gi, " ")
    .replace(/\b[A-Z]{2}\s+[DK]\d\b/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./](?:\d{2,4}\b)?/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2}(?:[.:]\d{3})?)?\b/g, " ")
    .replace(/(?:^|\s)[+\-]?\d[\d.]*,\d{2}(?=\s|$)|\b\d+\.\d{2}\b/g, " ")
    .replace(/\b(?:EUR|USD|CHF|Uhr|AT|DE)\b/g, " ")
    .replace(/^[\s:;,/|\-]+|[\s:;,/|\-]+$/g, ""));
  if (!/[\p{L}]{2}/u.test(value) || /^(?:[A-Z]{2}\d{2}[\dA-Z\s]+|[A-Z]{3}|[\d\s:./-]+)$/i.test(value) ||
    /^(?:kartenfolge|referenz|iban|bic|saldo|guthaben|buchungsdatum|valuta|verwendungszweck|details)\b/i.test(value)) return "";
  return value;
}

export function unresolvedTerminal(text: string): boolean {
  return hasTerminalText(text) && !merchantText(text);
}

export function recoverMerchant<T extends MerchantSource>(row: T): T {
  if (!hasTerminalText(row.description)) return row;
  const description = [row.description, ...(row.rawDetails ?? []), row.rawDescription ?? ""]
    .map(merchantText).find(Boolean);
  if (!description || description === row.description) return row;
  return { ...row, description, rawDescription: row.rawDescription ?? row.description };
}

export function merchantKeyText(description: string): string {
  const text = hasTerminalText(description) ? merchantText(description) || description : clean(description);
  // Branch/address suffixes do not change this merchant's identity.
  if (/\bmartin\s+auer\b/i.test(text)) return "martin auer";
  return text.toLocaleLowerCase("de-AT");
}

export function sameTerminalBooking(old: Transaction, incoming: Transaction): boolean {
  const original = old.rawDescription ?? old.description;
  return hasTerminalText(original) && old.date === incoming.date && old.amount === incoming.amount &&
    old.bank.toLowerCase() === incoming.bank.toLowerCase() &&
    (!old.pocket || !incoming.pocket || old.pocket === incoming.pocket) &&
    (old.bankReference && incoming.bankReference
      ? old.bankReference === incoming.bankReference
      : clean(original).toLowerCase() === clean(incoming.rawDescription ?? incoming.description).toLowerCase());
}
