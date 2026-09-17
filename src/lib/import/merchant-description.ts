import type { Transaction } from "@/lib/types";

type MerchantSource = Pick<Transaction, "description"> & Partial<Pick<Transaction, "rawDescription" | "rawDetails">>;
const clean = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
const terminal = /(?:^|\b)(?:pos|ban[ck]omat\s*\/\s*pos|kartenterminal|terminal|kartenfolge(?:[-\s]*nr\.?)?)\b|\b[DK]\d\b/i;
const purpose = /verwendungszweck(?:\/text)?\s*:\s*([\s\S]*?)(?=\s*(?:(?:zahlungsreferenz|auftraggeberreferenz|mandat)\s*:|(?:iban|bic)\b)|$)/i;
const reference = /zahlungsreferenz\s*:\s*([\s\S]*?)(?=\s*(?:(?:auftraggeberreferenz|mandat)\s*:|(?:iban|bic)\b)|$)/i;

export function hasTerminalText(text: string): boolean {
  return terminal.test(text);
}

const merchantLabel = String.raw`(?:h(?:ä|ae|a)ndler|merchant)(?:[\s-]*name)?`;
const labeledMerchant = new RegExp(`${merchantLabel}\\s*:`, "i");
const namedMerchant = new RegExp(
  String.raw`(?:^|[\s;|])${merchantLabel}\s*:\s*([\s\S]*?)(?=\s*(?:${merchantLabel}|verwendungszweck(?:\/text)?|zahlungsreferenz|auftraggeberreferenz|mandat|referenz|iban|bic|h(?:ä|ae|a)ndler[\s-]*(?:ort|land)|merchant[\s-]*(?:city|country))\s*:|\s+(?:iban|bic)\b|$)`,
  "gi",
);
const leadingLabel = new RegExp(`^(?:verwendungszweck(?:/text)?|zahlungsreferenz|details|transaktionsdetails|${merchantLabel}|zusatztext)\\s*:\\s*`, "i");

// Strip only payment metadata. Never use a timestamp, reference, IBAN or
// currency-only cell as a merchant, nor fabricate a merchant from a POS amount.
export function merchantText(text: string): string {
  const labeled = text.replace(leadingLabel, "");
  const value = clean(labeled
    .replace(/\bterminal[-\s]*(?:id|nr|nummer)\.?\s*:?\s*[A-Z\d*-]+/gi, " ")
    .replace(/\b(?:kartenfolge(?:[-\s]*(?:nr|nummer)\.?)?|karten(?:nummer|[-\s]*nr\.?)|terminal(?:[-\s]*(?:id|nr)\.?)?)\s*:?\s*[\d*X-]+/gi, " ")
    .replace(/\bban[ck]omat\s*\/\s*pos\b|\b(?:pos|kartenterminal|terminal|kartenzahlung|zahlung|debit)\b/gi, " ")
    .replace(/\b(?:[A-Z]{2}\s+)?[DK]\d\b/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./](?:\d{2,4}\b)?/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2}(?:[.:]\d{3})?)?\b/g, " ")
    .replace(/(?:^|\s)[+\-]?\d[\d.]*,\d{2}(?=\s|$)|\b\d+\.\d{2}\b/g, " ")
    .replace(/\b(?:EUR|USD|CHF|Uhr|AT|DE)\b/g, " ")
    .replace(/^[\s:;,/|\-]+|[\s:;,/|\-]+$/g, ""));
  if (!/[\p{L}]{2}/u.test(value) || /^(?:[A-Z]{2}\d{2}[\dA-Z\s]+|(?:EUR|USD|CHF)|[\d\s:./-]+)$/i.test(value) ||
    /^(?:kartenfolge|referenz|iban|bic|saldo|guthaben|buchungsdatum|valuta|verwendungszweck|details)\b/i.test(value)) return "";
  return value;
}

export function unresolvedTerminal(text: string): boolean {
  return hasTerminalText(text) && !merchantText(text);
}

const recoverable = (row: MerchantSource) => hasTerminalText(row.description) || purpose.test(row.description) || reference.test(row.description) || labeledMerchant.test(row.description);
function merchantCandidates(row: MerchantSource): string[] {
  const sources = [row.description, ...(row.rawDetails ?? []), row.rawDescription ?? ""];
  const extract = (pattern: RegExp) => sources.map((text) => pattern.exec(text)?.[1])
    .filter((text): text is string => !!text).map(merchantText).filter(Boolean);
  // Explicit merchant fields outrank purpose/reference text, which may be only payment metadata.
  const named = sources.flatMap((text) => [...text.matchAll(namedMerchant)].map((match) => merchantText(match[1]))).filter(Boolean);
  const purposes = extract(purpose);
  const references = extract(reference);
  const candidates = named.length ? named : purposes.length ? purposes : references.length ? references : sources.map(merchantText).filter(Boolean);
  return [...new Map(candidates.map((text) => [clean(text).toLowerCase(), text])).values()];
}

export function ambiguousMerchant(row: MerchantSource): boolean {
  return recoverable(row) && merchantCandidates(row).length > 1;
}

export function recoverMerchant<T extends MerchantSource>(row: T): T {
  if (!recoverable(row)) return row;
  const unique = merchantCandidates(row);
  if (unique.length !== 1) return row;
  const description = /\bmartin\s+auer\b/i.test(unique[0]) ? "Martin Auer" : unique[0];
  if (!description || description === row.description) return row;
  return { ...row, description, rawDescription: row.rawDescription ?? row.description };
}

export function merchantKeyText(description: string): string {
  const recovered = recoverMerchant({ description }).description;
  const text = hasTerminalText(recovered) ? merchantText(recovered) || recovered : clean(recovered);
  // Branch/address suffixes do not change this merchant's identity.
  if (/\bmartin\s+auer\b/i.test(text)) return "martin auer";
  if (/\bshell\s+furnitz\b/i.test(text)) return "shell furnitz";
  const trafik = /\btrafik\s+(warum|haas)\b/i.exec(text);
  if (trafik) return `trafik ${trafik[1].toLowerCase()}`;
  if (/\b(?:billa|bipa|(?:inter|euro)?spar)\b/i.test(text)) return text.toLocaleLowerCase("de-AT")
    .replace(/\b(?:dankt|filiale|fil|store|nr)\b\.?\s*:?\s*/g, "")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b|\b\d{1,2}[./]\d{1,2}[./](?:\d{2,4})?\b/g, " ")
    .replace(/\s+/g, " ").trim();
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
