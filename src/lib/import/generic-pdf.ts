import { recoverMerchant } from "./merchant-description";
import { numberStatementRows } from "./identity";
import { classifyStatementRows } from "@/lib/calc";
import { transactionSchema, type Transaction } from "@/lib/types";
import type { StatementDraft, StatementIssue, StatementResult } from "./statements";

/** One booking candidate as returned by an (AI) extractor; validated by code before use. */
export type PdfExtractedRow = { date: string; amount: number; description: string };
export type PdfExtractor = (input: {
  chunk: string;
  bank: string;
  period?: { from: string; to: string };
  signal?: AbortSignal;
}) => Promise<PdfExtractedRow[]>;

export type GenericPdfOptions = {
  /** Optional model-backed extractor; only used when the deterministic parser is not sufficient. */
  extract?: PdfExtractor;
  /** Epoch ms after which no further AI chunk is started. */
  deadline?: number;
  now?: () => number;
  signal?: AbortSignal;
};

type AmountToken = { value: number; explicit: -1 | 0 | 1 };
type Candidate = {
  line: number;
  date: string;
  description: string;
  amount?: AmountToken;
  balance?: AmountToken;
};

const MONTHS: Record<string, number> = {
  jan: 1, januar: 1, january: 1, jän: 1, jänner: 1, feb: 2, februar: 2, february: 2, mär: 3, mar: 3, märz: 3, march: 3, apr: 4, april: 4,
  mai: 5, may: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10, nov: 11, november: 11, dez: 12, dec: 12, dezember: 12, december: 12,
};
const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const NUMERIC_DATE = /(?<![\d.,])(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2})(?!\d)|\.?(?=\s|$))/;
const WORD_DATE = new RegExp(`(?<![\\p{L}\\d])(\\d{1,2})\\.?\\s(${MONTH_NAMES})\\.?\\s(\\d{4})(?!\\d)|(?<![\\p{L}\\d])(${MONTH_NAMES})\\.?\\s(\\d{1,2}),?\\s(\\d{4})(?!\\d)`, "iu");
const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/;
const AMOUNT_END = /(?:^|\s)([+\-\u2212]?\s?(?:€|EUR)?\s?\d{1,3}(?:[.,'\u202f]\d{3})*[.,]\d{2}(?:\s?(?:€|EUR))?(?:\s?-|\s[SH])?)\s*$/i;
const OPENING = /alter\s+(?:konto)?stand|alter\s+saldo|anfangssaldo|saldo\s+alt|saldovortrag|kontostand\s+alt|opening\s+balance|startsaldo|anfangsbestand|kontostand\s+vom/i;
const CLOSING = /neuer\s+(?:konto)?stand|neuer\s+saldo|endsaldo|saldo\s+neu|kontostand\s+neu|closing\s+balance|endbestand|schlusssaldo/i;
const NOT_A_BOOKING = /saldo|kontostand|übertrag|uebertrag|zwischensumme|\bsumme\b|opening balance|closing balance|gesamt(?:umsatz|betrag|summe)|\btotal\b|kreditrahmen|verfügbar|überziehungsrahmen|zinssatz/i;
const PAGE_NOISE = /^(?:seite|page)\s+\d+|\b(?:iban|bic|blz)\b|\bzeitraum\b|^(?:auszug\s+|kontoauszug\s+)?(?:vom|von|from)\s+\d|\bperiod\b|^(?:buchungs?datum|datum|valuta|wertstellung|value date|date)\s+(?:text|beschreibung|buchungstext|description|valuta|betrag|verwendungszweck)|kontoauszug\s+(?:nr|nummer)|erstellt am|^(?:betrag|amount|description)$/i;
const VALUE_DATE_LABEL = /^(?:wertstellung|valuta|value date|buchungsdatum|booking date|datum)\s*:?\s*/i;
const AMOUNT_LABEL = /^(?:betrag|amount)\s*:?\s*/i;
const INCOME_WORDS = /gutschrift|gehalt|lohn|bezug|eingang|r[üu]ckerstattung|erstattung|zinsen\s+haben|überweisung\s+von|refund|salary|incoming|money in|einzahlung/i;
const pad = (value: number) => String(value).padStart(2, "0");

function validDate(year: number, month: number, day: number): string | null {
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  return new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

type DateHit = { index: number; length: number; day: number; month: number; year?: number };

function findDates(line: string): DateHit[] {
  const hits: DateHit[] = [];
  const scan = (pattern: RegExp, read: (match: RegExpExecArray) => Omit<DateHit, "index" | "length"> | null) => {
    const global = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
    for (const match of line.matchAll(global)) {
      const value = read(match as RegExpExecArray);
      if (value) hits.push({ index: match.index ?? 0, length: match[0].length, ...value });
    }
  };
  scan(NUMERIC_DATE, (match) => {
    const year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : undefined;
    return { day: Number(match[1]), month: Number(match[2]), ...(year ? { year } : {}) };
  });
  scan(WORD_DATE, (match) => {
    const month = MONTHS[(match[2] ?? match[4]).toLowerCase()];
    return month ? { day: Number(match[1] ?? match[5]), month, year: Number(match[3] ?? match[6]) } : null;
  });
  scan(ISO_DATE, (match) => ({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }));
  return hits.filter((hit) => hit.month >= 1 && hit.month <= 12 && hit.day >= 1 && hit.day <= 31).sort((a, b) => a.index - b.index);
}

function parseAmountToken(token: string): AmountToken | null {
  let text = token.replace(/\u2212/g, "-").replace(/\s+/g, " ").trim();
  let explicit: AmountToken["explicit"] = 0;
  if (/\sS$/i.test(text) || /-$/.test(text) || /^-/.test(text)) explicit = -1;
  else if (/\sH$/i.test(text) || /^\+/.test(text)) explicit = 1;
  text = text.replace(/\s[SH]$/i, "").replace(/(?:€|EUR)/gi, "").replace(/[\s+\-']/g, "").replace(/\u202f/g, "");
  const decimal = text.at(-3);
  if (decimal !== "," && decimal !== ".") return null;
  const integer = text.slice(0, -3).replace(/[.,]/g, "");
  const value = Number(`${integer}.${text.slice(-2)}`);
  return Number.isFinite(value) && value < 1e9 ? { value: Math.round(value * 100) / 100, explicit } : null;
}

function trailingAmounts(line: string): { rest: string; amounts: AmountToken[] } {
  const amounts: AmountToken[] = [];
  let rest = line;
  for (let index = 0; index < 2; index++) {
    const match = AMOUNT_END.exec(rest);
    const amount = match && parseAmountToken(match[1]);
    if (!match || !amount) break;
    amounts.unshift(amount);
    rest = rest.slice(0, match.index).trimEnd();
  }
  return { rest, amounts };
}

const signed = (token: AmountToken) => (token.explicit === -1 ? -token.value : token.value);

export function detectPdfBank(text: string): string {
  const banks: [RegExp, string][] = [
    [/\berste\s*bank|\bgeorge\b|\bsparkasse\b|giblatwwxxx/i, "Erste Bank"],
    [/raiffeisen|rzbaatww|\braiba\b/i, "Raiffeisen"],
    [/\bbawag\b|easybank|bawaatww/i, "BAWAG"],
    [/bank\s*austria|unicredit|bkauatww/i, "Bank Austria"],
    [/\bn26\b|ntsbdeb1/i, "N26"],
    [/revolut/i, "Revolut"],
    [/\bdkb\b|deutsche\s*kreditbank|byladem1001/i, "DKB"],
    [/volksbank|vbwien|vboeatww/i, "Volksbank"],
    [/hypo\b|oberbank|bks\s*bank|bank99|dadat/i, "Bank"],
  ];
  return banks.find(([pattern]) => pattern.test(text))?.[1] ?? "PDF-Import";
}

function fullDates(text: string): string[] {
  return findDates(text).flatMap((hit) => (hit.year ? [validDate(hit.year, hit.month, hit.day)] : [])).filter((date): date is string => !!date);
}

export function statementPeriod(lines: string[]): { from: string; to: string } | undefined {
  for (const line of lines.slice(0, 80)) {
    if (!/zeitraum|period|vom|von|from|bis|–|-/i.test(line)) continue;
    const dates = fullDates(line);
    if (dates.length >= 2 && /zeitraum|period|vom|von|from|bis|to|–|\s-\s/i.test(line) && dates[1] >= dates[0] && !NOT_A_BOOKING.test(line))
      return { from: dates[0], to: dates[1] };
  }
  return undefined;
}

export function statementBalances(lines: string[]): { opening?: number; closing?: number } {
  const result: { opening?: number; closing?: number } = {};
  for (const line of lines) {
    const { amounts } = trailingAmounts(line);
    const amount = amounts.at(-1);
    if (!amount) continue;
    if (result.opening === undefined && OPENING.test(line)) result.opening = signed(amount);
    else if (CLOSING.test(line)) result.closing = signed(amount);
  }
  return result;
}

function shiftDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Deterministic line parser for text PDFs: date + text + amount (+ optional balance) per booking. */
export function parsePdfLines(lines: string[], reference?: string): { candidates: Candidate[]; unparsed: number[] } {
  const candidates: Candidate[] = [];
  const unparsed: number[] = [];
  let pending: Candidate | undefined;
  let orphan: { line: number; description: string; amounts: AmountToken[]; age: number } | undefined;
  let continuation = 0;
  let loose: { line: number; text: string; target?: Candidate } | undefined;
  let lastLine = -1;
  const resolveDate = (hit: DateHit) => {
    if (hit.year) return validDate(hit.year, hit.month, hit.day);
    if (!reference) return null;
    const [refYear, refMonth] = reference.split("-").map(Number);
    return validDate(hit.month > refMonth ? refYear - 1 : refYear, hit.month, hit.day);
  };
  const close = () => {
    if (pending && !pending.amount) unparsed.push(pending.line);
    pending = undefined;
  };
  lines.forEach((raw, line) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return;
    if (orphan && ++orphan.age > 3) {
      if (candidates.length) unparsed.push(orphan.line);
      orphan = undefined;
    }
    if (NOT_A_BOOKING.test(text) || OPENING.test(text) || CLOSING.test(text) || PAGE_NOISE.test(text)) {
      close();
      continuation = 0;
      return;
    }
    const { rest, amounts } = trailingAmounts(text);
    const dates = findDates(rest);
    const first = dates[0];
    const date = first ? resolveDate(first) : null;
    if (first && !date) {
      unparsed.push(line);
      return;
    }
    const withoutDates = dates.reduceRight((value, hit) => `${value.slice(0, hit.index)} ${value.slice(hit.index + hit.length)}`, rest)
      .replace(VALUE_DATE_LABEL, "").replace(/\s+/g, " ").trim();
    const previousLoose = loose && loose.line === lastLine ? loose : undefined;
    lastLine = line;
    loose = undefined;
    if (date && amounts.length) {
      close();
      let description = withoutDates || orphan?.description || "";
      if (!description && previousLoose) {
        // Layouts with the merchant on its own line above "date … amount".
        description = previousLoose.text;
        if (previousLoose.target)
          previousLoose.target.description = previousLoose.target.description.slice(0, -previousLoose.text.length).trim();
      }
      candidates.push({ line, date, description, amount: amounts[0], ...(amounts[1] ? { balance: amounts[1] } : {}) });
      orphan = undefined;
      continuation = 0;
      return;
    }
    if (date) {
      if (orphan && (!withoutDates || VALUE_DATE_LABEL.test(rest))) {
        // N26-style: "Text  -54,30" first, the date ("Wertstellung 02.09.2026") follows.
        candidates.push({ line: orphan.line, date, description: orphan.description, amount: orphan.amounts[0], ...(orphan.amounts[1] ? { balance: orphan.amounts[1] } : {}) });
        orphan = undefined;
        continuation = 0;
        return;
      }
      if (VALUE_DATE_LABEL.test(rest)) return;
      close();
      pending = { line, date, description: withoutDates };
      continuation = 0;
      return;
    }
    if (amounts.length) {
      const label = rest.replace(AMOUNT_LABEL, "").trim();
      if (pending && !pending.amount) {
        pending.description = `${pending.description} ${label}`.trim();
        pending.amount = amounts[0];
        if (amounts[1]) pending.balance = amounts[1];
        candidates.push(pending);
        pending = undefined;
      } else if (label && /\p{L}{2}/u.test(label)) orphan = { line, description: label, amounts, age: 0 };
      continuation = 0;
      return;
    }
    // Wrapped booking text belongs to the booking above.
    const target = pending ?? candidates.at(-1);
    if (text.length <= 140 && /\p{L}{2}/u.test(text)) loose = { line, text, ...(target && continuation < 3 ? { target } : {}) };
    if (target && continuation < 3 && text.length <= 140 && /\p{L}{2}/u.test(text)) {
      target.description = `${target.description} ${text}`.trim().slice(0, 300);
      continuation++;
    }
  });
  close();
  if (orphan && candidates.length) unparsed.push(orphan.line);
  return { candidates, unparsed };
}

function chunks(lines: string[], focus: Set<number> | undefined, size = 3200): { text: string; lines: number[] }[] {
  const result: { text: string; lines: number[] }[] = [];
  let current: string[] = [];
  let indexes: number[] = [];
  const flush = () => {
    if (current.length && (!focus || indexes.some((index) => focus.has(index))) && current.some((line) => AMOUNT_END.test(line)))
      result.push({ text: current.join("\n"), lines: indexes });
    current = [];
    indexes = [];
  };
  lines.forEach((line, index) => {
    const clean = line.replace(/\s+/g, " ").trim().slice(0, 240);
    if (!clean) return;
    if (current.join("\n").length + clean.length > size) flush();
    current.push(clean);
    indexes.push(index);
  });
  flush();
  return result;
}

const amountTexts = (value: number) => {
  const fixed = Math.abs(value).toFixed(2);
  const [integer, decimals] = fixed.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const groupedEn = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return [`${integer},${decimals}`, `${grouped},${decimals}`, `${integer}.${decimals}`, `${groupedEn}.${decimals}`];
};

/**
 * Validates one model-extracted row against the chunk it came from: the amount and date must be
 * printed there, the text must reuse words from it, and the date must fall into the statement period.
 */
export function groundAiRow(row: PdfExtractedRow, chunk: string, period?: { from: string; to: string }): PdfExtractedRow | null {
  if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  const [year, month, day] = row.date.split("-").map(Number);
  if (!validDate(year, month, day)) return null;
  if (period && (row.date < shiftDays(period.from, -3) || row.date > shiftDays(period.to, 3))) return null;
  const amount = typeof row.amount === "number" ? row.amount : Number(String(row.amount).replace(",", "."));
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) >= 1e7) return null;
  const rounded = Math.round(amount * 100) / 100;
  const compact = chunk.replace(/[\u202f']/g, "");
  const found = amountTexts(rounded).map((text) => compact.search(new RegExp(`(?<![\\d.,])${text.replace(/[.]/g, "\\.")}(?![\\d])`))).find((index) => index >= 0);
  if (found === undefined) return null;
  const dayMonth = new RegExp(`(?<!\\d)0?${day}\\.0?${month}\\.|${row.date}|(?<!\\d)0?${day}\\.?\\s(?:${Object.entries(MONTHS).filter(([, value]) => value === month).map(([name]) => name).join("|")})`, "i");
  if (!dayMonth.test(chunk)) return null;
  const description = String(row.description ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const words = description.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  const lowerChunk = chunk.toLowerCase();
  if (!words.length || !words.some((word) => lowerChunk.includes(word))) return null;
  // A printed minus/S next to the amount wins over the model's sign.
  const context = compact.slice(Math.max(0, found - 2), found + amountTexts(rounded)[0].length + 10);
  const after = compact.slice(found).replace(/^[\d.,]+/, "");
  const explicitNegative = /-\s?\d|\d-/.test(context) || /^\s?(?:€|EUR)?\s?(?:S\b|Soll\b)/i.test(after);
  const explicitPositive = /\+\s?\d/.test(context) || /^\s?(?:€|EUR)?\s?(?:H\b|\(?Haben\b)/i.test(after);
  const value = explicitNegative ? -Math.abs(rounded) : explicitPositive ? Math.abs(rounded) : rounded;
  return { date: row.date, amount: value, description };
}

export async function parseGenericPdfText(pages: string[], file: string, options: GenericPdfOptions = {}): Promise<StatementResult> {
  const now = options.now ?? Date.now;
  const lines = pages.join("\n").split("\n");
  const text = lines.join("\n");
  const bank = detectPdfBank(text);
  const result: StatementResult = { source: "PDF", file, rows: [], skipped: 0, issues: [] };
  if (!text.trim()) {
    result.source = null;
    result.skipped = 1;
    result.issues.push({ file, message: "PDF enthält keinen Text (vermutlich ein Scan). Bitte CSV-Export oder Screenshots verwenden." });
    return result;
  }
  const period = statementPeriod(lines);
  const reference = period?.to ?? fullDates(text).sort().at(-1);
  const balances = statementBalances(lines);
  const { candidates, unparsed } = parsePdfLines(lines, reference);
  const explicitSigns = candidates.some((candidate) => candidate.amount?.explicit === -1);
  let previousBalance = balances.opening;
  const deterministic: (PdfExtractedRow & { line: number; uncertain: boolean })[] = [];
  for (const candidate of candidates) {
    const token = candidate.amount!;
    let amount: number;
    let uncertain = false;
    if (token.explicit) amount = signed(token);
    else if (candidate.balance && previousBalance !== undefined &&
      Math.abs(Math.abs(signed(candidate.balance) - previousBalance) - token.value) < 0.005)
      amount = signed(candidate.balance) - previousBalance >= 0 ? token.value : -token.value;
    else if (explicitSigns) amount = token.value;
    else {
      amount = INCOME_WORDS.test(candidate.description) ? token.value : -token.value;
      uncertain = true;
    }
    if (candidate.balance) previousBalance = signed(candidate.balance);
    else if (previousBalance !== undefined) previousBalance = Math.round((previousBalance + amount) * 100) / 100;
    if (period && (candidate.date < shiftDays(period.from, -7) || candidate.date > shiftDays(period.to, 7))) {
      unparsed.push(candidate.line);
      continue;
    }
    deterministic.push({ line: candidate.line, date: candidate.date, amount: Math.round(amount * 100) / 100, description: candidate.description || "Buchung", uncertain });
  }
  const sum = (rows: { amount: number }[]) => rows.reduce((total, row) => total + Math.round(row.amount * 100), 0);
  const hasBalances = balances.opening !== undefined && balances.closing !== undefined;
  const balanceGap = (rows: { amount: number }[]) =>
    hasBalances ? (Math.round(balances.closing! * 100) - Math.round(balances.opening! * 100) - sum(rows)) / 100 : 0;
  const sufficient = deterministic.length > 0 && !unparsed.length && balanceGap(deterministic) === 0;

  const aiRows: (PdfExtractedRow & { line?: number })[] = [];
  if (!sufficient && options.extract) {
    const focus = deterministic.length && unparsed.length && balanceGap(deterministic) === 0 ? new Set(unparsed) : undefined;
    const parts = chunks(lines, focus);
    let done = 0;
    let failed = false;
    for (const part of parts) {
      if (options.signal?.aborted) break;
      if (options.deadline !== undefined && now() + 45_000 > options.deadline) break;
      let extracted: PdfExtractedRow[] = [];
      const timeout = options.deadline !== undefined ? AbortSignal.timeout(Math.max(1000, options.deadline - now() - 15_000)) : undefined;
      const signals = [options.signal, timeout].filter((signal): signal is AbortSignal => !!signal);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      try {
        extracted = await options.extract({ chunk: part.text, bank, ...(period ? { period } : {}), ...(signal ? { signal } : {}) });
      } catch (error) {
        failed = true;
        result.issues.push({ file, message: signal?.aborted
          ? `Zeitlimit: Die KI konnte nur ${done} von ${parts.length} PDF-Abschnitten lesen. Fehlende Buchungen bitte per CSV ergänzen.`
          : `KI-Hilfe für PDF nicht verfügbar: ${error instanceof Error ? error.message.slice(0, 200) : "Fehler"}` });
        break;
      }
      done++;
      for (const row of extracted.slice(0, 300)) {
        const grounded = groundAiRow(row, part.text, period);
        if (!grounded) continue;
        const key = `${grounded.date}|${Math.abs(Math.round(grounded.amount * 100))}`;
        const known = [...deterministic, ...aiRows].some((item) => `${item.date}|${Math.abs(Math.round(item.amount * 100))}` === key);
        if (!known) aiRows.push({ ...grounded, line: part.lines[0] });
      }
    }
    if (!failed && done < parts.length)
      result.issues.push({ file, message: `Zeitlimit: Die KI konnte nur ${done} von ${parts.length} PDF-Abschnitten lesen. Fehlende Buchungen bitte per CSV ergänzen.` });
  }

  const draft = (row: PdfExtractedRow): StatementDraft => ({
    id: crypto.randomUUID(), date: row.date, bank, pocket: null, description: row.description, amount: row.amount,
    category: "Prüfen", includeInPlan: true,
  });
  const report = (line: number | undefined, message: string, row: PdfExtractedRow) => {
    result.skipped++;
    result.issues.push({ file, ...(line !== undefined ? { line: line + 1 } : {}), message, draft: draft(row) });
  };
  const gap = balanceGap([...deterministic, ...aiRows]);
  for (const row of deterministic) {
    const candidate = transactionSchema.safeParse(recoverMerchant({
      id: crypto.randomUUID(), date: row.date, bank, pocket: null, description: row.description, amount: row.amount,
      category: "Prüfen", includeInPlan: true,
    } satisfies Transaction));
    if (row.uncertain || !candidate.success)
      report(row.line, row.uncertain
        ? "PDF: Vorzeichen nicht eindeutig (Ausgabe oder Eingang?) – bitte prüfen."
        : "PDF: Buchung nicht vollständig lesbar – bitte prüfen.", row);
    else result.rows.push(candidate.data);
  }
  for (const row of aiRows)
    report(row.line, hasBalances && gap === 0
      ? "Mit KI-Hilfe aus PDF gelesen; der Saldo stimmt – bitte kurz bestätigen."
      : "Mit KI-Hilfe aus PDF gelesen – Datum, Betrag und Text bitte prüfen.", row);
  const missing = new Set(unparsed);
  if (!options.extract || (!aiRows.length && missing.size))
    for (const line of [...missing].sort((a, b) => a - b).slice(0, 50)) {
      result.skipped++;
      result.issues.push({ file, line: line + 1, message: `PDF-Zeile nicht eindeutig lesbar: ${lines[line].replace(/\s+/g, " ").trim().slice(0, 160)}` } satisfies StatementIssue);
    }
  if (hasBalances && gap !== 0)
    result.issues.push({
      file,
      message: `Saldenprüfung: Anfangssaldo + Buchungen weicht um ${gap.toLocaleString("de-AT", { minimumFractionDigits: 2 })} € vom Endsaldo ab – eventuell fehlen Buchungen.`,
    });
  if (!result.rows.length && !result.issues.some((issue) => issue.draft)) {
    result.source = null;
    if (!result.issues.length) {
      result.skipped = Math.max(result.skipped, 1);
      result.issues.push({ file, message: "PDF erkannt, aber keine Buchungszeilen gefunden. Bitte CSV-Export der Bank verwenden." });
    }
  }
  result.rows = numberStatementRows(classifyStatementRows(result.rows));
  return result;
}
