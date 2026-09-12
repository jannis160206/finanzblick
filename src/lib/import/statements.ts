import { classifyStatementRows, round, savingsPocket } from "@/lib/calc";
import {
  dateSchema,
  transactionSchema,
  type AppState,
  type PocketSnapshot,
  type Transaction,
} from "@/lib/types";
import { assertImportSize, MAX_STATEMENT_ROWS } from "@/lib/import/limits";

export type StatementSource = "Raiffeisen" | "Revolut" | "Amex";
export type StatementDraft = Omit<Transaction, "amount"> & {
  amount: number | null;
};
export type StatementIssue = {
  file: string;
  line?: number;
  message: string;
  draft?: StatementDraft;
};
export type StatementResult = {
  source: StatementSource | null;
  file: string;
  rows: Transaction[];
  skipped: number;
  issues: StatementIssue[];
  pocketSnapshots?: PocketSnapshot[];
};
export type StatementPreview = {
  rows: Transaction[];
  duplicates: number;
  skipped: number;
  issues: StatementIssue[];
  files: string[];
};
type TableRow = { line: number; cells: string[] };
type Header = {
  date: number;
  description: number;
  amount: number;
  incoming: number;
  outgoing: number;
  category: number;
  holder: number;
  currency: number;
};
const normalized = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const clean = (text: string) => text.replace(/\s+/g, " ").trim();
const amountHeaders = [
  "betrag",
  "amount",
  "umsatz",
  "geldeinausgezahlt",
  "geldeingezahltausgezahlt",
  "geldausgezahlt-eingezahlt",
];

export function parseStatementAmount(raw: string | number): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? round(raw) : null;
  let text = raw
    .trim()
    .replace(/\u2212/g, "-")
    .replace(/(?:EUR|€)/gi, "")
    .replace(/[\s\u00a0']/g, "");
  if (!text || !/^[+\-]?(?:\d[\d.,]*\d|\d)[-]?$|^\(\d[\d.,]*\)$/.test(text))
    return null;
  let sign = 1;
  if (text.startsWith("(") && text.endsWith(")")) {
    sign = -1;
    text = text.slice(1, -1);
  }
  if (text.endsWith("-")) {
    sign = -1;
    text = text.slice(0, -1);
  }
  if (text.startsWith("-")) {
    sign *= -1;
    text = text.slice(1);
  }
  text = text.replace(/^\+/, "");
  if (text.includes(",")) {
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(text)) return null;
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
  else if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const value = Number(text) * sign;
  return Number.isFinite(value) && Math.abs(value) <= 1_000_000_000
    ? round(value)
    : null;
}

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

function readCsv(text: string): TableRow[] {
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
  );
  const description = index(
    "verwendungszwecktext",
    "verwendungszweck",
    "buchungstext",
    "text",
    "beschreibung",
    "description",
    "umsatzbeschreibung",
    "transaktionsdetails",
  );
  const amount = headers.findIndex(
    (name) =>
      amountHeaders.includes(name) ||
      (name.startsWith("geld") && name.includes("ein") && name.includes("aus")),
  );
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
    description,
    amount,
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
  };
}

// Actual Umsatzliste export: booking date; text; value date; amount; currency; timestamp.
function isRaiffeisenRecord(cells: string[]) {
  return (
    cells.length === 6 &&
    !!parseStatementDate(cells[0]) &&
    !!cells[1] &&
    !!parseStatementDate(cells[2]) &&
    /^[A-Z]{3}$/.test(cells[4]) &&
    /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}:\d{3}$/.test(cells[5])
  );
}
const raiffeisenHeader: Header = {
  date: 0,
  description: 1,
  amount: 3,
  currency: 4,
  incoming: -1,
  outgoing: -1,
  category: -1,
  holder: -1,
};

export function detectStatementSource(
  rows: string[][],
): StatementSource | null {
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
      "Dateityp nicht erkannt. Erwartet werden Raiffeisen-Giro-, Revolut- oder American-Express-Kontoauszüge mit Datum, Beschreibung und Betrag.",
    );
  const result: StatementResult = {
    source,
    file,
    rows: [],
    skipped: 0,
    issues: [],
  };
  const report = (line: number, message: string, draft?: StatementDraft) => {
    result.skipped++;
    result.issues.push({ file, line, message, ...(draft ? { draft } : {}) });
  };
  for (const table of tables) {
    const hasTransactionBlocks = table.some((row) =>
      /kontoauszug zu transaktionen/i.test(row.cells.join(" ")),
    );
    let active = !hasTransactionBlocks,
      pocket =
        source === "Raiffeisen"
          ? "Raiffeisen Giro"
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
    for (const row of table) {
      const nonempty = row.cells.filter((cell) => cell.trim());
      if (!nonempty.length || /^sep=/i.test(nonempty[0])) continue;
      const lineText = row.cells.join(" ");
      if (source === "Revolut") {
        const section = nonempty[0].match(/^(.+?)\s*\(([A-Z]{3})\)$/);
        if (section) {
          pocket = clean(section[1]);
          sectionCurrency = section[2];
          active = !hasTransactionBlocks;
          header = null;
          continue;
        }
        if (/kontoauszug zu transaktionen/i.test(lineText)) {
          active = true;
          seenTransactionBlock = true;
          header = null;
          continue;
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
        description = "",
        amount: number | null = null,
        sourceCategory = "",
        holder = "",
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
        sourceCategory = clean(get(header.category));
        holder = get(header.holder);
        currency = get(header.currency) || sectionCurrency;
        if (header.amount >= 0) {
          amount = parseStatementAmount(get(header.amount));
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
      const date = parseStatementDate(dateText);
      const draft: StatementDraft = {
        id: crypto.randomUUID(),
        date: date ?? "",
        bank: source,
        pocket,
        description,
        amount,
        category: "Prüfen",
        includeInPlan: false,
      };
      if (currency.trim().toUpperCase() !== "EUR") {
        report(
          row.line,
          `Fremdwährung ${currency}: nicht als Euro importiert.`,
          { ...draft, amount: null },
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
      const candidate = transactionSchema.safeParse({
        id: crypto.randomUUID(),
        date,
        bank: source,
        pocket:
          source === "Amex" && /\braphael\b/i.test(`${holder} ${description}`)
            ? "AMEX Raphael"
            : pocket,
        description,
        category: "Prüfen",
        amount,
        includeInPlan: true,
        ...(sourceCategory ? { sourceCategory } : {}),
      });
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
  result.rows = classifyStatementRows(result.rows);
  if (source === "Revolut")
    result.pocketSnapshots = readRevolutBalances(tables, file, result.rows);
  if (!result.rows.length && !result.skipped && !result.pocketSnapshots?.length)
    throw new Error(
      "Format erkannt, aber keine lesbaren Transaktionszeilen gefunden. Bitte den vollständigen CSV- oder XLSX-Kontoauszug verwenden.",
    );
  return result;
}

function readRevolutBalances(
  tables: TableRow[][],
  file: string,
  transactions: Transaction[],
): PocketSnapshot[] {
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
  if (!statementDate) return [];
  const accounts = new Map<
    string,
    {
      pocket: PocketSnapshot["pocket"];
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
        const eligible =
          /^(sparen|sparkonto|urlaub(?: 2026)?|notgroschen|motorrad)$/i.test(
            name,
          );
        account =
          section[2] === "EUR" && eligible && pocket
            ? (accounts.get(normalized(name)) ?? { pocket })
            : undefined;
        if (account) accounts.set(normalized(name), account);
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
  for (const account of accounts.values()) {
    const balance = account.closing ?? account.last?.balance;
    if (balance === undefined) continue;
    if (
      account.pocket === "Notgroschen" &&
      !transactions.some(
        (row) =>
          savingsPocket(row.pocket) === "Notgroschen" && row.amount !== 0,
      )
    )
      continue;
    balances.set(
      account.pocket,
      round((balances.get(account.pocket) ?? 0) + balance),
    );
  }
  return [...balances].map(([pocket, balance]) => ({
    pocket,
    balance,
    date: statementDate,
    bank: "Revolut",
  }));
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
  if (!/\.(csv|xlsx|pdf)$/i.test(file.name))
    throw new Error(
      "Bitte Kontoauszüge im CSV-, XLSX- oder PDF-Format auswählen.",
    );
  const buffer = await file.arrayBuffer();
  assertImportSize(buffer.byteLength);
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
      "Das ist eine Finanzblick-Sicherung. Dafür bitte den bestehenden Excel-Import in der Kopfzeile verwenden.",
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

export function statementFingerprint(
  row: Pick<Transaction, "date" | "bank" | "amount" | "description">,
): string {
  const bank = clean(row.bank)
    .toLowerCase()
    .replace(/^american express$/, "amex");
  return JSON.stringify([
    row.date.slice(0, 10),
    bank,
    round(row.amount).toFixed(2),
    clean(row.description).slice(0, 25).toLowerCase(),
  ]);
}

export function deduplicateStatements<T extends Transaction>(
  rows: T[],
  existing: Transaction[],
): { rows: T[]; duplicates: number } {
  const seen = new Set(existing.map(statementFingerprint));
  const unique: T[] = [];
  let duplicates = 0;
  for (const row of rows) {
    const key = statementFingerprint(row);
    if (seen.has(key)) duplicates++;
    else {
      seen.add(key);
      unique.push(row);
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
