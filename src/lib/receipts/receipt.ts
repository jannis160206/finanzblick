import type { Category } from "@/lib/categories";
import { buildSplits, type SplitPlan } from "@/lib/splits";

export type ReceiptItem = {
  name: string;
  /** Line total in euros after attached discounts; positive = spent, negative = Leergut/Pfand return. */
  amount: number;
  quantity?: number;
  unitPrice?: number;
  discount?: number;
  category: Category;
  note?: string;
  /** false when no keyword matched and the item kept the booking's fallback category. */
  known: boolean;
};

export type ParsedReceipt = {
  items: ReceiptItem[];
  /** SUMME/Gesamt from the receipt, if readable. */
  total?: number;
  itemsTotal: number;
  /** True when a printed total exists and the items add up to it to the cent. */
  totalMatches: boolean;
  ignoredLines: number;
};

const MAX_LINES = 400;
const MAX_ITEMS = 150;
const cents = (value: number) => Math.round(value * 100);
const euros = (value: number) => Math.round(value) / 100;

/** Normalises common OCR confusions in money tokens: "1, 49" → "1,49", "O,99" → "0,99". */
function normaliseLine(line: string): string {
  return line
    .normalize("NFKC")
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/(\d)\s*([,.])\s+(\d{2})(?!\d)/g, "$1$2$3")
    .replace(/(^|\s)[Oo]([,.]\d{2})(?!\d)/g, "$10$2")
    .replace(/\s+/g, " ")
    .trim();
}

function money(token: string): number | null {
  const match = /^(-)?(\d{1,5})[,.](\d{2})(-)?$/.exec(token.replace(/\s/g, ""));
  if (!match) return null;
  const value = Number(`${match[2]}.${match[3]}`);
  return match[1] || match[4] ? -value : value;
}

const PRICE_AT_END = /(-?\s?\d{1,5}[,.]\d{2}-?)\s*(?:[A-H]\*?|\*|EUR|€)?\s*$/;
// Groups: 1 name, 2 quantity, 3 unit price, 4 optional printed line total.
const QUANTITY = /^(.*?)\s*(\d{1,3}(?:[,.]\d{1,3})?)\s*(?:st(?:k|ück)?\.?\s*)?[xX×*]\s*(\d{1,5}[,.]\d{2})(?:\s*(?:EUR|€)(?:\s*\/\s*(?:st|stk))?)?(?:\s+(-?\d{1,5}[,.]\d{2}))?\s*(?:[A-H]\*?|\*)?\s*$/i;
const WEIGHT = /\d+[,.]\d{1,3}\s*kg\b/i;
const TOTAL = /^(?:summe|gesamt(?:betrag|summe)?|total|zu\s*zahlen|endbetrag)\b/i;
const SUBTOTAL = /zwischensumme/i;
const IGNORE = /\b(?:mwst|ust|netto|brutto|steuer|bar|gegeben|r[üu]ckgeld|wechselgeld|karte|kartenzahlung|bankomat|maestro|visa|mastercard|debit|kontaktlos|terminal|tse|kassa|kasse|bon-?nr|beleg|filiale|uid|datum|uhrzeit|danke|kunde|punkte|signatur|seriennummer|trx|transaktion|genehmigung|zahlung)\b/i;
const DISCOUNT = /rabatt|aktion|nachlass|preisvorteil|erm[äa]ßigung|gutschein|coupon|sticker|\bjö\b|bonus|-\s?\d{1,2}\s?%|minus\s?\d{1,2}\s?%|sie sparen|ersparnis/i;
const DEPOSIT_RETURN = /leergut|pfand\s*(?:r[üu]ck|bon|retour)|r[üu]cknahme/i;
const DEPOSIT = /pfand/i;

type Rule = { category: Category; note?: string; pattern: RegExp };
const word = (parts: string) => new RegExp(`(?:^|[^a-zäöüß])(?:${parts})`, "i");

// Order matters: specific non-food rules win over generic food words ("Katzenmilch" is pet food).
export const RECEIPT_RULES: Rule[] = [
  { category: "Haustiere", pattern: word("katzen|hunde|tierfutter|tiernahr|nassfutter|trockenfutter|whiskas|felix\\b|sheba|pedigree|cesar\\b|kitekat|purina|frolic|perfect fit|gourmet gold|katzenstreu|streu\\b|nager|vogelfutter|leckerli") },
  { category: "Guthabenkarten", pattern: word("paysafe|guthaben|google ?play|itunes|apple gift|playstation|psn\\b|xbox|steam\\b|nintendo eshop|wertkarte") },
  { category: "Shopping", note: "Tabak", pattern: word("zigarette|tabak|marlboro|iqos|heets|terea|camel\\b|winston|chesterfield|memphis|feuerzeug|zigarillo") },
  { category: "Gesundheit", pattern: word("aspirin|ibuprofen|paracetamol|parkemed|thomapyrin|pflaster|hansaplast|vitamin|magnesium|zink\\b|nasenspray|halstabl|husten|kondom|durex|schwangerschaftstest|fieberthermo|medikament|tabletten") },
  { category: "Drogerie", pattern: word("zahnp|zahncreme|zahnseide|mundsp|zahnb[üu]rst|zahnb\\b|shampoo|sp[üu]lung\\b|haarsp[üu]l|dusch|seife|deo|nivea|dove\\b|balea|garnier|l'?oreal|rasier|gillette|wilkinson|watte|abschmink|make ?up|mascara|lippen|nagell|tampon|binden|slipeinl|always\\b|windel|pampers|feuchtt|bodylotion|lotion|creme\\b|handcreme|gesichtscreme|sonnenschutz|sonnencreme|haargel|haarspray|haarfarbe|taschent|tempo\\b|klopapier|toilettenpap|wc[- ]?papier|kosmetik|hygiene|labello|axe\\b|rexona|syoss|schauma|colgate|elmex|odol|blend-?a") },
  { category: "Wohnen & Haushalt", pattern: word("sp[üu]lmittel|geschirrsp|sp[üu]ltabs|somat|calgon|waschmittel|waschpulver|weichsp[üu]l|lenor|persil|ariel\\b|frosch\\b|reiniger|putzmittel|wc[- ]?(?:ente|stein)|domestos|schwamm|putztuch|m[üu]llsack|m[üu]llbeutel|m[üu]lls[äa]ck|alufolie|frischhaltef|backpapier|gefrierbeutel|k[üu]chenrolle|haushaltsrolle|zewa|servietten|gl[üu]hbirne|leuchtmittel|batterie|kerze|teelicht|grillkohle|anz[üu]nder|blumenerde|raumduft|febreze|entkalker|klarsp[üu]l|wischtuch") },
  { category: "Shopping", pattern: word("socken|strumpf|t-?shirt|unterhose|ladekabel|usb\\b|kopfh[öo]rer|spielzeug|lego\\b|puzzle|zeitschrift|zeitung|magazin|buch\\b|kalender|schreibwaren|kugelschreiber|heft\\b|geschenkpap|regenschirm") },
  { category: "Geschenke & Spenden", pattern: word("geschenk|blumenstrau|gru[ßs]karte|gl[üu]ckwunschkarte|spende") },
  { category: "Lebensmittel", note: "Alkohol", pattern: word("(?:rot|wei[ßs]|schaum|gl[üu]h|ros[ée])?wein\\b|bier\\b|pils\\b|m[äa]rzen|radler|sekt\\b|prosecco|champagner|vodka|wodka|gin\\b|rum\\b|whiske?y|schnaps|lik[öo]r|j[äa]germeister|aperol|spritzer|cider|cidre|g[öo]sser|ottakringer|stiegl|zipfer|puntigamer|murauer|hirter|heineken|veltliner|zweigelt|blaufr[äa]nkisch|chardonnay|merlot|riesling") },
];

const FOOD = word("milch|joghurt|jogurt|k[äa]se|butter|brot|semmel|weckerl|geb[äa]ck|toast|kipferl|croissant|apfel|[äa]pfel|banane|tomate|paradeis|gurke|salat|kartoffel|erd[äa]pfel|zwiebel|knoblauch|paprika|karotte|m[öo]hre|zucchini|brokkoli|kohl|spinat|pilz|champignon|avocado|zitrone|limette|orange|mandarin|beere|traube|kiwi|mango|pfirsich|birne|melone|ananas|obst|gem[üu]se|nudel|spaghetti|penne|pasta|reis\\b|mehl|zucker|eier|ei\\b|fleisch|huhn|h[üu]hner|hendl|pute|rind|schwein|faschiert|schnitzel|wurst|w[üu]rstel|schinken|speck|salami|leberk[äa]se|fisch|lachs|thunfisch|garnele|tofu|hafer|m[üu]sli|cornflakes|honig|marmelade|konfit|nutella|[öo]l\\b|oliven|essig|pizza|so[ßs]e|sauce|ketchup|senf|mayo|topfen|rahm|obers|sahne|mozzarella|feta\\b|saft|wasser|mineral|v[öo]slauer|r[öo]merquelle|cola\\b|fanta|sprite|limo|eistee|kaffee|espresso|tee\\b|kakao|schoko|chips|n[üu]sse|nuss|mandel|keks|waffel|manner|kuchen|torte|eis\\b|suppe|bohnen|linsen|kichererbs|mais\\b|hummus|aufstrich|vegan|bio\\b|ja!? ?nat|clever|s-?budget|gew[üu]rz|salz\\b|pfeffer|backpulver|hefe|germ\\b|vanille|smoothie|red ?bull|snack|riegel|gummib|haribo|bonbon|kaugummi|tiefk[üu]hl|tk\\b|burger|kebap|wrap\\b|sandwich");

export function classifyReceiptItem(name: string, fallback: Category = "Lebensmittel"): Pick<ReceiptItem, "category" | "note" | "known"> {
  if (DEPOSIT.test(name) || DEPOSIT_RETURN.test(name)) return { category: "Lebensmittel", note: "Pfand", known: true };
  for (const rule of RECEIPT_RULES)
    if (rule.pattern.test(name)) return { category: rule.category, ...(rule.note ? { note: rule.note } : {}), known: true };
  if (FOOD.test(name)) return { category: "Lebensmittel", known: true };
  return { category: fallback, known: false };
}

const hasName = (text: string) => /[a-zäöüß]{3}/i.test(text.replace(/\b(?:kg|eur|stk?|st[üu]ck)\b/gi, ""));

/**
 * Parses OCR'd receipt lines into items. Handles "2 x 1,99" quantity lines, weight lines,
 * Rabatt/Aktion lines (attached to the previous item), Pfand/Leergut and the SUMME line;
 * payment and tax blocks after SUMME are ignored. Only visible numbers are used; nothing is invented.
 */
export function parseReceiptText(text: string, fallback: Category = "Lebensmittel"): ParsedReceipt {
  const lines = text.split(/\r?\n/).slice(0, MAX_LINES).map(normaliseLine).filter(Boolean);
  const items: ReceiptItem[] = [];
  let total: number | undefined;
  let ignoredLines = 0;
  let pendingQuantity: { quantity: number; unitPrice: number } | undefined;
  let pendingName: string | undefined;
  const push = (name: string, amount: number, extra: Partial<ReceiptItem> = {}) => {
    if (items.length >= MAX_ITEMS || amount === 0) return;
    const cleanName = name.replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%)]+$/gu, "").slice(0, 80) || "Artikel";
    items.push({ name: cleanName, amount, ...extra, ...classifyReceiptItem(cleanName, fallback) });
  };
  for (const line of lines) {
    if (total !== undefined) break;
    const priceMatch = PRICE_AT_END.exec(line);
    const price = priceMatch ? money(priceMatch[1]) : null;
    const label = priceMatch ? line.slice(0, priceMatch.index).trim() : line;
    if (TOTAL.test(line) && !SUBTOTAL.test(line)) {
      if (price !== null && price > 0) total = price;
      else ignoredLines++;
      continue;
    }
    if (SUBTOTAL.test(line)) {
      ignoredLines++;
      continue;
    }
    const quantity = QUANTITY.exec(line);
    if (quantity) {
      const count = Number(quantity[2].replace(",", "."));
      const unit = money(quantity[3]);
      const printed = quantity[4] ? money(quantity[4]) : null;
      const name = quantity[1].trim();
      if (unit !== null && count > 0 && count < 1000) {
        const lineTotal = printed ?? euros(Math.round(cents(unit) * count));
        const previous = items.at(-1);
        if (hasName(name)) push(name, lineTotal, { quantity: count, unitPrice: unit });
        else if (pendingName) push(pendingName, lineTotal, { quantity: count, unitPrice: unit });
        else if (previous && previous.quantity === undefined && Math.abs(cents(previous.amount) - cents(lineTotal)) <= 1) {
          previous.quantity = count;
          previous.unitPrice = unit;
        } else pendingQuantity = { quantity: count, unitPrice: unit };
        pendingName = undefined;
        continue;
      }
    }
    if (WEIGHT.test(line)) {
      // "Bananen 0,512 kg x 1,99 EUR/kg 1,02" or a detail line below the article.
      const name = label.replace(/\d+[,.]\d{1,3}\s*kg\b.*$/i, "").trim();
      const priced = price !== null && !/\/\s*kg\s*$/i.test(line);
      if (priced && hasName(name)) push(name, price);
      else if (priced && pendingName) push(pendingName, price);
      else ignoredLines++;
      pendingName = undefined;
      continue;
    }
    if (price === null) {
      // A name without price is followed by its "2 x 1,99  3,98" line on some receipts.
      if (hasName(line) && !IGNORE.test(line) && line.length <= 60) pendingName = line;
      else ignoredLines++;
      continue;
    }
    if (IGNORE.test(label) || !/[a-zäöüß]{2}/i.test(label)) {
      ignoredLines++;
      continue;
    }
    pendingName = undefined;
    if (DEPOSIT_RETURN.test(label)) {
      push(label, -Math.abs(price));
      continue;
    }
    if (DISCOUNT.test(label) && !DEPOSIT.test(label)) {
      const discount = -Math.abs(price);
      const previous = items.at(-1);
      if (previous && previous.amount > 0) {
        previous.discount = euros(cents(previous.discount ?? 0) + cents(discount));
        previous.amount = euros(cents(previous.amount) + cents(discount));
      } else push(label, discount);
      continue;
    }
    if (pendingQuantity) {
      push(label, price, pendingQuantity);
      pendingQuantity = undefined;
      continue;
    }
    push(label, price);
  }
  const itemsTotal = euros(items.reduce((sum, item) => sum + cents(item.amount), 0));
  return {
    items,
    ...(total !== undefined ? { total } : {}),
    itemsTotal,
    totalMatches: total !== undefined && cents(total) === cents(itemsTotal),
    ignoredLines,
  };
}

export type ReceiptCategoryTotal = { category: Category; amount: number; items: number; note?: string };

const groupNote = (note?: string) => (note === "Alkohol" || note === "Tabak" ? note : undefined);

export function receiptCategoryTotals(items: ReceiptItem[]): ReceiptCategoryTotal[] {
  const totals = new Map<string, ReceiptCategoryTotal>();
  for (const item of items) {
    const note = groupNote(item.note);
    const key = `${item.category}|${note ?? ""}`;
    const entry = totals.get(key) ?? { category: item.category, amount: 0, items: 0, ...(note ? { note } : {}) };
    entry.amount = euros(cents(entry.amount) + cents(item.amount));
    entry.items++;
    totals.set(key, entry);
  }
  return [...totals.values()].sort((a, b) => b.amount - a.amount);
}

export type ReceiptSplitPreview = SplitPlan & {
  totals: ReceiptCategoryTotal[];
  /** Receipt total (printed SUMME, else item sum) minus booking amount, both as positive spending. */
  bookingDifference: number;
};

/** Category totals scaled to the booking so the stored split always adds up exactly. */
export function receiptSplitPreview(receipt: Pick<ParsedReceipt, "items" | "total" | "itemsTotal">, bookingAmount: number): ReceiptSplitPreview {
  const totals = receiptCategoryTotals(receipt.items);
  const plan = buildSplits(totals.map((total) => ({ category: total.category, amount: total.amount, note: total.note })), bookingAmount);
  const printed = receipt.total ?? receipt.itemsTotal;
  return { ...plan, totals, bookingDifference: euros(cents(printed) - Math.abs(cents(bookingAmount))) };
}
