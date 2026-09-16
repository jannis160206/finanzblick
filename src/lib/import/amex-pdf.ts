import { classifyStatementRows } from "@/lib/calc";
import { statementTime } from "@/lib/holidays-at-kaernten";
import { transactionSchema } from "@/lib/types";
import { numberStatementRows } from "./identity";
import { assertImportSize, MAX_STATEMENT_ROWS } from "./limits";
import { hasTerminalText, recoverMerchant, unresolvedTerminal } from "./merchant-description";
import {
  parseStatementAmount,
  parseStatementDate,
  type StatementDraft,
  type StatementResult,
} from "./statements";

// Text fixtures use exactly these layout lines, without names, addresses or card numbers.
export function parseAmexText(
  pages: string[],
  file = "Amex.pdf",
): StatementResult {
  const result: StatementResult = {
    source: "Amex",
    file,
    rows: [],
    skipped: 0,
    issues: [],
  };
  const text = pages.join("\n");
  const closing = text.match(/\b(\d{2})\.(\d{2})\.(\d{2}(?:\d{2})?)\b/);
  const year = closing
    ? closing[3].length === 2
      ? 2000 + Number(closing[3])
      : Number(closing[3])
    : null;
  const closingMonth = closing ? Number(closing[2]) : 0;
  const dateFor = (raw: string) => {
    if (!year) return "";
    const [day, month] = raw.split(".");
    return (
      parseStatementDate(
        `${day}.${month}.${year - (Number(month) > closingMonth ? 1 : 0)}`,
      ) ?? ""
    );
  };
  let pocket = "AMEX Jannis";
  let unknownHolder = false;
  let pending: StatementDraft | null = null;
  let pendingLine = 0;
  let lineNumber = 0;
  let messy = false;
  let descriptionHasAmount = false;
  let foreignAmount: RegExpMatchArray | null = null;
  let foreignCurrency = "";
  let foreignRate = false;
  const detail = (line: string) => {
    if (pending)
      pending.rawDetails = [...(pending.rawDetails ?? []), line.slice(0, 1000)].slice(0, 20);
  };
  const flush = () => {
    if (!pending) return;
    const confirmedForeign = foreignAmount && foreignCurrency && foreignRate;
    if (confirmedForeign) {
      pending.description = foreignAmount![1];
      detail(`Originalbetrag: ${foreignAmount![2]} ${foreignCurrency}`);
    }
    const time = statementTime(pending.time, pending.rawDescription, pending.description);
    if (time) pending.time = time;
    const parsed = transactionSchema.safeParse(recoverMerchant(pending));
    if (parsed.success && parsed.data.amount > 0 && /zahlung\s*\/\s*überweisung erhalten/i.test(parsed.data.description)) result.skipped++;
    else if (parsed.success && !messy && !unknownHolder && (!descriptionHasAmount || confirmedForeign)) result.rows.push(parsed.data);
    else {
      result.skipped++;
      result.issues.push({
        file,
        line: pendingLine,
        message:
          "Amex-PDF: Datum, Text oder Eurobetrag nicht eindeutig lesbar – bitte prüfen.",
        draft: pending,
      });
    }
    pending = null;
    messy = false;
    descriptionHasAmount = false;
    foreignAmount = null;
    foreignCurrency = "";
    foreignRate = false;
    if (result.rows.length + result.issues.length > MAX_STATEMENT_ROWS)
      throw new Error("Ein Import darf höchstens 100.000 Buchungen enthalten.");
  };
  for (const page of pages) {
    let active = false;
    for (const raw of page.split("\n")) {
      lineNumber++;
      const line = raw.replace(/\s+/g, " ").trim();
      if (/Umsatz vom.*Buchung am.*Betrag in EUR/i.test(line)) {
        active = true;
        continue;
      }
      if (!active) continue;
      if (
        /^(?:Hinweise zu Ihrer|American Express Europe|Zahlungsart|Membership|Saldo sonstige|Summe Belastungen)/i.test(
          line,
        )
      ) {
        flush();
        if (!/^Summe Belastungen/i.test(line)) active = false;
        continue;
      }
      if (/Neue Belastungen|Sonstige Transaktionen/i.test(line)) {
        flush();
        const ownCard = /\bjannis(?:\s+br(?:ü|ue)hl)?$/i.test(line);
        const partnerCard = /\braphael(?:\s+piber)?$/i.test(line);
        unknownHolder = /Neue Belastungen/i.test(line) && !ownCard && !partnerCard;
        pocket = partnerCard ? "AMEX Raphael" : unknownHolder ? "AMEX ungeklärt" : "AMEX Jannis";
        continue;
      }
      const booking = line.match(/^(\d{2}\.\d{2})\s+(\d{2}\.\d{2})\s+(.+)$/);
      if (booking) {
        flush();
        const tail = booking[3].match(
          /^(.*?)\s+([+\-]?\d[\d.]*,\d{2})(?:\s+(CR))?$/,
        );
        const amount = tail ? parseStatementAmount(tail[2]) : null;
        pending = {
          id: crypto.randomUUID(),
          date: dateFor(booking[1]),
          bank: "Amex",
          pocket,
          description: tail ? tail[1] : booking[3],
          amount: amount === null ? null : tail?.[3] ? amount : -amount,
          category: "Prüfen",
          includeInPlan: true,
        };
        // A second amount is only safe with the statement's currency/rate details.
        foreignAmount = tail && !hasTerminalText(tail[1])
          ? tail[1].match(/^(.*?)\s+(\d[\d.,]*[.,]\d{2})$/)
          : null;
        descriptionHasAmount = !hasTerminalText(pending.description) &&
          (!!foreignAmount || /\d[\d.]*,\d{2}/.test(pending.description));
        messy = !!foreignAmount && /\d[\d.,]*[.,]\d{2}/.test(foreignAmount[1]);
        pendingLine = lineNumber;
      } else if (pending && /^(?:(?:Uhrzeit|Time):?\s*)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:Uhr|AM|PM))?$/i.test(line)) {
        const time = statementTime(line);
        if (time) pending.time = time;
        else messy = true;
      } else if (pending && /^CR$/i.test(line)) {
        if (pending.amount !== null) pending.amount = Math.abs(pending.amount);
        else messy = true;
      } else if (pending && /^[+\-]?\d[\d.]*,\d{2}(?:\s+CR)?$/.test(line)) {
        if (pending.amount !== null) messy = true;
        else {
          const amount = parseStatementAmount(line.replace(/\s+CR$/i, ""));
          pending.amount =
            amount === null ? null : /CR$/i.test(line) ? amount : -amount;
        }
      } else if (/^\d{2}\.\d{2}\b/.test(line)) {
        flush();
        pending = {
          id: crypto.randomUUID(),
          date: dateFor(line.slice(0, 5)),
          bank: "Amex",
          pocket,
          description: line,
          amount: null,
          category: "Prüfen",
          includeInPlan: false,
        };
        pendingLine = lineNumber;
        messy = true;
      } else if (pending && foreignAmount && /^(?:UNITED STATES DOLLAR|US DOLLAR|USD|POUND STERLING|BRITISH POUND|SWISS FRANC|SCHWEIZER FRANKEN|CANADIAN DOLLAR|AUSTRALIAN DOLLAR|JAPANESE YEN)$/i.test(line)) {
        foreignCurrency = line;
        detail(line);
      } else if (pending && foreignCurrency && /^Referenzwechselkurs\s+\d+(?:[.,]\d+)?\s*\+\s*Entgelt in EUR\s+\d[\d.]*,\d{2}$/i.test(line)) {
        // The fee is already included in the EUR charge, not a second movement.
        foreignRate = true;
        detail(line);
      } else if (pending && (
        (/\b(?:OEBB|ÖBB)\b/i.test(pending.description) && /^\d+\s+(?:OEBB|ÖBB) TICKET\s+\d+$/i.test(line)) ||
        /^Flugstrecke:\s*Von:\s*\S.+$/i.test(line) ||
        /^Nach:\s*.+\s+Fluglinie:\s*\w+\s+Klasse:\s*\w+$/i.test(line) ||
        /^(?:Autovermietung Ort|Rückgabe):\s*.+\s+Datum:\s*\d{2}\/\d{2}\/\d{2}(?:\d{2})?$/i.test(line) ||
        /^Kilometer(?:\s+\d+)?\s+Vertragsnummer:\s*[\w-]+$/i.test(line)
      )) {
        detail(line);
      } else if (pending && unresolvedTerminal(pending.description) && line) {
        pending.rawDetails = [...(pending.rawDetails ?? []), line.slice(0, 1000)].slice(0, 20);
        pending = recoverMerchant<StatementDraft>(pending);
      } else if (
        line &&
        !/^(?:Karten(?:nummer|-Nr\.)|Ticketnummer:|R-[a-f\d-]+|\d[\d.]*,\d{2})/i.test(
          line,
        )
      ) {
        // The charge table wraps merchant/address text onto subsequent lines.
        // Keep it with that charge; ambiguous amounts still go to review.
        if (pending) {
          pending.description = `${pending.description} ${line}`.slice(0, 1000);
          detail(line);
          if (foreignRate || /\d[\d.]*,\d{2}|\b(?:Abschnitt|Zusatzbuchung)\b/i.test(line)) messy = true;
        } else
          result.issues.push({
            file,
            line: lineNumber,
            message: `Unbekannter Amex-Dateiabschnitt: ${line}`,
          });
      }
    }
  }
  flush();
  result.rows = numberStatementRows(classifyStatementRows(result.rows));
  if (!result.rows.length && !result.issues.length && !result.skipped)
    result.issues.push({
      file,
      message:
        "Amex-PDF: Kein eindeutig lesbarer Buchungstext. Möglicherweise ein Scan; bitte CSV oder eine PDF mit Text verwenden.",
    });
  return result;
}

export async function parseAmexPdf(
  buffer: ArrayBuffer,
  file: string,
): Promise<StatementResult> {
  assertImportSize(buffer.byteLength);
  if (!new TextDecoder().decode(buffer.slice(0, 1024)).includes("%PDF-"))
    throw new Error(
      "PDF-Datei konnte nicht gelesen werden: ungültige PDF-Signatur.",
    );
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined")
    pdfjs.GlobalWorkerOptions.workerSrc = "/api/pdf-worker";
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });
  try {
    const document = await task.promise;
    if (document.numPages > 500)
      throw new Error("Die PDF-Datei enthält mehr als 500 Seiten.");
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const lines: { y: number; items: { x: number; text: string }[] }[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const y = item.transform[5];
        let line = lines.find((candidate) => Math.abs(candidate.y - y) <= 2);
        if (!line) {
          line = { y, items: [] };
          lines.push(line);
        }
        line.items.push({ x: item.transform[4], text: item.str });
      }
      pages.push(
        lines
          .sort((a, b) => b.y - a.y)
          .map((line) =>
            line.items
              .sort((a, b) => a.x - b.x)
              .map((item) => item.text)
              .join(" "),
          )
          .join("\n"),
      );
      page.cleanup();
    }
    if (
      !/american\s*express|amex\.at/i.test(pages.join("\n")) &&
      pages.some((page) => page.trim())
    ) {
      return {
        source: null,
        file,
        rows: [],
        skipped: 1,
        issues: [
          {
            file,
            message:
              "PDF-Anbieter nicht eindeutig als Amex erkannt. Bitte Kontoauszug prüfen.",
          },
        ],
      };
    }
    return parseAmexText(pages, file);
  } catch (error) {
    throw new Error(
      `PDF-Datei konnte nicht gelesen werden: ${error instanceof Error ? error.message : "beschädigt oder verschlüsselt"}`,
    );
  } finally {
    await task.destroy();
  }
}
