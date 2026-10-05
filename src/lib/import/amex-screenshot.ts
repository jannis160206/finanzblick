import { classifyStatementRows } from "@/lib/calc";
import { transactionSchema } from "@/lib/types";
import { numberStatementRows } from "./identity";
import { MAX_STATEMENT_ROWS } from "./limits";
import { recoverMerchant } from "./merchant-description";
import { parseStatementAmount, parseStatementDate, type StatementDraft, type StatementResult } from "./statements";

export type ScreenshotLine = {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  uncertain?: boolean;
};
const clean = (text: string) => text.replace(/\s+/g, " ").trim();
const months: Record<string, string> = {
  jan: "01", januar: "01", feb: "02", februar: "02", mär: "03", märz: "03", mar: "03", maerz: "03",
  apr: "04", april: "04", mai: "05", jun: "06", juni: "06", jul: "07", juli: "07",
  aug: "08", august: "08", sep: "09", sept: "09", september: "09", okt: "10", oktober: "10",
  nov: "11", november: "11", dez: "12", dezember: "12",
};

const datePattern = /^(\d{1,2})\.?\s+([a-zä]+)\.?\s+(\d{4})(?:\s+[•·–-]\s*(.+))?$/i;
export function screenshotDate(text: string): string | null {
  const match = clean(text).match(datePattern);
  return match && months[match[2].toLowerCase()]
    ? parseStatementDate(`${match[1]}.${months[match[2].toLowerCase()]}.${match[3]}`)
    : null;
}
export function screenshotPocket(text: string): string {
  const holder = clean(text).match(datePattern)?.[4];
  if (!holder || /^jannis(?:\s+br(?:ü|ue)hl)?$/i.test(holder)) return "Amex";
  return /^raphael(?:\s+piber)?$/i.test(holder) ? "AMEX Raphael" : "AMEX ungeklärt";
}

export function screenshotAmount(text: string): number | null {
  const normalized = clean(text).replace(/[−–]/g, "-");
  // The app always shows cents. Never turn an OCR-lost comma into a 100x charge.
  if (!/^[+-]?\s*(?:€\s*[+-]?\s*\d[\d.]*,\d{2}|\d[\d.]*,\d{2}\s*€)$/.test(normalized)) return null;
  const amount = parseStatementAmount(normalized);
  return amount === null ? null : -amount;
}

const dateLike = (text: string) => /^\d{1,2}[.\s]+[a-zä?.]+(?:\s+\S+)?$/i.test(text) || datePattern.test(text);
const chrome = (text: string) => /^(?:Filtern|Sortieren nach|(?:Aktuelle|Kürzliche)\s*(?:Transaktionen)?|Transaktionen|\d+\s+Transaktionen|Vorgemerkt|Ausstehend)$/i.test(text);

export function screenshotContentTop(lines: ScreenshotLine[]): number | null {
  const period = lines.find((line) => /\d{1,2}\.\d{1,2}\.\d{4}\s*[-–]\s*Aktuell/i.test(line.text));
  const card = lines.find((line) => /Karte[nm]*ummer\s*[-:•* ]+\d+/i.test(line.text));
  if (!period || !card) return null;
  const sorting = lines.find((line) => /Sortieren nach:/i.test(line.text));
  const count = lines.find((line) => /^\s*\d+\s+Transaktionen\s*$/i.test(line.text));
  return Math.max(period.bbox.y1, card.bbox.y1, sorting?.bbox.y1 ?? 0, count?.bbox.y1 ?? 0);
}

export function parseAmexScreenshotLines(lines: ScreenshotLine[], file = "Amex.png"): StatementResult {
  const result: StatementResult = { source: "Amex", file, rows: [], skipped: 0, issues: [] };
  const top = screenshotContentTop(lines);
  if (top === null) {
    result.source = null;
    result.issues.push({ file, message: "Screenshot nicht eindeutig als Amex-Umsatzliste erkannt. Bitte Zeitraum und Kartennummer mit aufnehmen." });
    return result;
  }
  const content = lines.map((line) => ({ ...line, text: clean(line.text) }))
    .filter((line) => line.bbox.y0 > top && line.text && !chrome(line.text));
  const right = Math.max(...lines.map((line) => line.bbox.x1));
  const amountLines = content.filter((line) => line.bbox.x0 > right * 0.7);
  const left = content.filter((line) => !amountLines.includes(line))
    .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const heights = left.map((line) => line.bbox.y1 - line.bbox.y0).sort((a, b) => a - b);
  const height = heights[Math.floor(heights.length / 2)] ?? 24;
  const groups: ScreenshotLine[][] = [];
  for (const line of left) {
    const previous = groups.at(-1)?.at(-1);
    if (!previous || dateLike(previous.text) || line.bbox.y0 - previous.bbox.y1 > height * 1.5)
      groups.push([]);
    groups.at(-1)!.push(line);
  }
  const used = new Set<ScreenshotLine>();
  for (const group of groups) {
    const first = group[0].bbox.y0;
    const last = group.at(-1)!.bbox.y1;
    const amounts = amountLines.filter((line) => {
      const center = (line.bbox.y0 + line.bbox.y1) / 2;
      return !used.has(line) && center >= first - height && center <= last + height;
    });
    amounts.forEach((line) => used.add(line));
    const dates = group.filter((line) => dateLike(line.text));
    const merchants = group.filter((line) => !dates.includes(line));
    const name = merchants.find((line) => /\p{L}/u.test(line.text) && !/^(?=.*\d)[a-z\d]{6,}$/i.test(line.text));
    const uncertainMerchant = merchants.some((line) => line.uncertain) || !!name && name.confidence < 35;
    const description = clean(merchants.map((line) => line.text).join(" "));
    const date = dates.length === 1 && !dates[0].uncertain ? screenshotDate(dates[0].text) : null;
    const pocket = dates.length === 1 ? screenshotPocket(dates[0].text) : "Amex";
    const amount = amounts.length === 1 && !amounts[0].uncertain ? screenshotAmount(amounts[0].text) : null;
    // Card repayments are not new income, even when OCR misses their date.
    if (amount !== null && amount > 0 && /^zahlung\s*\/\s*überweisung\s+erhalten\b/i.test(description)) {
      result.skipped++;
      continue;
    }
    const draft: StatementDraft = {
      id: crypto.randomUUID(), bank: "Amex", pocket, date: date ?? "", description: description.slice(0, 1000),
      amount, category: "Prüfen", includeInPlan: true,
      rawDetails: ["Amex-Screenshot", ...(uncertainMerchant ? ["OCR-Händler unklar"] : []),
        ...[...group, ...amounts].map((line) => line.text.slice(0, 1000))].slice(0, 20),
    };
    const parsed = transactionSchema.safeParse(recoverMerchant(draft));
    if (parsed.success && !uncertainMerchant && pocket !== "AMEX ungeklärt") {
      result.rows.push(parsed.data);
    } else {
      result.skipped++;
      result.issues.push({ file, line: groups.indexOf(group) + 1, draft,
        message: "Amex-Screenshot: Händler, Datum oder Eurobetrag nicht eindeutig lesbar – bitte mit dem Bild abgleichen." });
    }
    if (result.rows.length + result.issues.length > MAX_STATEMENT_ROWS) throw new Error("Zu viele Buchungen im Screenshot.");
  }
  for (const line of amountLines.filter((line) => !used.has(line))) {
    result.skipped++;
    result.issues.push({ file, message: "Amex-Screenshot: Abgeschnittene Buchung – Händler und Datum fehlen.",
      draft: { id: crypto.randomUUID(), bank: "Amex", pocket: "Amex", date: "", description: "",
        amount: line.uncertain ? null : screenshotAmount(line.text), category: "Prüfen", includeInPlan: true,
        rawDetails: ["Amex-Screenshot", line.text.slice(0, 1000)] } });
  }
  result.rows = numberStatementRows(classifyStatementRows(result.rows));
  if (!result.rows.length && !result.issues.length)
    result.issues.push({ file, message: "Amex-Screenshot: Keine lesbaren Buchungen gefunden. Bitte einen vollständigen, scharfen Screenshot verwenden." });
  return result;
}
