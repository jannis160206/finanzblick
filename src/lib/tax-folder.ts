import type { Category } from "@/lib/categories";
import { round } from "@/lib/calc";
import { ledger } from "@/lib/insights";
import type { AppState, Transaction } from "@/lib/types";

// Kennzahlen of the Austrian L1 form (Arbeitnehmerveranlagung). `verified: false` marks numbers that
// change between form years more often; the UI asks to check them in FinanzOnline.
export type TaxGroupId = "union" | "equipment" | "literature" | "travel" | "training" | "other" | "homeoffice" | "donation" | "church" | "advisor" | "medical";
export type TaxGroupDefinition = {
  id: TaxGroupId; kz?: string; verified: boolean; label: string; section: "Werbungskosten" | "Sonderausgaben" | "Außergewöhnliche Belastungen";
  detail: string; hint: string; test: (text: string, category: Category) => boolean;
};

export const TAX_FOLDER_NOTE = "Ohne Gewähr, keine Steuerberatung. Belege 7 Jahre aufheben.";

export const taxGroupDefinitions: TaxGroupDefinition[] = [
  { id: "donation", kz: undefined, verified: true, label: "Spenden", section: "Sonderausgaben",
    detail: "Sonderausgabe, wird von begünstigten Organisationen meist automatisch gemeldet",
    hint: "Meist automatisch übermittelt – nur prüfen, ob die Organisation dein Geburtsdatum hat.",
    test: (text, category) => /spende|caritas|rotes kreuz|ärzte ohne grenzen|aerzte ohne grenzen|unicef|greenpeace|wwf|diakonie|licht ins dunkel|volkshilfe|hilfswerk|sos.?kinderdorf|amnesty|tierschutz|vier pfoten/.test(text) ||
      (category === "Geschenke & Spenden" && /spende/.test(text)) },
  { id: "church", kz: undefined, verified: true, label: "Kirchenbeitrag", section: "Sonderausgaben",
    detail: "Sonderausgabe bis 600 € pro Jahr, wird automatisch gemeldet",
    hint: "Wird automatisch übermittelt; Zahlungsbestätigung trotzdem aufheben.",
    test: (text) => /kirchenbeitrag|diözese|dioezese|erzdiözese|kirchenbeitragsstelle|evangelische kirche/.test(text) },
  { id: "union", kz: "717", verified: true, label: "Gewerkschaft & Berufsverband", section: "Werbungskosten",
    detail: "Werbungskosten, sofern nicht schon über den Lohnzettel abgezogen",
    hint: "Prüfe am Lohnzettel, ob der Beitrag schon vom Arbeitgeber berücksichtigt wurde.",
    test: (text) => /gewerkschaft|\bögb\b|\boegb\b|\bgpa\b|\bgöd\b|\bvida\b|younion|berufsverband|kammerumlage/.test(text) },
  { id: "homeoffice", kz: "158", verified: false, label: "Home-Office-Mobiliar", section: "Werbungskosten",
    detail: "Ergonomisches Mobiliar (Schreibtisch, Bürosessel, Beleuchtung), gedeckelt; Homeoffice-Pauschale separat",
    hint: "Rechnung mit Artikelbezeichnung aufheben; Höchstbetrag pro Jahr beachten.",
    test: (text) => /bürosessel|buerosessel|bürostuhl|buerostuhl|schreibtisch|schreibtischlampe|stehtisch/.test(text) },
  { id: "equipment", kz: "719", verified: true, label: "Arbeitsmittel", section: "Werbungskosten",
    detail: "Werbungskosten, nur der beruflich genutzte Anteil; ab 1.000 € über die Nutzungsdauer verteilt",
    hint: "Rechnung aufheben; privaten Nutzungsanteil abziehen.",
    test: (text) => /laptop|notebook|macbook|monitor|bildschirm|computer|\bpc\b|drucker|headset|tastatur|dockingstation|arbeitskleidung|werkzeug/.test(text) },
  { id: "literature", kz: "720", verified: true, label: "Fachliteratur", section: "Werbungskosten",
    detail: "Werbungskosten, nur berufsbezogene Fachbücher und -zeitschriften",
    hint: "Rechnung mit Buchtitel aufheben – allgemeine Literatur zählt nicht.",
    test: (text, category) => (category === "Weiterbildung" || category === "Bildung") && /fachbuch|fachliteratur|fachzeitschrift/.test(text) },
  { id: "training", kz: "722", verified: true, label: "Aus- und Fortbildung", section: "Werbungskosten",
    detail: "Werbungskosten, wenn beruflich veranlasst",
    hint: "Rechnung und Kursbestätigung aufheben; Förderungen abziehen.",
    test: (text, category) => (category === "Weiterbildung" || category === "Bildung") &&
      /kurs|seminar|schulung|fortbildung|weiterbildung|udemy|coursera|\bwifi\b|\bbfi\b|zertifi|prüfung|pruefung|linkedin learning|pluralsight/.test(text) },
  { id: "travel", kz: "721", verified: true, label: "Reisekosten", section: "Werbungskosten",
    detail: "Beruflich veranlasste Reisen, abzüglich Ersatz durch den Arbeitgeber",
    hint: "Reiseanlass und Ersatz vom Arbeitgeber notieren.",
    test: (text) => /dienstreise|geschäftsreise|geschaeftsreise/.test(text) },
  { id: "other", kz: "724", verified: true, label: "Sonstige Werbungskosten", section: "Werbungskosten",
    detail: "z. B. Bewerbungskosten, beruflich veranlasst",
    hint: "Beruflichen Zusammenhang dokumentieren.",
    test: (text) => /bewerbungsfoto|bewerbungsmappe|stellenanzeige|karriere\.at/.test(text) },
  { id: "advisor", kz: "460", verified: false, label: "Steuerberatung", section: "Sonderausgaben",
    detail: "Steuerberatungskosten, wenn an berufsrechtlich befugte Personen bezahlt",
    hint: "Honorarnote aufheben.",
    test: (text) => /steuerberat|wirtschaftstreuh|lohnsteuerhilfe/.test(text) },
  { id: "medical", kz: "730", verified: false, label: "Krankheitskosten", section: "Außergewöhnliche Belastungen",
    detail: "Außergewöhnliche Belastung, wirkt erst über dem Selbstbehalt",
    hint: "Rechnungen, Rezepte und Kostenerstattungen der Krankenkasse aufheben.",
    test: (text, category) => category === "Gesundheit" && /arzt|ärztin|zahn|apotheke|optiker|brille|kontaktlinse|physio|therap|krankenhaus|klinik|kieferorth|hörgerät|labor/.test(text) },
];

export type TaxFolderRow = { id: string; date: string; merchant: string; amount: number; category: Category; hint?: string };
export type TaxFolderGroup = Omit<TaxGroupDefinition, "test"> & { total: number; count: number; rows: TaxFolderRow[]; missing: number };
export type TaxFolder = { year: number; total: number; count: number; groups: TaxFolderGroup[]; note: string };

const searchText = (row: Transaction) =>
  [row.description, row.merchantAlias, row.rawDescription, ...(row.rawDetails ?? [])].filter(Boolean).join(" ").toLowerCase();
const merchantOf = (row: Transaction) => row.merchantAlias?.trim() || row.description.trim().slice(0, 80);

export function kzLabel(group: Pick<TaxGroupDefinition, "kz" | "verified">) {
  if (!group.kz) return "automatisch";
  return `KZ ${group.kz}${group.verified ? "" : " (bitte prüfen)"}`;
}

// Hints for bookings whose receipt is usually needed but not visible from a card payment alone.
function receiptHint(group: TaxGroupDefinition, row: Transaction, amount: number) {
  const text = searchText(row);
  if (group.id === "equipment" && amount >= 1000) return "Über 1.000 €: über die Nutzungsdauer abschreiben (AfA).";
  if (/amazon|amzn|paypal|klarna/.test(text)) return "Rechnung im Online-Konto herunterladen – Kontoauszug reicht nicht.";
  if (group.id !== "donation" && group.id !== "church" && amount >= 50) return "Beleg aufheben";
  return undefined;
}

// Yearly folder of possibly deductible bookings, grouped by L1 Kennzahl. Pure, all amounts computed here.
export function taxFolder(state: AppState, year: number): TaxFolder {
  const groups = taxGroupDefinitions.map((group) => ({ group, rows: [] as TaxFolderRow[] }));
  for (const { row, category } of ledger(state)) {
    if (row.amount >= 0 || !row.date.startsWith(String(year))) continue;
    const text = searchText(row);
    const target = groups.find((item) => item.group.test(text, category));
    if (!target) continue;
    const amount = round(-row.amount);
    const hint = receiptHint(target.group, row, amount);
    target.rows.push({ id: row.id, date: row.date, merchant: merchantOf(row), amount, category, ...(hint ? { hint } : {}) });
  }
  const result: TaxFolderGroup[] = groups.filter((item) => item.rows.length).map(({ group, rows }) => {
    const { test: _test, ...definition } = group;
    void _test;
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    return { ...definition, rows: sorted, count: sorted.length, total: round(sorted.reduce((sum, row) => sum + row.amount, 0)), missing: sorted.filter((row) => row.hint).length };
  });
  return {
    year, groups: result, count: result.reduce((sum, group) => sum + group.count, 0),
    total: round(result.reduce((sum, group) => sum + group.total, 0)), note: TAX_FOLDER_NOTE,
  };
}

const csvCell = (value: string) => /[";\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
const decimal = (value: number) => value.toFixed(2).replace(".", ",");
// Spreadsheet formula injection guard for merchant names from bank statements.
const safe = (value: string) => /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;

export function taxFolderCsv(folder: TaxFolder): string {
  const header = ["Datum", "Händler", "Betrag (EUR)", "Kategorie", "Gruppe", "Kennzahl", "Bereich", "Hinweis"];
  const lines = folder.groups.flatMap((group) => group.rows.map((row) => [
    row.date, safe(row.merchant), decimal(row.amount), row.category, group.label, kzLabel(group), group.section, row.hint ?? "",
  ]));
  return `\uFEFF${[header, ...lines].map((line) => line.map(csvCell).join(";")).join("\r\n")}\r\n`;
}

const html = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const euro = (value: number) => new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(value);
const day = (date: string) => date.split("-").reverse().join(".");

// Standalone printable page (no scripts, no external resources).
export function taxFolderHtml(folder: TaxFolder): string {
  const sections = folder.groups.map((group) => `<section><h2>${html(kzLabel(group))} · ${html(group.label)} <small>(${html(group.section)})</small></h2>
<p>${html(group.detail)}. ${html(group.hint)}</p>
<table><thead><tr><th>Datum</th><th>Händler</th><th>Kategorie</th><th class="r">Betrag</th><th>Hinweis</th></tr></thead><tbody>
${group.rows.map((row) => `<tr><td>${day(row.date)}</td><td>${html(row.merchant)}</td><td>${html(row.category)}</td><td class="r">${euro(row.amount)}</td><td>${html(row.hint ?? "")}</td></tr>`).join("\n")}
</tbody><tfoot><tr><th colspan="3">Summe (${group.count} ${group.count === 1 ? "Beleg" : "Belege"})</th><th class="r">${euro(group.total)}</th><th></th></tr></tfoot></table></section>`).join("\n");
  return `<!doctype html><html lang="de-AT"><head><meta charset="utf-8"><title>Steuer-Mappe ${folder.year}</title>
<style>body{font:14px system-ui,sans-serif;margin:2rem;color:#111}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}th,td{border-bottom:1px solid #ccc;padding:.3rem .4rem;text-align:left}.r{text-align:right}small{color:#555;font-weight:normal}p{color:#333}</style></head>
<body><h1>Steuer-Mappe ${folder.year} · Arbeitnehmerveranlagung</h1>
<p>${folder.count} ${folder.count === 1 ? "Buchung" : "Buchungen"}, zusammen ${euro(folder.total)}. ${html(folder.note)}</p>
${sections || "<p>Keine passenden Buchungen gefunden.</p>"}
<p><small>Homeoffice-Pauschale, Pendlerpauschale und Familienbonus stehen nicht in den Umsätzen und fehlen hier.</small></p></body></html>`;
}

export function downloadTaxFolder(folder: TaxFolder, format: "csv" | "html") {
  const content = format === "csv" ? taxFolderCsv(folder) : taxFolderHtml(folder);
  const url = URL.createObjectURL(new Blob([content], { type: format === "csv" ? "text/csv;charset=utf-8" : "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `Finanzblick_Steuer-Mappe_${folder.year}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
