import { createHash } from "node:crypto";

export type OrderMail = { messageId: string; from: string; subject: string; text: string; date: string };
export type PaymentMethod = "card" | "paypal" | "klarna" | "invoice" | "unknown";
export type ParsedOrder = {
  kind: "order";
  id: string;
  shop: string;
  product?: string;
  orderNumber?: string;
  amount: number;
  orderDate: string;
  dueDate: string;
  method: PaymentMethod;
  installments: number;
  /** A plain invoice/receipt from a non-shop sender (phone, power, insurance) – usually already a fixed cost. */
  bill?: true;
};
export type ParsedCancel = { kind: "cancel"; id: string; shop: string; orderNumber?: string; amount?: number; date: string };

const DAY_MS = 86_400_000;
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const shops: Array<[RegExp, string]> = [
  [/amazon\./, "Amazon"], [/zalando/, "Zalando"], [/aboutyou|about you/, "About You"], [/otto\.(de|at)/, "Otto"],
  [/mediamarkt/, "MediaMarkt"], [/saturn\./, "Saturn"], [/ikea/, "IKEA"], [/apple\.com|itunes/, "Apple"], [/ebay/, "eBay"],
  [/temu/, "Temu"], [/shein/, "Shein"], [/aliexpress/, "AliExpress"], [/hm\.com|h&m/, "H&M"], [/zara\./, "Zara"], [/nike\./, "Nike"],
  [/adidas/, "adidas"], [/douglas/, "Douglas"], [/notino/, "Notino"], [/thalia/, "Thalia"], [/galaxus|digitec/, "Galaxus"],
  [/cyberport/, "Cyberport"], [/alternate\./, "Alternate"], [/lidl/, "Lidl"], [/hornbach/, "Hornbach"], [/obi\./, "OBI"],
  [/bol\.com/, "bol.com"], [/willhaben/, "willhaben"], [/shop-apotheke|shopapotheke/, "Shop Apotheke"], [/decathlon/, "Decathlon"],
  [/xxxlutz|lutz\./, "XXXLutz"], [/hervis/, "Hervis"], [/bipa\./, "BIPA"], [/dm\.(de|at)|dm-drogerie/, "dm"], [/steam/, "Steam"],
  [/playstation|sony/, "PlayStation"], [/nintendo/, "Nintendo"], [/booking\.com/, "Booking.com"], [/airbnb/, "Airbnb"],
  [/lieferando|mjam|foodora/, "Lieferando"], [/wolt/, "Wolt"], [/uber/, "Uber"],
];

const ORDER_SUBJECT = /bestell|order|auftrag|kaufbest|rechnung|invoice|receipt|beleg|zahlungsplan|einkauf|purchase|buchungsbestätigung|deine zahlung|ihre zahlung|zahlung an/i;
const SHIPPING = /versandt|verschickt|unterwegs|zugestellt|geliefert|shipped|delivered|out for delivery|sendungsverfolgung|paket|lieferung (?:kommt|ist)/i;
const NOISE = /newsletter|angebot|sale\b|rabatt|gutschein|deals?\b|bewerte|bewertung|review|umfrage|survey|wunschliste|warenkorb|vergessen|passwort|anmeldung|sicherheits|willkommen|preisalarm/i;
const CANCEL = /storn|cancel|widerruf|abgebrochen|rückerstattung|erstattung|refund/i;

export function parseAmount(raw: string): number | undefined {
  const value = raw.replace(/\s/g, "");
  const normalized = /,\d{2}$/.test(value) ? value.replace(/\./g, "").replace(",", ".") : value.replace(/,/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 && amount < 100_000 ? Math.round(amount * 100) / 100 : undefined;
}

const NUMBER = String.raw`(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})`;
const LABEL = String.raw`(gesamt\s*(?:betrag|summe|preis)?(?:\s+der\s+bestellung)?|bestell(?:summe|wert|betrag)|endbetrag|endsumme|zu zahlen(?:der betrag)?|rechnungs(?:betrag|summe)|zahlungsbetrag|betrag|summe|grand total|order total|total|amount paid|charged)`;

/** The order total: labelled totals win over plain amounts, the last "Gesamt" beats an earlier "Zwischensumme". */
export function orderTotal(text: string): number | undefined {
  const pattern = new RegExp(`${LABEL}[^\\d\\n€]{0,40}?(?:EUR|€)?\\s*${NUMBER}`, "gi");
  let best: { amount: number; score: number } | undefined;
  for (const match of text.matchAll(pattern)) {
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const before = text.slice(Math.max(lineStart, match.index - 20), match.index).toLowerCase();
    const label = match[1].toLowerCase();
    if (/zwischen|versand|steuer|mwst|ust\b|rabatt|ersparnis|gutschein|punkte|monatlich|rate\b/.test(before + label)) continue;
    const amount = parseAmount(match[2]);
    if (!amount) continue;
    const score = /gesamt|endbetrag|endsumme|zu zahlen|grand|order total|zahlungsbetrag|rechnungs/.test(label) ? 2 : 1;
    if (!best || score >= best.score) best = { amount, score };
  }
  if (best) return best.amount;
  const plain = [...text.matchAll(new RegExp(`(?:EUR|€)\\s*${NUMBER}|${NUMBER}\\s*(?:EUR|€)`, "g"))]
    .map((match) => parseAmount(match[1] ?? match[2])).filter((value): value is number => value !== undefined);
  return new Set(plain).size === 1 ? plain[0] : undefined;
}

const MONTHS = ["januar|jänner|jaenner|january|jan", "februar|feber|february|feb", "märz|maerz|march|mär|mar", "april|apr", "mai|may",
  "juni|june|jun", "juli|july|jul", "august|aug", "september|sept|sep", "oktober|october|okt|oct", "november|nov", "dezember|december|dez|dec"];

function parseDate(raw: string, fallbackYear: number): string | undefined {
  const numeric = raw.match(/(\d{1,2})\.\s?(\d{1,2})\.(\d{2,4})?/);
  let day: number, month: number, year: number;
  if (numeric) {
    day = Number(numeric[1]); month = Number(numeric[2]);
    year = numeric[3] ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : fallbackYear;
  } else {
    const named = raw.match(/(\d{1,2})\.?\s+([a-zäö]+)\.?\s*(\d{4})?/i);
    if (!named) return undefined;
    const index = MONTHS.findIndex((names) => new RegExp(`^(?:${names})`, "i").test(named[2]));
    if (index < 0) return undefined;
    day = Number(named[1]); month = index + 1; year = named[3] ? Number(named[3]) : fallbackYear;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function dueDate(text: string, orderDate: string): string | undefined {
  const match = text.match(/(?:fällig(?:keit)?|faellig|zahlbar|zahlen bis|bezahlen bis|spätestens|due(?: date)?|payment due)\D{0,25}?(\d{1,2}\.\s?\d{1,2}\.(?:\d{2,4})?|\d{1,2}\.?\s+[A-Za-zäöÄÖ]+\.?(?:\s+\d{4})?)/i);
  const date = match ? parseDate(match[1], Number(orderDate.slice(0, 4))) : undefined;
  if (date) {
    const fixed = date < orderDate && date.slice(0, 4) === orderDate.slice(0, 4) ? `${Number(date.slice(0, 4)) + 1}${date.slice(4)}` : date;
    if (fixed >= orderDate && fixed <= addDays(orderDate, 120)) return fixed;
  }
  const days = text.match(/(?:innerhalb von|innerhalb|in|binnen)\s+(\d{1,3})\s+tagen?/i);
  return days && Number(days[1]) <= 90 ? addDays(orderDate, Number(days[1])) : undefined;
}

function paymentMethod(text: string): PaymentMethod {
  if (/klarna/i.test(text)) return "klarna";
  if (/kauf auf rechnung|per rechnung|zahlung per rechnung|zahlungsart:?\s*rechnung|vorkasse|überweisung bis|zahlbar bis|payment due/i.test(text)) return "invoice";
  if (/paypal/i.test(text)) return "paypal";
  if (/kreditkarte|credit card|visa|mastercard|american express|amex|apple pay|google pay|lastschrift|sepa|debitkarte|maestro/i.test(text)) return "card";
  return "unknown";
}

export function shopName(from: string, subject: string, text: string): string {
  const address = from.toLowerCase();
  for (const [pattern, name] of shops) if (pattern.test(address)) return name;
  if (/klarna|paypal/.test(address)) {
    const merchant = `${subject}\n${text}`.match(/\b(?:bei|an|at|to)\s+([A-Z0-9][\w&.'-]*(?: [A-Z0-9][\w&.'-]*){0,3})/);
    if (merchant) return merchant[1].trim().slice(0, 40);
  }
  for (const [pattern, name] of shops) if (pattern.test(subject.toLowerCase())) return name;
  const display = from.match(/^\s*"?([^"<@]+?)"?\s*</)?.[1]?.trim();
  if (display && !/no.?reply|service|info|kundenservice|bestellung|order/i.test(display)) return display.slice(0, 40);
  const domain = address.match(/@(?:[\w-]+\.)*?([\w-]+)\.[a-z]{2,}>?\s*$/)?.[1];
  return domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : "Onlineshop";
}

const productName = (subject: string) => subject.match(/(?:bestellt|ordered)\s*:\s*[„"']?(.+?)[“"']?(?:\s+und\s+\d+\s+weitere.*)?$/i)?.[1]?.trim().slice(0, 50);

export const orderNumber = (text: string) =>
  text.match(/(?:bestell(?:nummer|nr\.?|-nr\.?)|auftrags(?:nummer|nr\.?)|order\s*(?:number|no\.?|#|id)|bestellung\s*(?:nr\.?|#)|rechnungs(?:nummer|nr\.?))\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,40})/i)?.[1];

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Turns one shop/payment mail into an order, a cancellation or nothing. Shipping notices and marketing are ignored. */
export function parseOrderMail(mail: OrderMail): ParsedOrder | ParsedCancel | undefined {
  const subject = mail.subject.trim();
  const text = mail.text.slice(0, 40_000);
  const orderDate = mail.date.slice(0, 10);
  const shop = shopName(mail.from, subject, text);
  const number = orderNumber(`${subject}\n${text}`);
  if (CANCEL.test(subject)) {
    const amount = orderTotal(text);
    return { kind: "cancel", id: hash(mail.messageId), shop, ...(number ? { orderNumber: number } : {}), ...(amount ? { amount } : {}), date: orderDate };
  }
  if (!ORDER_SUBJECT.test(subject) || SHIPPING.test(subject) || (NOISE.test(subject) && !number)) return undefined;
  if (/zahlung erhalten|payment received|geld erhalten|hat dir .* gesendet/i.test(subject)) return undefined;
  const amount = orderTotal(text);
  if (!amount) return undefined;
  const method = paymentMethod(`${mail.from}\n${subject}\n${text}`);
  const rates = method === "klarna" ? /(?:in|zahle in)\s+(3|4)\s+raten|pay in (3|4)/i.exec(text) : null;
  const installments = rates ? Number(rates[1] ?? rates[2]) : 1;
  const due = dueDate(text, orderDate) ?? (installments > 1 ? orderDate : method === "klarna" ? addDays(orderDate, 30)
    : method === "invoice" ? addDays(orderDate, 14) : addDays(orderDate, 2));
  const product = productName(subject);
  const bill = !/bestell|order|kauf|klarna|zahlungsplan|purchase/i.test(subject) && !shops.some(([pattern]) => pattern.test(mail.from.toLowerCase()));
  return { kind: "order", id: hash(number ? `${shop}|${number}` : mail.messageId), shop, ...(product ? { product } : {}),
    ...(number ? { orderNumber: number } : {}), amount, orderDate, dueDate: due, method, installments, ...(bill ? { bill: true as const } : {}) };
}

export const GMAIL_QUERY = "(category:purchases OR subject:(bestellung OR bestellbestätigung OR bestellt OR auftragsbestätigung OR rechnung OR order OR klarna OR zahlungsplan OR storniert OR stornierung OR receipt))";
