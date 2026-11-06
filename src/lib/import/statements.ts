import type { z } from "zod";
import { parseMoneyText as parseStatementAmount } from "@/lib/money-parse";
import { classifyStatementRows, round, savingsPocket } from "@/lib/calc";
import { isRaiffeisenBank, normalizeAccount, RAIFFEISEN_ACCOUNT } from "@/lib/accounts";
import { statementTime } from "@/lib/holidays-at-kaernten";
import {
  dateSchema,
  statementRepairDraftSchema,
  transactionSchema,
  type AppState,
  type PocketSnapshot,
  type Transaction,
} from "@/lib/types";
import { assertImportSize, MAX_STATEMENT_ROWS } from "@/lib/import/limits";
import { amexBookingKey, isAmexScreenshot, numberStatementRows, statementBaseKey, statementFingerprint } from "./identity";
import { hasTerminalText, recoverMerchant, sameTerminalBooking, unresolvedTerminal } from "./merchant-description";
import type { ImportResult } from "./result-schema";
import { isTradeRepublicHeader, parseTradeRepublicRows } from "./trade-republic";
export { statementFingerprint } from "./identity";

export type StatementSource = "Raiffeisen" | "Revolut" | "Amex" | "Trade Republic" | "PDF";
export type StatementDraft = z.infer<typeof statementRepairDraftSchema>;
export type StatementIssue = {
  file: string;
  line?: number;
  message: string;
  draft?: StatementDraft;
  action?: ImportResult["issues"][number]["action"];
  reason?: ImportResult["issues"][number]["reason"];
  evidence?: string;
};
export type StatementResult = {
  source: StatementSource | null;
  file: string;
  rows: Transaction[];
  skipped: number;
  issues: StatementIssue[];
  pocketSnapshots?: PocketSnapshot[];
  accountSnapshots?: AppState["accountSnapshots"];
  amexBalanceSnapshots?: AppState["amexBalanceSnapshots"];
  trBalances?: AppState["trBalances"];
  amexScreenshot?: {
    layout: "grouped" | "list";
    capturedAt: string;
    periodStart?: string;
    balance?: number;
    balanceIncludesPending: boolean;
    card?: string;
    bookingOrder?: string[];
  };
};
export type StatementPreview = {
  rows: Transaction[];
  duplicates: number;
  skipped: number;
  issues: StatementIssue[];
  files: string[];
};

export function admitStatementRepairDrafts<T extends StatementResult>(result: T): T {
  return { ...result, issues: result.issues.map((issue): StatementIssue => {
    const parsed = issue.draft ? statementRepairDraftSchema.safeParse(issue.draft) : undefined;
    const invalid = parsed && !parsed.success;
    const reupload = issue.action === "reupload" || issue.reason !== undefined || invalid;
    const { draft, ...details } = issue;
    const evidence = issue.evidence ?? (draft && reupload ? [
      draft.date, draft.description, draft.pocket,
      draft.amount === null ? "" : String(draft.amount), ...(draft.rawDetails ?? []),
    ].filter(Boolean).join(" · ") : undefined);
    return { ...details, file: issue.file.slice(0, 200), message: issue.message.slice(0, 2000),
      action: reupload || !parsed ? "reupload" : "correct",
      ...(invalid && !issue.reason ? { reason: "invalid-repair-draft" } : {}),
      ...(evidence ? { evidence: evidence.slice(0, 2000) } : {}),
      ...(!reupload && parsed?.success ? { draft: parsed.data } : {}),
    };
  }) };
}
type TableRow = { line: number; cells: string[] };
type Header = {
  date: number;
  time: number;
  description: number;
  details: number[];
  merchants: { index: number; label: string }[];
  amount: number;
  amountColumns: number[];
  incoming: number;
  outgoing: number;
  category: number;
  holder: number;
  currency: number;
  reference: number;
};
const normalized = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
// Some exports lower-case umlauts inside upper-case words ("GEBüHREN FüR").
export const fixUmlautCase = (text: string) => text.replace(/\p{L}+/gu, (word) =>
  /[äöü]/.test(word) && /[A-Z].*[A-Z]/.test(word) && !/[a-z]/.test(word)
    ? word.replace(/[äöü]/g, (letter) => letter.toUpperCase()) : word);
const clean = (text: string) => fixUmlautCase(text.replace(/\s+/g, " ").trim());
const amountHeaders = [
  "betrag",
  "amount",
  "umsatz",
  "geldeinausgezahlt",
  "geldeingezahltausgezahlt",
  "geldausgezahlt-eingezahlt",
];

export { parseStatementAmount };

export function parseStatementDate(raw: string): string | null {
  const text = raw.trim();
  const de = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s.*)?$/);
  const iso = de
    ? `${de[3]}-${de[2].padStart(2, "0")}-${de[1].padStart(2, "0")}`
    : /^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(text)
      ? text.slice(0, 10)
      : "";
  return dateSchema.safeParse(iso).success ? iso : null;
}

function delimiterFor(text: string): string {
  const directive = text.match(/^\uFEFF?sep=([;,\t])/i);
  if (directive) return directive[1];
  const scores = new Map([
    [";", 0],
    [",", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  for (let i = 0; i < Math.min(text.length, 64_000); i++) {
    if (text[i] === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && scores.has(text[i]))
      scores.set(text[i], scores.get(text[i])! + 1);
  }
  return [...scores].sort((a, b) => b[1] - a[1])[0][0];
}

export function readCsv(text: string): TableRow[] {
  const delimiter = delimiterFor(text);
  const rows: TableRow[] = [];
  let cells: string[] = [],
    field = "",
    quoted = false,
    closed = false,
    line = 1,
    startLine = 1;
  const finishCell = () => {
    cells.push(field.trim());
    field = "";
    closed = false;
  };
  const finishRow = () => {
    finishCell();
    rows.push({ line: startLine, cells });
    cells = [];
    if (rows.length > MAX_STATEMENT_ROWS + 5000)
      throw new Error(
        "Die Datei enthält zu viele Zeilen (maximal 100.000 Buchungen).",
      );
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        field += char;
        if (char === "\n") line++;
      }
    } else if (char === '"' && !field.trim() && !closed) {
      field = "";
      quoted = true;
    } else if (char === delimiter) finishCell();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      finishRow();
      line++;
      startLine = line;
    } else {
      if (closed && char.trim())
        throw new Error(`Ungültige CSV-Anführungszeichen in Zeile ${line}.`);
      field += char;
    }
  }
  if (quoted)
    throw new Error(
      `Nicht geschlossene CSV-Anführungszeichen ab Zeile ${startLine}.`,
    );
  if (field || cells.length) finishRow();
  return rows;
}

function headerFor(cells: string[]): Header | null {
  const headers = cells.map(normalized);
  const index = (...names: string[]) =>
    headers.findIndex((name) => names.includes(name));
  const date = index(
    "buchungsdatum",
    "buchungstag",
    "datum",
    "date",
    "transaktionsdatum",
    "transactiondate",
    "starteddate",
    "completeddate",
  );
  let description = index(
    "verwendungszwecktext",
    "verwendungszweck",
    "buchungstext",
    "text",
    "beschreibung",
    "description",
    "umsatzbeschreibung",
    "transaktionsdetails",
  );
  if (description < 0) description = index("zahlungsreferenz");
  const merchants = headers.flatMap((name, index) =>
    /^(?:h(?:ae|a)ndler|merchant)(?:name)?$/.test(name) ? [{ index, label: clean(cells[index]) }] : []);
  const amountColumns = headers.flatMap(
    (name, index) =>
      amountHeaders.includes(name) ||
      (name.startsWith("geld") && name.includes("ein") && name.includes("aus"))
        ? [index] : [],
  );
  const amount = amountColumns[0] ?? -1;
  const incoming = index(
    "geldeingezahlt",
    "eingezahlt",
    "gutschrift",
    "gutschriften",
    "haben",
    "credit",
    "credits",
    "moneyin",
  );
  const outgoing = index(
    "geldausgezahlt",
    "ausgezahlt",
    "belastung",
    "belastungen",
    "soll",
    "debit",
    "debits",
    "moneyout",
  );
  if (
    date < 0 ||
    description < 0 ||
    (amount < 0 && incoming < 0 && outgoing < 0)
  )
    return null;
  return {
    date,
    time: index("uhrzeit", "zeit", "time", "transaktionszeit", "transactiontime"),
    description,
    details: headers.flatMap((name, index) => index !== description &&
      /verwendungszweck|beschreibung|buchungstext|details|zusatz|merchant|h(?:ae|a)ndler|empfaenger|zahlungsempfaenger/.test(name) ? [index] : []),
    merchants,
    amount,
    amountColumns,
    incoming,
    outgoing,
    category: index("kategorie", "category"),
    holder: index(
      "karteninhaber",
      "karteninhaberin",
      "kartenmitglied",
      "cardmember",
      "cardholder",
      "name",
    ),
    currency: index("wahrung", "currency"),
    reference: index(
      "referenz",
      "reference",
      "transactionid",
      "transaktionsid",
      "buchungsreferenz",
      "id",
    ),
  };
}

function isRevolutTaxDetailHeader(cells: string[]): boolean {
  const labels = cells.map(normalized);
  const has = (...names: string[]) => names.every((name) => labels.includes(name));
  // Lot valuations/cost bases are not additional cash movements. Never infer
  // spending or income from unit prices, gross values or capital gains.
  return (has("datumdesverkaufs", "datumdeskaufs", "wertdesverkaufs", "wertdeskaufs", "kapitalertrage") &&
    (labels.includes("unitssold") || labels.includes("verkaufteeinheiten"))) ||
    has("datum", "beschreibungundsymbol", "isin", "anzahl", "bruttowert", "nettowert");
}

// Actual Umsatzliste export: booking date; text; value date; amount; currency; timestamp.
function isRaiffeisenRecord(cells: string[]) {
  return (
    cells.length >= 6 &&
    !!parseStatementDate(cells[0]) &&
    !!cells[1] &&
    !!parseStatementDate(cells[2]) &&
    /^[A-Z]{3}$/.test(cells[4]) &&
    /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}:\d{3}$/.test(cells[5])
  );
}
const raiffeisenHeader: Header = {
  date: 0,
  time: 5,
  description: 1,
  details: [],
  merchants: [],
  amount: 3,
  amountColumns: [3],
  currency: 4,
  incoming: -1,
  outgoing: -1,
  category: -1,
  holder: -1,
  reference: 5,
};

export function detectStatementSource(
  rows: string[][],
): StatementSource | null {
  if (rows.some(isTradeRepublicHeader)) return "Trade Republic";
  const text = rows.map((row) => row.join(" ")).join("\n");
  if (/kontoauszug zu transaktionen/i.test(text)) return "Revolut";
  if (rows.some(isRaiffeisenRecord)) return "Raiffeisen";
  for (const row of rows) {
    if (!headerFor(row)) continue;
    const headers = row.map(normalized);
    if (
      headers.some((h) =>
        /karteninhaber|kartenmitglied|cardmember|cardholder|extendeddetails|appearsonyourstatement/.test(
          h,
        ),
      )
    )
      return "Amex";
    if (headers.some((h) => h.startsWith("geld"))) return "Revolut";
    if (headers.includes("starteddate") && headers.includes("state")) return "Revolut";
    if (
      headers.includes("valuta") &&
      headers.some((h) => /verwendungszweck|buchungstext/.test(h))
    )
      return "Raiffeisen";
  }
  const preamble = rows
    .slice(0, 10)
    .filter((row) => !row.some((cell) => parseStatementDate(cell)))
    .map((row) => row.join(" "))
    .join("\n");
  if (/\brevolut\b/i.test(preamble)) return "Revolut";
  if (/raiffeisen/i.test(preamble)) return "Raiffeisen";
  if (/american\s*express|\bamex\b/i.test(preamble)) return "Amex";
  return null;
}

function parseTables(tables: TableRow[][], file: string): StatementResult {
  const source = detectStatementSource(tables.flat().map((row) => row.cells));
  if (!source)
    throw new Error(
      "Dateityp nicht erkannt. Erwartet werden Raiffeisen-Giro-, Revolut-, American-Express- oder Trade-Republic-Kontoauszüge mit Datum, Beschreibung und Betrag.",
    );
  if (source === "Trade Republic") {
    const table = tables.find((rows) => rows.some((row) => isTradeRepublicHeader(row.cells))) ?? [];
    const parsed = parseTradeRepublicRows(table, file);
    if (!parsed.rows.length && !parsed.skipped)
      throw new Error("Trade-Republic-Export erkannt, aber keine Buchungen gefunden.");
    return admitStatementRepairDrafts({
      source, file, skipped: parsed.skipped, issues: parsed.issues,
      rows: numberStatementRows(classifyStatementRows(parsed.rows)),
      ...(parsed.trBalances ? { trBalances: parsed.trBalances } : {}),
    });
  }
  const result: StatementResult = {
    source,
    file,
    rows: [],
    skipped: 0,
    issues: [],
  };
  const report = (line: number, message: string, draft?: StatementDraft,
    details: Pick<StatementIssue, "action" | "reason" | "evidence"> = {}) => {
    result.skipped++;
    result.issues.push({ file, line, message, ...(draft ? { draft } : {}), ...details });
  };
  for (const table of tables) {
    const hasTransactionBlocks = table.some((row) =>
      /kontoauszug zu transaktionen/i.test(row.cells.join(" ")),
    );
    let active = !hasTransactionBlocks,
      pocket =
        source === "Raiffeisen"
          ? RAIFFEISEN_ACCOUNT
          : source === "Amex"
            ? "AMEX Jannis"
            : "Persönliches Konto";
    let sectionCurrency = "EUR",
      header: Header | null =
        source === "Raiffeisen" &&
        table.some((row) => isRaiffeisenRecord(row.cells))
          ? raiffeisenHeader
          : null;
    let seenTransactionBlock = false;
    let taxDetails = false;
    for (const row of table) {
      const nonempty = row.cells.filter((cell) => cell.trim());
      if (!nonempty.length || /^sep=/i.test(nonempty[0])) continue;
      const lineText = row.cells.join(" ");
      if (source === "Revolut") {
        const section = nonempty[0].match(/^(.+?)\s*\(([A-Z]{3})\)$/);
        if (section) {
          taxDetails = false;
          pocket = clean(section[1]);
          sectionCurrency = section[2];
          active = !hasTransactionBlocks;
          header = null;
          continue;
        }
        if (/kontoauszug zu transaktionen/i.test(lineText)) {
          taxDetails = false;
          active = true;
          seenTransactionBlock = true;
          header = null;
          continue;
        }
        if (isRevolutTaxDetailHeader(row.cells)) {
          taxDetails = true;
          active = false;
          header = null;
          continue;
        }
        if (taxDetails) {
          if (parseStatementDate(nonempty[0])) {
            result.skipped++;
            continue;
          }
          // A new heading/separator ends the known table. Do not hide later
          // unknown layouts just because they follow a tax report.
          taxDetails = false;
        }
        if (
          /saldoübersicht|kontoübersicht|kontodaten|zusammenfassung/i.test(
            nonempty[0],
          ) &&
          !parseStatementDate(nonempty[0])
        ) {
          active = false;
          continue;
        }
      }
      const nextHeader = headerFor(row.cells);
      if (nextHeader) {
        header = nextHeader;
        continue;
      }
      if (/^(datum|date|buchungsdatum)$/i.test(nonempty[0])) {
        header = null;
        continue;
      }
      if (/^(gesamt|summe|total)(?:\s|$)|^[-–—_]{3,}/i.test(nonempty[0])) {
        if (active && header) result.skipped++;
        if (/^[-–—_]{3,}/.test(nonempty[0]) && source === "Revolut") {
          active = false;
          header = null;
        }
        continue;
      }
      let dateText = "",
        time: string | undefined,
        description = "",
        rawDetails: string[] = [],
        amount: number | null = null,
        sourceCategory = "",
        bankReference = "",
        holder = "",
        originalCurrency = "",
        currency = sectionCurrency;
      if (source === "Amex" && nonempty.length === 1) {
        const match = nonempty[0].match(
          /^(\d{1,2}[./]\d{1,2}[./]\d{4})\s+(.+?)\s+([+\-\u2212]?\d[\d.,\s]*[,.]\d{2}-?)\s*(?:EUR|€)?$/,
        );
        if (!match) {
          if (/^\d{1,2}[./]\d{1,2}[./]\d{4}\s/.test(nonempty[0]))
            report(
              row.line,
              "Amex-Textzeile: Beschreibung oder Betrag nicht eindeutig lesbar.",
              {
                id: crypto.randomUUID(),
                date: parseStatementDate(nonempty[0].split(/\s/)[0]) ?? "",
                description: nonempty[0],
                amount: null,
                bank: source,
                pocket,
                category: "Prüfen",
                includeInPlan: false,
              },
            );
          continue;
        }
        dateText = match[1];
        description = clean(match[2]);
        amount = parseStatementAmount(match[3]);
        if (amount !== null) amount = -amount;
      } else {
        if (!header || !active) {
          if (
            (source !== "Revolut" || active || seenTransactionBlock) &&
            parseStatementDate(nonempty[0])
          )
            report(
              row.line,
              "Unbekannter Dateiabschnitt: Buchung bitte zuordnen.",
              {
                id: crypto.randomUUID(),
                date: parseStatementDate(nonempty[0])!,
                description: clean(row.cells.slice(1).join(" ")),
                amount: null,
                bank: source,
                pocket: null,
                category: "Prüfen",
                includeInPlan: false,
              },
            );
          continue;
        }
        const get = (index: number) =>
          index < 0 ? "" : (row.cells[index] ?? "");
        dateText = get(header.date);
        description = clean(get(header.description));
        const reserved = new Set([header.date, header.time, header.description, ...header.amountColumns, header.incoming,
          header.outgoing, header.category, header.holder, header.currency, header.reference]);
        rawDetails = [...new Set([...header.details, ...row.cells.map((_, index) => index).filter((index) =>
          index > header!.description && !reserved.has(index))])]
          .map((index) => clean(get(index))).filter(Boolean).slice(0, 20).map((text) => text.slice(0, 1000));
        // Keep the bank cell values and their merchant-field provenance for later repairs.
        rawDetails = [...header.merchants.flatMap(({ index, label }) =>
          get(index).trim() ? [`${label}: ${clean(get(index))}`.slice(0, 1000)] : []), ...rawDetails].slice(0, 20);
        sourceCategory = clean(get(header.category));
        bankReference = clean(get(header.reference));
        time = statementTime(description, ...rawDetails, get(header.time), dateText);
        holder = get(header.holder);
        currency = get(header.currency) || sectionCurrency;
        if (header.amount >= 0) {
          amount = parseStatementAmount(get(header.amount));
          if (source === "Revolut" && currency.trim().toUpperCase() !== "EUR" &&
            header.amountColumns.length === 2) {
            // Consolidated tax exports repeat the movement header: original
            // currency, then its reported EUR valuation. Balances/fees are not
            // candidates, and an unlabelled/ambiguous amount is never converted.
            const euros = header.amountColumns.filter((index) => /€|\bEUR\b/i.test(get(index)));
            if (euros.length === 1) {
              const euro = parseStatementAmount(get(euros[0]));
              if (euro !== null) {
                const original = header.amountColumns.find((index) => index !== euros[0])!;
                rawDetails = [
                  `Originalbetrag (${currency}): ${get(original)}`.slice(0, 1000),
                  `Eurogegenwert laut Auszug: ${get(euros[0])}`.slice(0, 1000),
                  ...rawDetails,
                ].slice(0, 20);
                amount = euro;
                originalCurrency = currency.trim().toUpperCase();
                currency = "EUR";
              }
            }
          }
          if (amount !== null && source === "Amex") amount = -amount;
        } else {
          const incoming =
            header.incoming < 0 || !get(header.incoming).trim()
              ? 0
              : parseStatementAmount(get(header.incoming));
          const outgoing =
            header.outgoing < 0 || !get(header.outgoing).trim()
              ? 0
              : parseStatementAmount(get(header.outgoing));
          amount =
            incoming === null || outgoing === null
              ? null
              : round(Math.abs(incoming) - Math.abs(outgoing));
        }
      }
      if (amount === 0) {
        result.skipped++;
        continue;
      }
      if (source === "Amex" && amount !== null && amount > 0 && /zahlung\s*\/\s*überweisung erhalten/i.test(description)) {
        result.skipped++;
        continue;
      }
      const date = parseStatementDate(dateText);
      time ??= statementTime(description, dateText);
      const bookingCurrency = originalCurrency || currency.trim().toUpperCase();
      const bookingPocket = bookingCurrency !== "EUR" ? `${pocket} (${bookingCurrency})` : pocket;
      const draft: StatementDraft = {
        id: crypto.randomUUID(),
        date: date ?? "",
        ...(time ? { time } : {}),
        bank: source,
        pocket: bookingPocket,
        description,
        ...(rawDetails.length ? { rawDetails } : {}),
        ...(bankReference ? { bankReference } : {}),
        amount,
        category: "Prüfen",
        includeInPlan: false,
      };
      if (currency.trim().toUpperCase() !== "EUR") {
        report(
          row.line,
          `Fremdwährung ${currency}: nicht als Euro importiert.`,
          draft,
          { action: "reupload", reason: "foreign-currency",
            evidence: `Quellwährung ${currency}: ${row.cells.join(" · ")}`.slice(0, 2000) },
        );
        continue;
      }
      if (!date) {
        report(row.line, "Ungültiges oder fehlendes Buchungsdatum.", draft);
        continue;
      }
      if (amount === null) {
        report(row.line, "Ungültiger oder fehlender Betrag.", draft);
        continue;
      }
      const candidate = transactionSchema.safeParse(recoverMerchant({
        id: crypto.randomUUID(),
        date,
        ...(time ? { time } : {}),
        bank: source,
        pocket:
          source === "Amex" && /\braphael\b/i.test(`${holder} ${description}`)
            ? "AMEX Raphael"
            : bookingPocket,
        description,
        ...(rawDetails.length ? { rawDetails } : {}),
        category: "Prüfen",
        amount,
        includeInPlan: true,
        ...(sourceCategory ? { sourceCategory } : {}),
        ...(bankReference ? { bankReference } : {}),
      }));
      if (!candidate.success) {
        report(
          row.line,
          candidate.error.issues.map((issue) => issue.message).join(", "),
          draft,
        );
        continue;
      }
      result.rows.push(candidate.data);
      if (result.rows.length > MAX_STATEMENT_ROWS)
        throw new Error(
          "Ein Import darf höchstens 100.000 Buchungen enthalten.",
        );
    }
  }
  result.rows = numberStatementRows(classifyStatementRows(result.rows));
  if (source === "Revolut")
    Object.assign(result, readRevolutBalances(tables, file, result.rows));
  if (
    !result.rows.length &&
    !result.skipped &&
    !result.pocketSnapshots?.length &&
    !result.accountSnapshots?.length
  )
    throw new Error(
      "Format erkannt, aber keine lesbaren Transaktionszeilen gefunden. Bitte den vollständigen CSV- oder XLSX-Kontoauszug verwenden.",
    );
  return admitStatementRepairDrafts(result);
}

function readRevolutBalances(
  tables: TableRow[][],
  file: string,
  transactions: Transaction[],
): Pick<StatementResult, "pocketSnapshots" | "accountSnapshots"> {
  const dates = (text: string) =>
    [
      ...text.matchAll(/\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4}/g),
    ].flatMap(([value]) => parseStatementDate(value) ?? []);
  const reportDates = dates(file);
  for (const { cells } of tables.flat())
    if (
      !parseStatementDate(cells[0] ?? "") &&
      /zeitraum|period|\bbis\b|statement date/i.test(cells.join(" "))
    )
      reportDates.push(...dates(cells.join(" ")));
  const statementDate =
    reportDates.sort().at(-1) ??
    transactions
      .map((row) => row.date)
      .sort()
      .at(-1);
  if (!statementDate) return {};
  const accounts = new Map<
    string,
    {
      pocket: PocketSnapshot["pocket"] | null;
      name: string;
      closing?: number;
      last?: { date: string; balance: number };
    }
  >();
  for (const table of tables) {
    let account: ReturnType<typeof accounts.get>;
    let header: Header | null = null;
    let balanceColumn = -1;
    let closingColumn = -1;
    for (const { cells } of table) {
      const first = cells.find((cell) => cell.trim()) ?? "";
      const section = first.match(/^(.+?)\s*\(([A-Z]{3})\)$/);
      if (section) {
        const name = clean(section[1]);
        const pocket = savingsPocket(name);
        account =
          section[2] === "EUR"
            ? (accounts.get(name) ?? { pocket, name })
            : undefined;
        if (account) accounts.set(name, account);
        header = null;
        balanceColumn = closingColumn = -1;
        continue;
      }
      if (!account) continue;
      const labels = cells.map(normalized);
      const closing = labels.indexOf("schlussguthaben");
      if (closing >= 0) {
        const inline = parseStatementAmount(cells[closing + 1] ?? "");
        if (inline !== null) account.closing = inline;
        else closingColumn = closing;
        continue;
      }
      if (closingColumn >= 0) {
        const value = parseStatementAmount(cells[closingColumn] ?? "");
        if (value !== null) account.closing = value;
        closingColumn = -1;
      }
      const nextHeader = headerFor(cells);
      if (nextHeader) {
        header = nextHeader;
        balanceColumn = labels.findIndex(
          (label) => label === "guthaben" || label === "balance",
        );
        continue;
      }
      if (!header || balanceColumn < 0) continue;
      const date = parseStatementDate(cells[header.date] ?? "");
      const balance = parseStatementAmount(cells[balanceColumn] ?? "");
      if (
        date &&
        date <= statementDate &&
        balance !== null &&
        (!account.last || date >= account.last.date)
      )
        account.last = { date, balance };
    }
  }
  const balances = new Map<PocketSnapshot["pocket"], number>();
  const accountSnapshots: NonNullable<AppState["accountSnapshots"]> = [];
  for (const account of accounts.values()) {
    const balance = account.closing ?? account.last?.balance;
    if (balance === undefined) continue;
    accountSnapshots.push({
      name: account.name,
      bank: "Revolut",
      date: statementDate,
      balance,
    });
    if (!account.pocket || account.pocket === "Notgroschen") continue;
    balances.set(
      account.pocket,
      round((balances.get(account.pocket) ?? 0) + balance),
    );
  }
  return {
    accountSnapshots,
    pocketSnapshots: [...balances].map(([pocket, balance]) => ({
      pocket,
      balance,
      date: statementDate,
      bank: "Revolut" as const,
    })),
  };
}

export function parseStatementCsv(
  text: string,
  file = "Kontoauszug.csv",
): StatementResult {
  assertImportSize(new TextEncoder().encode(text).byteLength);
  if (text.trimStart().startsWith("%PDF-"))
    throw new Error(
      "PDF-Dateien bitte als .pdf importieren, nicht als CSV-Text.",
    );
  const normalizedText = text.replace(/^\uFEFF/, "");
  const rows = readCsv(normalizedText);
  if (
    detectStatementSource(rows.map((row) => row.cells)) === "Amex" &&
    !rows.some((row) => headerFor(row.cells))
  ) {
    const delimiter = delimiterFor(normalizedText);
    return parseTables(
      [rows.map((row) => ({ ...row, cells: [row.cells.join(delimiter)] }))],
      file,
    );
  }
  return parseTables([rows], file);
}

function decodeStatement(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export async function parseStatementFile(
  file: Pick<File, "name" | "size" | "arrayBuffer">,
): Promise<StatementResult> {
  assertImportSize(file.size);
  if (!/\.(csv|xlsx|pdf|png|jpe?g|webp)$/i.test(file.name))
    throw new Error(
      "Bitte Kontoauszüge im CSV-, XLSX- oder PDF-Format oder einen Amex-Screenshot (PNG, JPEG, WebP) auswählen.",
    );
  const buffer = await file.arrayBuffer();
  assertImportSize(buffer.byteLength);
  if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
    const { parseAmexScreenshot } = await import("./amex-ocr");
    return parseAmexScreenshot(buffer, file.name);
  }
  if (/\.pdf$/i.test(file.name)) {
    const { parseAmexPdf } = await import("./amex-pdf");
    return parseAmexPdf(buffer, file.name);
  }
  if (/\.csv$/i.test(file.name))
    return parseStatementCsv(decodeStatement(buffer), file.name);
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new Error(
      "Die XLSX-Datei ist beschädigt, verschlüsselt oder kein lesbarer Kontoauszug.",
    );
  }
  if (workbook.getWorksheet("Dashboard") && workbook.getWorksheet("Umsätze"))
    throw new Error(
      "Das ist eine Finanzblick-Sicherung. Dafür bitte Einstellungen → Sicherung verwenden.",
    );
  if (
    workbook.worksheets.length > 50 ||
    workbook.worksheets.some(
      (sheet) =>
        sheet.rowCount > MAX_STATEMENT_ROWS + 5000 || sheet.columnCount > 200,
    )
  )
    throw new Error("Die XLSX-Datei überschreitet die erlaubte Tabellengröße.");
  const tables = workbook.worksheets.map((sheet) => {
    const rows: TableRow[] = [{ line: 0, cells: [sheet.name] }];
    sheet.eachRow((row, line) => {
      const cells: string[] = [];
      for (let i = 1; i <= row.cellCount; i++) {
        let value = row.getCell(i).value;
        if (value && typeof value === "object" && !(value instanceof Date)) {
          if ("result" in value) value = value.result ?? null;
          else if ("richText" in value)
            value = value.richText.map((part) => part.text).join("");
          else if ("text" in value) value = value.text;
          else value = null;
        }
        cells.push(
          value instanceof Date
            ? value.toISOString().slice(0, 10)
            : String(value ?? ""),
        );
      }
      rows.push({ line, cells });
    });
    return rows;
  });
  return parseTables(tables, file.name);
}

export function deduplicateStatements<T extends Transaction>(
  rows: T[],
  existing: Transaction[],
): { rows: T[]; duplicates: number } {
  const numbered = numberStatementRows(existing);
  const seen = new Set(numbered.map(statementFingerprint));
  const amex = new Map<string, Transaction[]>();
  const rememberAmex = (row: Transaction) => {
    const key = amexBookingKey(row);
    if (key) amex.set(key, [...(amex.get(key) ?? []), row]);
  };
  numbered.forEach(rememberAmex);
  // Older Excel/local rows may lack the account or reference that the re-drop
  // now supplies. Match the full original POS text, never just date + amount.
  const terminalKey = (row: Transaction) => statementBaseKey({
    ...row, pocket: isRaiffeisenBank(row.bank) ? row.pocket : null, bankReference: undefined,
  });
  const terminalExisting = new Map<string, Transaction[]>();
  for (const row of numbered) {
    if (!hasTerminalText(row.rawDescription ?? row.description)) continue;
    const key = terminalKey(row);
    const group = terminalExisting.get(key) ?? [];
    group.push(row);
    terminalExisting.set(key, group);
  }
  const unique: T[] = [];
  const positions = new Map<string, number>();
  let duplicates = 0;
  for (const row of numberStatementRows(rows.map(recoverMerchant))) {
    const key = statementFingerprint(row);
    const legacyDuplicate = (terminalExisting.get(terminalKey(row)) ?? []).some((old) =>
      sameTerminalBooking(normalizeAccount(old), normalizeAccount(row)) &&
      ((old.bankReference && row.bankReference) || old.occurrence === row.occurrence));
    const amexKey = amexBookingKey(row);
    const screenshotDuplicate = amexKey !== null && (amex.get(amexKey) ?? []).some((old) =>
      (isAmexScreenshot(old) || isAmexScreenshot(row)) && old.occurrence === row.occurrence);
    if (seen.has(key) || legacyDuplicate || screenshotDuplicate) {
      duplicates++;
      const index = positions.get(key);
      if (index !== undefined && unresolvedTerminal(unique[index].description) && !unresolvedTerminal(row.description))
        unique[index] = row;
    }
    else {
      seen.add(key);
      positions.set(key, unique.length);
      unique.push(row);
      rememberAmex(row);
    }
  }
  return { rows: unique, duplicates };
}

export function prepareStatementPreview(
  results: StatementResult[],
  existing: Transaction[],
): StatementPreview {
  const deduped = deduplicateStatements(
    results.flatMap((result) => result.rows),
    existing,
  );
  return {
    rows: classifyStatementRows(deduped.rows, existing),
    duplicates: deduped.duplicates,
    skipped: results.reduce((total, result) => total + result.skipped, 0),
    issues: results.flatMap((result) => result.issues),
    files: results.map((result) => result.file),
  };
}

export function appendStatementRows(
  state: AppState,
  candidates: Transaction[],
) {
  const parsed = candidates.map((row) => transactionSchema.parse(row));
  const result = deduplicateStatements(parsed, state.transactions);
  if (state.transactions.length + result.rows.length > MAX_STATEMENT_ROWS)
    throw new Error(
      "Der lokale Bestand darf höchstens 100.000 Buchungen enthalten. Bitte weniger Zeilen importieren.",
    );
  return {
    state: { ...state, transactions: [...state.transactions, ...result.rows] },
    added: result.rows.length,
    duplicates: result.duplicates,
  };
}
