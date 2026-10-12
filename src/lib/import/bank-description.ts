const bankingField = String.raw`(?:iban|bic|swift)(?:[\s/-]+(?:auftraggeber|(?:zahlungs)?empf(?:ä|ae)nger|beg(?:ü|ue)nstigter|zahlungspflichtiger))?|auftraggeberreferenz|mandats?(?:referenz|nummer|[-\s]*id)|gl(?:ä|ae)ubiger[-\s]*id|end[-\s]*to[-\s]*end[-\s]*(?:id|referenz)`;
const usefulField = String.raw`verwendungszweck(?:\/text)?|zahlungsreferenz|(?:h(?:ä|ae|a)ndler|merchant)(?:[\s-]*name)?|(?:name\s+)?(?:auftraggeber|(?:zahlungs)?empf(?:ä|ae)nger|beg(?:ü|ue)nstigter)|name|details|transaktionsdetails|zusatztext`;
const field = new RegExp(
  String.raw`\b(${bankingField}|${usefulField})\s*:\s*`,
  "gi",
);
const metadata = new RegExp(String.raw`^(?:${bankingField})$`, "i");
const bankingMarker = new RegExp(String.raw`\b(?:${bankingField})\s*:`, "i");
const iban = /\b[A-Z]{2}\d{2}[A-Z\d]{10,30}\b/g;

function meaningfulParts(text: string, keepLabels: boolean): string[] {
  const normalized = text.normalize("NFKC");
  const fields = [...normalized.matchAll(field)];
  const parts = [normalized.slice(0, fields[0]?.index ?? normalized.length)];
  for (let index = 0; index < fields.length; index++) {
    const match = fields[index];
    if (metadata.test(match[1])) continue;
    parts.push(
      (keepLabels ? match[0] : "") +
        normalized.slice(
          match.index + match[0].length,
          fields[index + 1]?.index ?? normalized.length,
        ),
    );
  }
  return parts
    .map((part) =>
      part
        .replace(iban, " ")
        .replace(/\s+/g, " ")
        .replace(/^[\s:;,|]+|[\s:;,|]+$/g, "")
        .trim(),
    )
    .filter(Boolean);
}

export function stripBankMetadata(text: string): string {
  if (
    !bankingMarker.test(text) &&
    !/\b[A-Z]{2}\d{2}[A-Z\d]{10,30}\b/.test(text)
  )
    return text;
  const cleaned = meaningfulParts(text, true).join(" ").trim();
  return cleaned === text.normalize("NFKC").replace(/\s+/g, " ").trim()
    ? text
    : cleaned;
}

export function cleanBookingText(text: string): string {
  return meaningfulParts(text, false).join(" ").trim();
}
