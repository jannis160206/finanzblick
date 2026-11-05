import { transactionSchema, type AppState, type Transaction } from "@/lib/types";
import { MAX_STATEMENT_ROWS } from "@/lib/import/limits";

export const TRADE_REPUBLIC_BANK = "Trade Republic";
export const TRADE_REPUBLIC_POCKET = "Verrechnungskonto";

type CsvRow = { line: number; cells: string[] };
type TradeRepublicIssue = { file: string; line?: number; message: string };
export type TradeRepublicResult = {
  rows: Transaction[];
  skipped: number;
  issues: TradeRepublicIssue[];
  trBalances?: NonNullable<AppState["trBalances"]>;
};

const key = (text: string) => text.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const required = ["datetime", "date", "accounttype", "category", "type", "amount", "fee", "tax", "currency", "description", "transactionid"];

/** The "Transaktionsexport" CSV from the Trade Republic app or web. */
export function isTradeRepublicHeader(cells: string[]): boolean {
  const headers = new Set(cells.map(key));
  return required.every((name) => headers.has(name)) && (headers.has("assetclass") || headers.has("mcccode"));
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();
const money = (raw: string): number | null => {
  const text = raw.trim();
  if (!text) return 0;
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  return Number(text);
};
const cents = (value: number) => Math.round(value * 100) / 100;
const euro = (value: number) => `${value.toLocaleString("de-AT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const viennaTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Vienna", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function localTime(datetime: string): string | undefined {
  const instant = Date.parse(datetime);
  if (!Number.isFinite(instant)) return;
  const time = viennaTime.format(instant);
  return /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : undefined;
}
const ownName = (text: string) => /\bjannis\s+br(?:ü|u|ue)hl\b|\bbr(?:ü|u|ue)hl\s+jannis\b/i.test(text);

type Booking = Pick<Transaction, "description" | "amount"> &
  Partial<Pick<Transaction, "rawDetails" | "sourceCategory" | "category">> & { suffix?: string };

function describe(get: (name: string) => string, amount: number, fee: number, tax: number): Booking[] | string {
  const category = get("category").toUpperCase();
  const type = get("type").toUpperCase();
  const description = clean(get("description"));
  const name = clean(get("name"));
  const details: string[] = [];
  const bookings: Booking[] = [];
  if (type.startsWith("TRANSFER")) {
    const inbound = type.includes("INBOUND") || (!type.includes("OUTBOUND") && amount > 0);
    const party = clean(get("counterpartyname")) ||
      /\b(?:from|for|to|von|an)\s+(.+?)(?:\s*\(([A-Z]{2}\d{2}[A-Z0-9]+)\))?$/i.exec(description)?.[1] || "";
    const iban = clean(get("counterpartyiban")) || /\(([A-Z]{2}\d{2}[A-Z0-9]+)\)\s*$/.exec(description)?.[1] || "";
    const reference = clean(get("paymentreference"));
    if (iban) details.push(`IBAN: ${iban}`);
    if (reference) details.push(`Verwendungszweck: ${reference}`);
    if (description) details.push(`Trade Republic: ${description}`);
    if (ownName(`${party} ${description}`))
      bookings.push({ description: `Interne Umbuchung ${inbound ? "von" : "an"} ${party || "eigenes Konto"}`,
        amount: amount + tax, rawDetails: details, sourceCategory: "Transfer intern" });
    else bookings.push({ description: `Überweisung ${inbound ? "von" : "an"} ${party || "unbekannt"}`,
      amount: amount + tax, rawDetails: details });
  } else if (type.startsWith("CARD_TRANSACTION")) {
    const [merchant = "", ...place] = (name || description.split(",")[0]).split("|").map(clean);
    const mcc = get("mcccode").trim();
    if (place.filter(Boolean).length) details.push(`Ort: ${place.filter(Boolean).join(", ")}`);
    if (/^\d{4}$/.test(mcc)) details.push(`MCC: ${mcc}`);
    const original = get("originalamount").trim();
    const originalCurrency = get("originalcurrency").trim().toUpperCase();
    if (original && originalCurrency && originalCurrency !== "EUR")
      details.push(`Originalbetrag (${originalCurrency}): ${original}`, `Wechselkurs: ${get("fxrate").trim()}`);
    if (description) details.push(`Trade Republic: ${description}`);
    const atm = mcc === "6011";
    bookings.push({ description: atm ? `Bargeldbehebung ${merchant}` : merchant, amount: amount + tax, rawDetails: details });
    if (fee) bookings.push({ description: `${atm ? "Bankomatgebühr" : "Bankgebühr Kartenzahlung"} ${merchant}`, amount: fee,
      rawDetails: [`Trade Republic: ${description}`], suffix: "fee" });
    return bookings;
  } else if (type === "INTEREST_PAYMENT") {
    details.push(`Brutto: ${euro(amount)}`);
    if (tax) details.push(`Steuer: ${euro(tax)}`);
    bookings.push({ description: "Zinsgutschrift Trade Republic", amount: amount + tax, rawDetails: details });
  } else if (type === "BENEFITS_SAVEBACK") {
    details.push(`Brutto: ${euro(amount)}`);
    if (tax) details.push(`Steuer: ${euro(tax)}`);
    bookings.push({ description: "Saveback-Prämie Trade Republic", amount: amount + tax, rawDetails: details, category: "Einkommen" });
  } else if (type === "CARD_ORDERING_FEE") {
    bookings.push({ description: `Kartengebühr ${description || "Trade Republic Card"}`, amount: amount + fee + tax });
    return bookings;
  } else if (category === "TRADING" || type === "EARNINGS" || type === "TAX_OPTIMIZATION") {
    const asset = name || clean(get("symbol"));
    const shares = get("shares").trim();
    if (asset) details.push(`Wertpapier: ${asset}`);
    if (get("symbol").trim()) details.push(`ISIN: ${get("symbol").trim()}`);
    if (shares) details.push(`Stück: ${shares}`);
    if (get("price").trim()) details.push(`Kurs: ${get("price").trim()}`);
    if (tax) details.push(`Steuer: ${euro(tax)}`);
    if (description) details.push(`Trade Republic: ${description}`);
    const label = type === "BUY"
      ? /savings plan|sparplan/i.test(description) ? "Sparplan" : "Wertpapierkauf"
      : type === "SELL" ? "Wertpapierverkauf"
        : type === "EARNINGS" ? (/dividend equivalent/i.test(description) ? "Steuerbuchung Dividendenäquivalent" : "Depotertrag")
          : type === "TAX_OPTIMIZATION" ? "Steueroptimierung Depot" : `Depotbuchung ${type.toLowerCase()}`;
    bookings.push({ description: [label, asset].filter(Boolean).join(" "), amount: amount + tax,
      rawDetails: details, sourceCategory: "Transfer intern" });
    if (fee) bookings.push({ description: `Bankgebühr Wertpapierorder ${asset}`.trim(), amount: fee,
      rawDetails: [`Trade Republic: ${description}`], suffix: "fee" });
    return bookings;
  } else {
    if (!description && !name) return `Unbekannter Trade-Republic-Buchungstyp ${type || category}.`;
    if (description) details.push(`Trade Republic: ${description}`);
    bookings.push({ description: name || description, amount: amount + tax, rawDetails: details });
  }
  if (fee) bookings.push({ description: `Bankgebühr ${bookings[0]?.description ?? "Trade Republic"}`, amount: fee,
    rawDetails: [`Trade Republic: ${description}`], suffix: "fee" });
  return bookings;
}

export function parseTradeRepublicRows(rows: CsvRow[], file: string): TradeRepublicResult {
  const headerIndex = rows.findIndex((row) => isTradeRepublicHeader(row.cells));
  const header = rows[headerIndex]?.cells.map(key) ?? [];
  const result: TradeRepublicResult = { rows: [], skipped: 0, issues: [] };
  const report = (line: number, message: string) => {
    result.skipped++;
    result.issues.push({ file, line, message });
  };
  const movements: { date: string; cash: number }[] = [];
  let incomplete = false;
  const body = rows.slice(headerIndex + 1).filter((row) => row.cells.some((cell) => cell.trim()));
  const reversed = reversalPairs(body, header);
  for (const row of body) {
    const get = (name: string) => row.cells[header.indexOf(name)] ?? "";
    const date = get("date").trim();
    const amount = money(get("amount"));
    const fee = money(get("fee"));
    const tax = money(get("tax"));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      incomplete = true;
      report(row.line, "Ungültiges oder fehlendes Buchungsdatum.");
      continue;
    }
    if (amount === null || fee === null || tax === null) {
      incomplete = true;
      report(row.line, "Ungültiger Betrag, Gebühr oder Steuer.");
      continue;
    }
    if ((get("currency").trim().toUpperCase() || "EUR") !== "EUR") {
      incomplete = true;
      report(row.line, `Fremdwährung ${get("currency").trim()}: nicht als Euro importiert.`);
      continue;
    }
    if (reversed.has(row.line)) {
      result.skipped++;
      continue;
    }
    movements.push({ date, cash: amount + fee + tax });
    const bookings = describe(get, amount, fee, tax);
    if (typeof bookings === "string") {
      incomplete = true;
      report(row.line, bookings);
      continue;
    }
    const reference = clean(get("transactionid"));
    const time = localTime(get("datetime"));
    let added = false;
    for (const booking of bookings) {
      const value = cents(booking.amount);
      if (!value) continue;
      const candidate = transactionSchema.safeParse({
        id: crypto.randomUUID(),
        date,
        ...(time ? { time } : {}),
        bank: TRADE_REPUBLIC_BANK,
        pocket: TRADE_REPUBLIC_POCKET,
        description: booking.description.slice(0, 1000),
        ...(booking.rawDetails?.length ? { rawDetails: booking.rawDetails.slice(0, 20).map((text) => text.slice(0, 1000)) } : {}),
        category: booking.category ?? "Prüfen",
        amount: value,
        includeInPlan: true,
        ...(booking.sourceCategory ? { sourceCategory: booking.sourceCategory } : {}),
        ...(reference ? { bankReference: booking.suffix ? `${reference}:${booking.suffix}` : reference } : {}),
      });
      if (!candidate.success) {
        incomplete = true;
        report(row.line, candidate.error.issues.map((issue) => issue.message).join(", "));
        continue;
      }
      result.rows.push(candidate.data);
      added = true;
      if (result.rows.length > MAX_STATEMENT_ROWS)
        throw new Error("Ein Import darf höchstens 100.000 Buchungen enthalten.");
    }
    if (!added) result.skipped++;
  }
  const balance = cashBalance(movements);
  if (!incomplete && balance) result.trBalances = [balance];
  return result;
}

// Trade Republic books a cancelled card authorisation or tax charge as a second
// row with the opposite cash effect. Both rows net to zero and are not bookings.
function reversalPairs(rows: CsvRow[], header: string[]): Set<number> {
  const field = (row: CsvRow, name: string) => (row.cells[header.indexOf(name)] ?? "").trim();
  const cash = (row: CsvRow) => {
    const parts = ["amount", "fee", "tax"].map((name) => money(field(row, name)));
    return parts.some((part) => part === null) ? null : cents(parts.reduce<number>((sum, part) => sum + part!, 0));
  };
  const identity = (row: CsvRow) => [field(row, "type"), field(row, "name") || field(row, "description"), field(row, "symbol")].join("|");
  const ordered = [...rows].sort((a, b) => field(a, "datetime").localeCompare(field(b, "datetime")));
  const open = new Map<string, CsvRow[]>();
  const pairs = new Set<number>();
  for (const row of ordered) {
    const value = cash(row);
    if (!value) continue;
    const counterpart = open.get(`${identity(row)}|${-value}`)?.find((item) =>
      Math.abs(Date.parse(field(item, "date")) - Date.parse(field(row, "date"))) <= 7 * 86_400_000);
    if (counterpart) {
      pairs.add(counterpart.line).add(row.line);
      const list = open.get(`${identity(row)}|${-value}`)!;
      list.splice(list.indexOf(counterpart), 1);
      continue;
    }
    const own = `${identity(row)}|${value}`;
    open.set(own, [...(open.get(own) ?? []), row]);
  }
  return pairs;
}

// The export holds the full cash history, so the sum of all cash effects is the
// account balance. Trade Republic may briefly debit taxes below zero, so only
// the final balance has to be valid.
function cashBalance(movements: { date: string; cash: number }[]) {
  if (!movements.length) return;
  const balance = cents(movements.reduce((sum, movement) => sum + movement.cash, 0));
  if (balance < 0) return;
  return { date: movements.map((item) => item.date).sort().at(-1)!, balance };
}
