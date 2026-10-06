import type { PayslipDraft, PayslipImport } from "@/lib/payslip-schema";
import { assertImportSize } from "./limits";

export type PayslipTextItem = { x: number; text: string; width?: number };
export type PayslipLine = { y: number; items: readonly PayslipTextItem[] };
export type PayslipPage = { pageNumber?: number; lines: readonly PayslipLine[] };

export class PayslipPasswordError extends Error {
  constructor(public readonly code: "password-required" | "wrong-password") {
    super(code === "password-required"
      ? "Diese PDF-Datei ist verschlüsselt. Bitte das PDF-Passwort eingeben."
      : "Das PDF-Passwort ist nicht richtig. Bitte erneut eingeben.");
    this.name = "PayslipPasswordError";
  }
}

class PayslipImportError extends Error {}

const MAX_PAGES = 100;
const MAX_PAGE_ITEMS = 10_000;
const MAX_PAGE_TEXT = 100_000;
const MAX_TEXT = 1_000_000;
const TITLE = /(?:lohn|gehalts?)[\s/-]*(?:(?:lohn|gehalts?)[\s/-]*)?abrechnung/i;
const MONTHS = [
  "jänner|januar", "februar", "märz|maerz", "april", "mai", "juni",
  "juli", "august", "september", "oktober", "november", "dezember",
];
const MONEY = /^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}-?$/;
const REGULAR = /^(?:gehalt|grundgehalt|monatsgehalt|grundlohn|monatslohn|lohn|üstd[.\s-]*grundlohn|üstd[.\s-]*zs\s*\d+\s*%\s*(?:pfl|fr)\.?|überstunden(?:grundlohn|zuschlag|pauschale)?|rufbereitschaft(?:.*)?)$/i;
const BASE_SALARY = /^(?:gehalt|grundgehalt|monatsgehalt|grundlohn|monatslohn|lohn)$/i;
const SPECIAL = /^(?:urlaubszuschuss|urlaubsbeihilfe|urlaubsgeld|weihnachtsremuneration|weihnachtsgeld|sonderzahlung|(?:13|14)\.(?:\s*\/\s*14\.)?\s*(?:gehalt|monatsgehalt|lohn))$/i;
const VEB_BONUS = /^veb[- ]prämie$/i;
const EXPENSE = /^(?:(?:telearbeits|homeoffice)[- ]?pauschale|reisekostenersatz|fahrtkostenersatz|kilometergeld|diäten)\s+(?:frei|steuerfrei|§\s*26(?:\s+estg)?)$/i;
const INFORMATIONAL = /^(?:freibetrag\s*§\s*68\s*\(\s*[12]\s*\)|(?:telearbeits|homeoffice)[- ]?tage)$/i;
const CORPORATION = /^(?!.*(?:personal|versicher|arbeitnehmer|dienstnehmer|iban|@|\d{4})).*[a-zäöü].*\b(?:gmbh(?:\s*&\s*co\.?\s*kg)?|ag|kg|og|e\.?\s*u\.?)$/i;

function clean(value: string): string {
  return value.normalize("NFKC").replace(/[−–]/g, "-").replace(/\s+/g, " ").trim();
}

function text(line: PayslipLine): string {
  return [...line.items].sort((a, b) => a.x - b.x).map((item) => clean(item.text)).join(" ").trim();
}

function cents(value: string): number | undefined {
  const token = clean(value).replace(/\s*(?:€|EUR)$/i, "").replace(/\s/g, "");
  if (!MONEY.test(token)) return undefined;
  const number = Number(token.replace(/\./g, "").replace(",", ".").replace(/-$/, ""));
  const amount = Math.round(number * 100) * (token.endsWith("-") ? -1 : 1);
  return Number.isSafeInteger(amount) && Math.abs(amount) <= 100_000_000_000 ? amount : undefined;
}

function amounts(items: readonly PayslipTextItem[]): number[] {
  return items.flatMap((item) => {
    const value = cents(item.text);
    return value === undefined ? [] : [value];
  });
}

type Columns = { amountStart: number; amountEnd: number; svEnd: number };

function center(item: PayslipTextItem): number {
  return item.x + (item.width ?? clean(item.text).length * 4) / 2;
}

function columns(line: PayslipLine): Columns | undefined {
  const items = line.items;
  const amount = items.find((item) => /^betrag$/i.test(clean(item.text)));
  const sv = items.find((item) => /^bmg\s*sv$/i.test(clean(item.text)));
  const tax = items.find((item) => /^bmg\s*l(?:ohn)?st$/i.test(clean(item.text)));
  const previous = items.find((item) => /^satz$/i.test(clean(item.text)));
  if (!amount || !sv || !tax || !previous ||
    !(center(previous) < center(amount) && center(amount) < center(sv) && center(sv) < center(tax)))
    return undefined;
  return {
    amountStart: (center(previous) + center(amount)) / 2,
    amountEnd: (center(amount) + center(sv)) / 2,
    svEnd: (center(sv) + center(tax)) / 2,
  };
}

function cell(line: PayslipLine, layout: Columns, column: "amount" | "sv" | "tax"): number | undefined {
  const items = line.items.filter((item) => column === "amount"
    ? center(item) >= layout.amountStart && center(item) < layout.amountEnd
    : column === "sv" ? center(item) >= layout.amountEnd && center(item) < layout.svEnd
    : center(item) >= layout.svEnd);
  const values = amounts(items);
  return values.length === 1 ? values[0] : undefined;
}

function description(line: PayslipLine, layout: Columns): string {
  return line.items.filter((item) => center(item) < layout.amountStart)
    .sort((a, b) => a.x - b.x)
    .map((item) => clean(item.text))
    .filter((item) => !/^[+\-\d.,\s]+$/.test(item))
    .join(" ").replace(/^\d{3,5}\s+/, "").trim();
}

function findPeriod(lines: readonly PayslipLine[], titleIndex: number): { year?: number; month?: number } {
  const header = lines.slice(titleIndex, titleIndex + 3).map(text).join(" ");
  for (let month = 0; month < MONTHS.length; month++) {
    const match = header.match(new RegExp(`\\b(?:${MONTHS[month]})\\s+(\\d{4})\\b`, "i"));
    if (match) return { month: month + 1, year: Number(match[1]) };
  }
  const numeric = header.match(/\b(0?[1-9]|1[0-2])\s*[/.]\s*(20\d{2})\b/);
  return numeric ? { month: Number(numeric[1]), year: Number(numeric[2]) } : {};
}

function findEmployer(lines: readonly PayslipLine[]): string | undefined {
  const labelled: string[] = [];
  const corporations: string[] = [];
  for (const line of lines) {
    const value = text(line);
    const explicit = value.match(/^(?:arbeitgeber|dienstgeber|firma)\s*:\s*(.+)$/i);
    if (explicit) {
      let name = explicit[1];
      const numbered = /^(\d{3,12})\s+(.+)$/.exec(name);
      // Some payroll headers put a separate internal company number before the name.
      if (numbered && line.items.some((item) => clean(item.text) === numbered[1]) &&
        CORPORATION.test(numbered[2])) name = numbered[2];
      if (name.length <= 120 &&
        !/personal|versicher|arbeitnehmer|dienstnehmer|iban|\d{4}/i.test(name)) labelled.push(name);
    }
    if (value.length <= 120 && CORPORATION.test(value)) corporations.push(value);
  }
  const candidates = [...new Set(labelled.length ? labelled : corporations)];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function payrollDays(lines: readonly PayslipLine[]): boolean | undefined {
  for (let index = 0; index < lines.length; index++) {
    const label = lines[index].items.find((item) => /^LSt[- ]?T(?:g|age)\.?$/i.test(clean(item.text)));
    if (!label) continue;
    const next = lines[index + 1];
    if (!next || Math.abs(next.y - lines[index].y) > 25) continue;
    const values = next.items.filter((item) => Math.abs(center(item) - center(label)) < 15)
      .map((item) => clean(item.text)).filter((item) => /^\d{1,2}$/.test(item));
    if (values.length === 1 && Number(values[0]) <= 30) return Number(values[0]) === 30;
  }
  return undefined;
}

const SPECIAL_TAXABLE_YTD = /^steuerpflichtige\s+sonderzahlungen\s+(?:kumuliert|ytd)\s+innerhalb\s+(?:des\s+)?jahressechstels?\s+nach\s+sv\s+vor\s+620(?:[,.]00)?(?:\s*(?:€|eur))?(?:[- ]?freibetrag)?$/i;
const REPORTED_FIELDS = [
  ["reportedSixth", /^(?:jahressechstel|jahres[- ]?sechstel)$/i],
  ["usedSixth", /^(?:(?:verbrauchtes|ausgenütztes|ausgenutztes)\s+(?:jahres)?sechstel|sechstelverbrauch)$/i],
  ["regularGrossYtd", /^(?:laufende\s+(?:brutto)?bezüge|brutto\s+lfd\.?)\s+(?:kumuliert|ytd)$/i],
  ["specialGrossYtd", /^(?:sonderzahlungen|brutto\s+sz)\s+(?:kumuliert|ytd)$/i],
  ["specialTaxableYtd", SPECIAL_TAXABLE_YTD],
] as const;

/** Parses only positioned text; raw lines never become stored draft fields or issues. */
export function parsePayslipPages(pages: readonly PayslipPage[]): PayslipImport {
  if (pages.length > MAX_PAGES) throw new PayslipImportError("Die PDF-Datei darf höchstens 100 Seiten enthalten.");
  const result: PayslipImport = { drafts: [], issues: [] };
  const warnings = new Set<string>();
  const seen = new Map<string, PayslipDraft>();
  let textLength = 0;
  let hasText = false;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const number = page.pageNumber ?? pageIndex + 1;
    let location = `Seite ${number}`;
    const issue = (message: string) => {
      const warning = `${location}: ${message}`;
      if (!warnings.has(warning)) {
        warnings.add(warning);
        result.issues.push(warning);
      }
    };
    const lines = [...page.lines].sort((a, b) => b.y - a.y);
    const pageLength = lines.reduce((sum, line) => sum + line.items.reduce((count, item) => count + item.text.length, 0), 0);
    textLength += pageLength;
    if (pageLength > MAX_PAGE_TEXT || textLength > MAX_TEXT ||
      lines.reduce((sum, line) => sum + line.items.length, 0) > MAX_PAGE_ITEMS)
      throw new PayslipImportError("Die PDF-Datei enthält zu viel Text. Bitte weniger Abrechnungen auf einmal importieren.");
    const rendered = lines.map(text);
    if (!rendered.some(Boolean)) {
      issue("Kein lesbarer Text; eine gescannte Seite kann nicht automatisch ausgewertet werden.");
      continue;
    }
    hasText = true;
    const titleIndex = rendered.findIndex((line) => TITLE.test(line));
    const tableIndex = lines.findIndex((line) => !!columns(line));
    const hasBrutto = rendered.some((line) => /^(?:gesamt[- ]?)?brutto\b/i.test(line));
    const employerCosts = rendered.some((line) => /\b(?:kommunalsteuer|gesamtaufwand|dienstgeberbeitrag|dienstgeberanteil)\b/i.test(line));
    const layout = tableIndex < 0 ? undefined : columns(lines[tableIndex]);
    const hasWages = layout && lines.slice(tableIndex + 1).some((line) =>
      REGULAR.test(description(line, layout)) || SPECIAL.test(description(line, layout)));
    if (employerCosts && !hasBrutto && !hasWages) continue;
    if (titleIndex < 0) {
      issue("Kein eindeutig zuordenbarer Abrechnungskopf. Bitte die vollständige Original-Abrechnung hochladen.");
      if (result.drafts.length) {
        delete result.drafts.at(-1)!.regularGross;
        delete result.drafts.at(-1)!.specialGross;
      }
      continue;
    }
    const draft: PayslipDraft = {};
    const period = findPeriod(lines, titleIndex);
    if (period.month && period.year) location += ` (${String(period.month).padStart(2, "0")}/${period.year})`;
    if (period.month) draft.month = period.month;
    else issue("Abrechnungsmonat nicht eindeutig lesbar.");
    if (period.year === 2026 || period.year === 2027) draft.year = period.year;
    else issue(period.year ? "Abrechnungsjahr wird nicht unterstützt; nur 2026 und 2027 sind vorgesehen." : "Abrechnungsjahr nicht eindeutig lesbar.");
    draft.employer = findEmployer(lines.slice(0, tableIndex < 0 ? undefined : tableIndex));
    if (!draft.employer) issue("Arbeitgeber nicht eindeutig erkannt; eine vollständige Abrechnung mit lesbarem Firmenkopf wird benötigt.");
    draft.monthlyPayroll = payrollDays(lines);
    if (draft.monthlyPayroll === false) issue("Teilmonat erkannt; die automatische Standardhochrechnung ist dafür nicht verfügbar.");
    if (draft.monthlyPayroll === undefined) issue("Voller Abrechnungsmonat nicht bestätigt; die Abrechnungstage sind nicht eindeutig lesbar.");

    const readings = new Map<keyof PayslipDraft, number[]>();
    const record = (field: keyof PayslipDraft, value: number | undefined) => {
      if (value !== undefined) readings.set(field, [...(readings.get(field) ?? []), value]);
    };
    for (const line of lines) {
      const label = line.items.filter((item) => cents(item.text) === undefined)
        .sort((a, b) => a.x - b.x).map((item) => clean(item.text)).join(" ").replace(/:$/, "");
      if (/^steuerpflichtige\s+sonderzahlungen\s+(?:kumuliert|ytd)\b/i.test(label) &&
        !SPECIAL_TAXABLE_YTD.test(label))
        issue("Kumulierte Sonderzahlungs-Steuerbasis nicht eindeutig als innerhalb des Jahressechstels, nach SV und vor 620-Euro-Freibetrag ausgewiesen; der Wert bleibt unbekannt.");
      for (const [field, pattern] of REPORTED_FIELDS) {
        if (!pattern.test(label)) continue;
        const values = amounts(line.items);
        if (values.length === 1 && values[0] >= 0) record(field, values[0]);
        else issue("Ein kumulierter Kontrollwert ist nicht eindeutig lesbar und wird nicht geschätzt.");
      }
    }
    let regular = 0;
    let special = 0;
    let listedGross = 0;
    let wageCount = 0;
    let regularCount = 0;
    let specialCount = 0;
    let bonus = 0;
    let regularSvBase = 0;
    let tariffBase = 0;
    let bonusEvidenceComplete = true;
    const regularSvBases: (number | undefined)[] = [];
    const specialSvBases: (number | undefined)[] = [];
    let gross: number | undefined;
    let complete = !!layout;
    let active = false;
    let ended = false;
    const components = new Set<string>();
    if (!layout) issue("Spaltenlayout nicht unterstützt; keine automatische Bruttoaufteilung möglich.");
    else {
      for (let index = tableIndex; index < lines.length; index++) {
        const line = lines[index];
        const label = description(line, layout);
        if (columns(line)) {
          if (!ended) active = true;
          continue;
        }
        const value = cell(line, layout, "amount");
        if (/^(?:gesamt[- ]?)?brutto(?:bezüge|summe)?(?:\s+gesamt)?$/i.test(label)) {
          const values = amounts(line.items);
          const total = value ?? (values.length === 1 ? values[0] : undefined);
          if (gross !== undefined || total === undefined || total < 0) {
            complete = false;
            issue("Bruttosumme fehlt, ist mehrfach vorhanden oder nicht eindeutig lesbar.");
          }
          gross = total;
          active = false;
          ended = true;
          continue;
        }
        if (/^(?:abzüge|netto|auszahlung)\b/i.test(label)) {
          active = false;
          ended = true;
        }
        if (/^sv[- ]?beitrag\s+(?:lfd\.?|laufend|sz|sonderzahlung(?:en)?)$/i.test(label)) {
          (/\b(?:lfd\.?|laufend)$/i.test(label) ? regularSvBases : specialSvBases).push(cell(line, layout, "sv"));
          if (value === undefined) issue("Ein Sozialversicherungsbeitrag ist nicht eindeutig lesbar und bleibt unbekannt.");
          else record(/\b(?:lfd\.?|laufend)$/i.test(label) ? "regularSv" : "specialSv", Math.abs(value));
        }
        if (/^l(?:ohn)?st[- ]?beitrag\s+(?:sz|sonderzahlung(?:en)?)$/i.test(label)
          && (value !== 0 || cell(line, layout, "tax") !== 0)) bonusEvidenceComplete = false;
        if (/^l(?:ohn)?st[- ]?beitrag\s+(?:lfd\.?|laufend)$/i.test(label)) {
          if (value === undefined) issue("Laufender Lohnsteuerbeitrag nicht eindeutig lesbar und bleibt unbekannt.");
          else record("regularTax", Math.abs(value));
          const taxable = cell(line, layout, "tax");
          if (taxable !== undefined && taxable >= 0) record("monthlyTaxableBase", taxable);
          else issue("Lohnsteuer-Bemessungsgrundlage nicht eindeutig lesbar und bleibt unbekannt.");
        }
        if (!active || !label) continue;
        if (INFORMATIONAL.test(label) && value === undefined) {
          const reduction = cell(line, layout, "tax");
          if (/^freibetrag/i.test(label)) {
            if (reduction === undefined || reduction > 0) bonusEvidenceComplete = false;
            else tariffBase += reduction;
          }
          continue;
        }
        if (value !== undefined) listedGross += value;
        if (value === undefined || value < 0) {
          complete = false;
          issue("Ein Bezugsbestandteil ist unvollständig oder eine Korrektur; keine sichere automatische Bruttoaufteilung möglich.");
          continue;
        }
        const code = [...line.items].sort((a, b) => a.x - b.x).map((item) => clean(item.text))
          .find((item) => /^\d{3,5}(?:\s|$)/.test(item))?.match(/^\d{3,5}/)?.[0];
        const component = `${code ?? "?"}|${label.toLocaleLowerCase("de-AT")}`;
        if (components.has(component)) {
          complete = false;
          issue("Bezugsbestandteil mehrfach vorhanden; eine mögliche Korrektur wird nicht automatisch verrechnet.");
        }
        components.add(component);
        const svBase = cell(line, layout, "sv");
        const taxBase = cell(line, layout, "tax");
        if (REGULAR.test(label)) {
          regular += value;
          wageCount++;
          regularCount++;
          if (svBase === undefined || svBase < 0 || taxBase === undefined || taxBase < 0) bonusEvidenceComplete = false;
          else {
            regularSvBase += svBase;
            tariffBase += taxBase;
          }
          if (BASE_SALARY.test(label)) record("baseSalary", value);
        } else if (SPECIAL.test(label)) {
          special += value;
          wageCount++;
          specialCount++;
        } else if (VEB_BONUS.test(label)) {
          bonus += value;
          tariffBase += taxBase ?? 0;
          wageCount++;
          if (value === 0 || svBase !== value || taxBase !== value) bonusEvidenceComplete = false;
        } else if (EXPENSE.test(label)) {
          if ((svBase ?? 0) !== 0 || (taxBase ?? 0) !== 0) bonusEvidenceComplete = false;
        } else {
          complete = false;
          issue(`Nicht unterstützter Bezugsbestandteil${code ? ` (Lohnart ${code})` : ""}; Steuerfreiheit und Sechstelzuordnung sind nicht eindeutig erkennbar. Diese Abrechnung wird nicht automatisch übernommen.`);
        }
      }
      if (gross === undefined || !wageCount) {
        complete = false;
        issue("Bruttosumme oder eindeutige Bezüge fehlen; keine automatische Bruttoaufteilung.");
      } else if (Math.abs(gross - listedGross) > 1) {
        complete = false;
        issue("Bruttosumme stimmt nicht mit den erkannten Bestandteilen überein; keine sichere automatische Bruttoaufteilung möglich.");
      }
      if (bonus > 0) {
        const reading = (field: keyof PayslipDraft) => readings.get(field)?.length === 1 ? readings.get(field)![0] : undefined;
        const regularSv = reading("regularSv");
        const specialSv = reading("specialSv");
        const taxable = reading("monthlyTaxableBase");
        if (!bonusEvidenceComplete || specialCount > 0 || regularSv === undefined || specialSv === undefined ||
          specialSv > bonus || regularSv > regular || taxable === undefined || reading("regularTax") === undefined ||
          regularSvBases.length !== 1 || regularSvBases[0] !== regularSvBase ||
          specialSvBases.length !== 1 || specialSvBases[0] !== bonus ||
          Math.abs(tariffBase - regularSv - specialSv - taxable) > 1) {
          complete = false;
          issue("VEB-Prämie nicht eindeutig mit den SV- und LSt-Bemessungsgrundlagen abgeglichen; diese Abrechnung wird nicht automatisch übernommen.");
        }
      }
    }
    for (const [field, values] of readings) {
      if (values.length !== 1) issue("Mehrere Werte für dasselbe Betragsfeld; kein eindeutiger Wert übernommen.");
      else Object.assign(draft, { [field]: values[0] / 100 });
    }
    if (rendered.filter((line) => TITLE.test(line)).length !== 1 ||
      rendered.some((line) => /\b(?:aufrollung|korrekturabrechnung|storno|nachverrechnung)\b/i.test(line))) {
      complete = false;
      issue("Mehrere Abrechnungen oder eine Korrektur erkannt; bitte die gültige vollständige Monatsabrechnung einzeln hochladen.");
    }
    if (complete) {
      if (bonus > 0) {
        draft.unresolvedSixthBonus = bonus / 100;
        issue("VEB-Prämie erkannt: SV-Sonderzahlung und laufender Lohnsteuertarif. Ihre Sechstelzuordnung ist im Beleg nicht ausgewiesen; die Auswertung zeigt dafür eine Schätzspanne.");
      }
      if (regularCount) draft.regularGross = regular / 100;
      else issue("Keine eindeutigen laufenden Bezüge; sie werden nicht aus Sonderzahlungen abgeleitet.");
      if (specialCount || (regularCount && draft.monthlyPayroll === true)) draft.specialGross = special / 100;
      else issue("Fehlende Sonderzahlungen sind bei unklarem oder unvollständigem Monat nicht automatisch null.");
    }
    const key = `${period.year ?? "?"}-${period.month ?? "?"}|${draft.employer?.toLocaleLowerCase("de-AT") ?? "?"}`;
    const previous = seen.get(key);
    if (previous) {
      for (const field of Object.keys(previous) as (keyof PayslipDraft)[])
        if (field !== "year" && field !== "month" && field !== "employer") delete previous[field];
      issue("Mehrere Belege für denselben Monat und Arbeitgeber; keine automatische Addition. Bitte die gültige Abrechnung auswählen.");
    } else {
      seen.set(key, draft);
      result.drafts.push(draft);
    }
  }
  if (!hasText) throw new PayslipImportError("Kein lesbarer PDF-Text. Gescannte Abrechnungen werden nicht unterstützt; bitte eine PDF mit Text verwenden.");
  if (!result.drafts.length) throw new PayslipImportError("Keine unterstützte Lohn- oder Gehaltsabrechnung gefunden. Bitte eine Arbeitnehmer-Abrechnung mit Text verwenden.");
  return result;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PayslipImportError("Das Lesen der PDF-Datei hat zu lange gedauert. Bitte eine kleinere Datei verwenden.")), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function parsePayslipPdf(buffer: ArrayBuffer, password?: string): Promise<PayslipImport> {
  assertImportSize(buffer.byteLength);
  if (!new TextDecoder().decode(buffer.slice(0, 1024)).includes("%PDF-"))
    throw new PayslipImportError("PDF-Datei konnte nicht gelesen werden: ungültige PDF-Signatur.");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") pdfjs.GlobalWorkerOptions.workerSrc = "/api/pdf-worker";
  let task: ReturnType<typeof pdfjs.getDocument> | undefined;
  let failure: unknown;
  const deadline = Date.now() + 30_000;
  const remaining = () => Math.max(1, Math.min(10_000, deadline - Date.now()));
  try {
    task = pdfjs.getDocument({
      // PDF.js transfers ownership to its worker. Never detach the caller's buffer.
      data: new Uint8Array(buffer.slice(0)),
      password,
      useSystemFonts: true,
      stopAtErrors: true,
      verbosity: 0,
    });
    const document = await withTimeout(task.promise, remaining());
    if (document.numPages > MAX_PAGES)
      throw new PayslipImportError("Die PDF-Datei darf höchstens 100 Seiten enthalten.");
    const pages: PayslipPage[] = [];
    let totalText = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      if (Date.now() >= deadline) throw new PayslipImportError("Das Lesen der PDF-Datei hat zu lange gedauert.");
      const page = await withTimeout(document.getPage(pageNumber), remaining());
      try {
        const content = await withTimeout(page.getTextContent(), remaining());
        if (content.items.length > MAX_PAGE_ITEMS)
          throw new PayslipImportError("Eine PDF-Seite enthält zu viele Textelemente.");
        const lines = new Map<number, { y: number; items: PayslipTextItem[] }>();
        let pageText = 0;
        for (const item of content.items) {
          if (!("str" in item)) continue;
          pageText += item.str.length;
          totalText += item.str.length;
          if (pageText > MAX_PAGE_TEXT || totalText > MAX_TEXT)
            throw new PayslipImportError("Die PDF-Datei enthält zu viel Text. Bitte weniger Abrechnungen auf einmal importieren.");
          if (!item.str.trim()) continue;
          const y = item.transform[5];
          const x = item.transform[4];
          if (!Number.isFinite(y) || !Number.isFinite(x))
            throw new PayslipImportError("Die Textpositionen der PDF-Datei sind nicht lesbar.");
          const bucket = Math.round(y / 2);
          let line = [bucket - 1, bucket, bucket + 1].map((key) => lines.get(key))
            .find((candidate) => candidate && Math.abs(candidate.y - y) <= 2);
          if (!line) {
            line = { y, items: [] };
            lines.set(bucket, line);
          }
          line.items.push({ x, width: item.width, text: item.str });
        }
        pages.push({ pageNumber, lines: [...lines.values()] });
      } finally {
        page.cleanup();
      }
    }
    return parsePayslipPages(pages);
  } catch (error) {
    if (error instanceof PayslipImportError || error instanceof PayslipPasswordError) failure = error;
    else if (error && typeof error === "object" && "name" in error && error.name === "PasswordException")
      failure = new PayslipPasswordError("code" in error && error.code === 2 ? "wrong-password" : "password-required");
    else failure = new PayslipImportError("Die PDF-Datei ist beschädigt oder konnte nicht gelesen werden. Bitte die Original-PDF erneut auswählen.");
    throw failure;
  } finally {
    if (task) {
      try {
        await withTimeout(task.destroy(), 2_000);
      } catch {
        // Preserve a useful password/parse error, but never report success after failed cleanup.
        if (!failure) throw new PayslipImportError("Die PDF-Verarbeitung konnte nicht sauber beendet werden. Bitte erneut versuchen.");
      }
    }
  }
}
