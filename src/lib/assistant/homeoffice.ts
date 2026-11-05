import { round } from "@/lib/calc";
import type { Category } from "@/lib/categories";
import { currency } from "@/lib/format";
import { ledger } from "@/lib/insights";
import type { AppState, AssistantCard, Transaction } from "@/lib/types";

// Austrian employee tax assessment (Arbeitnehmerveranlagung), home-office equipment. Sources: BMF "ABC der Werbungskosten",
// BMF FAQ Telearbeitspauschale, § 16 Abs. 1 Z 7a EStG (RIS, in force through 2026), USP tariff steps 2025/2026.
export const WERBUNGSKOSTEN_PAUSCHALE = 132;
export const GWG_LIMIT = 1000;
export const FURNITURE_CAP = 300;
export const FURNITURE_MIN_DAYS = 26;
export const TELEWORK_PER_DAY = 3;
export const TELEWORK_MAX_DAYS = 100;

export type ArticleGroup = "work" | "furniture" | "none";
export type ArticleType = { id: string; label: string; group: ArticleGroup; business: number; years: number; hint: string };

export const articleTypes = [
  { id: "computer", label: "Laptop, PC oder Tablet", group: "work", business: 60, years: 3, hint: "40 % Privatanteil, ab 1.000 € über 3 Jahre" },
  { id: "monitor", label: "Bildschirm", group: "work", business: 60, years: 3, hint: "40 % Privatanteil" },
  { id: "printer", label: "Drucker oder Scanner", group: "work", business: 60, years: 3, hint: "40 % Privatanteil" },
  { id: "accessory", label: "Tastatur, Maus, Headset, Webcam, Dockingstation", group: "work", business: 60, years: 3, hint: "40 % Privatanteil" },
  { id: "phone", label: "Handy", group: "work", business: 60, years: 3, hint: "40 % Privatanteil" },
  { id: "software", label: "Software", group: "work", business: 60, years: 3, hint: "nur beruflicher Anteil" },
  { id: "supplies", label: "Büromaterial (Papier, Toner, Kabel)", group: "work", business: 100, years: 1, hint: "beruflicher Anteil" },
  { id: "literature", label: "Fachliteratur", group: "work", business: 100, years: 1, hint: "nur echte Fachbücher" },
  { id: "desk", label: "Schreibtisch", group: "furniture", business: 100, years: 1, hint: "ergonomisches Mobiliar, max. 300 € pro Jahr" },
  { id: "chair", label: "Bürostuhl", group: "furniture", business: 100, years: 1, hint: "ergonomisches Mobiliar, max. 300 € pro Jahr" },
  { id: "lighting", label: "Schreibtischlampe oder Beleuchtung", group: "furniture", business: 100, years: 1, hint: "ergonomisches Mobiliar, max. 300 € pro Jahr" },
  { id: "other", label: "Sonstiges Arbeitsmittel", group: "work", business: 60, years: 3, hint: "beruflicher Anteil" },
  { id: "private", label: "Privat, nicht absetzbar", group: "none", business: 0, years: 1, hint: "wird nicht berücksichtigt" },
] as const satisfies readonly ArticleType[];
export type ArticleTypeId = typeof articleTypes[number]["id"];
export const articleType = (id: ArticleTypeId): ArticleType => articleTypes.find((item) => item.id === id) ?? articleTypes[articleTypes.length - 1];

const guesses: [RegExp, ArticleTypeId][] = [
  [/bürostuhl|buerostuhl|bürosessel|buerosessel|drehstuhl|drehsessel|gaming.?chair|chefsessel|sitzball/, "chair"],
  [/schreibtisch|stehtisch|desk|tischgestell|höhenverstellbar|hoehenverstellbar/, "desk"],
  [/lampe|leuchte|beleuchtung|led.?panel/, "lighting"],
  [/monitor|bildschirm|display/, "monitor"],
  [/drucker|printer|scanner|toner|tinte|patrone/, "printer"],
  [/tastatur|keyboard|maus\b|mouse|headset|kopfhörer|kopfhoerer|webcam|docking|hub\b|usb.?c/, "accessory"],
  [/laptop|notebook|macbook|thinkpad|surface|ipad|tablet|\bpc\b|computer|imac|mac mini/, "computer"],
  [/iphone|handy|smartphone|galaxy|pixel/, "phone"],
  [/microsoft 365|office 365|adobe|software|lizenz|jetbrains|github/, "software"],
  [/papier|büro|buero|libro|pagro|ordner|kabel/, "supplies"],
  [/fachbuch|fachliteratur|o'?reilly|manning|springer/, "literature"],
];
const searchText = (row: Transaction) => [row.description, row.merchantAlias, row.rawDescription, ...(row.rawDetails ?? [])].filter(Boolean).join(" ").toLowerCase();

export function guessArticle(row: Transaction): ArticleTypeId {
  const text = searchText(row);
  return guesses.find(([pattern]) => pattern.test(text))?.[1] ?? "other";
}

const shopPattern = /amazon|media ?markt|saturn|cyberport|e-?tec|ditech|hartlauer|apple|mcshark|conrad|alza|notebooksbilliger|galaxus|digitec|electronic4you|dell\b|lenovo|\bhp\b|logitech|ikea|xxxlutz|kika|leiner|m(?:ö|oe)max|lutz|libro|pagro|thalia|morawa|microsoft|adobe|samsung/;
const candidateCategories: readonly Category[] = ["Shopping", "Möbel & Einrichtung", "Wohnen & Haushalt", "Bildung", "Weiterbildung"];

// Purchases of the year that may be home-office equipment; the user picks the real ones.
export function homeOfficeCandidates(state: AppState, year: number): Transaction[] {
  return ledger(state).filter(({ row, category }) => row.amount < 0 && row.date.startsWith(String(year)) &&
    (guesses.some(([pattern]) => pattern.test(searchText(row))) || (candidateCategories.includes(category) && shopPattern.test(searchText(row)))))
    .map(({ row }) => row).sort((a, b) => a.amount - b.amount || b.date.localeCompare(a.date));
}

export function yearExpenses(state: AppState, year: number): Transaction[] {
  return ledger(state).filter(({ row }) => row.amount < 0 && row.date.startsWith(String(year))).map(({ row }) => row)
    .sort((a, b) => b.date.localeCompare(a.date));
}

const tariffBounds: Record<number, number[]> = {
  2025: [13308, 21617, 35836, 69166, 103072],
  2026: [13539, 21992, 36458, 70365, 104859],
  2027: [13846, 22491, 37285, 71960, 107236],
};
const tariffRates = [0, 0.2, 0.3, 0.4, 0.48, 0.5, 0.55];
export const tariffYear = (year: number) => Math.min(2027, Math.max(2025, year));

export function incomeTax(income: number, year: number): number {
  const bounds = [...tariffBounds[tariffYear(year)], 1_000_000, Infinity];
  let tax = 0;
  let lower = 0;
  for (const [index, upper] of bounds.entries()) {
    tax += Math.max(0, Math.min(income, upper) - lower) * tariffRates[index];
    lower = upper;
    if (income <= upper) break;
  }
  return tax;
}

export function marginalRate(income: number, year: number): number {
  const bounds = [...tariffBounds[tariffYear(year)], 1_000_000];
  const index = bounds.findIndex((upper) => income <= upper);
  return tariffRates[index < 0 ? tariffRates.length - 1 : index];
}

// Annual taxable income before the Werbungskostenpauschale, estimated from the stored payslips of that year (or the closest year).
export function estimateIncome(state: AppState, year: number): { income: number; year: number; months: number } | undefined {
  const slips = state.payslips ?? [];
  const years = [...new Set(slips.map((slip) => slip.year))].sort((a, b) => Math.abs(a - year) - Math.abs(b - year) || b - a);
  for (const candidate of years) {
    const bases = slips.filter((slip) => slip.year === candidate)
      .map((slip) => slip.monthlyTaxableBase ?? (slip.regularSv !== undefined ? slip.regularGross - slip.regularSv : undefined))
      .filter((value): value is number => value !== undefined && value > 0);
    if (bases.length) return { income: round(bases.reduce((sum, value) => sum + value, 0) / bases.length * 12), year: candidate, months: bases.length };
  }
  return undefined;
}

export type HomeOfficeItem = { id: string; label: string; date: string; price: number; type: ArticleTypeId; business: number };
export type HomeOfficeInput = {
  year: number;
  items: HomeOfficeItem[];
  days: number;
  employerPaid: number;
  otherCosts: number;
  income?: number;
  rate?: number;
};
export type HomeOfficeLine = { id: string; label: string; detail: string; deductible: number; later: number[] };
export type HomeOfficeResult = {
  lines: HomeOfficeLine[];
  work: number;
  furniture: number;
  furnitureCarry: number;
  telework: number;
  werbungskosten: number;
  aboveFlat: number;
  refund: number;
  rate: number;
  warnings: string[];
};

// Deterministic: every number on the result card comes from here.
export function calculateHomeOffice(input: HomeOfficeInput): HomeOfficeResult {
  const warnings: string[] = [];
  const lines: HomeOfficeLine[] = [];
  let work = 0;
  let furnitureSpent = 0;
  for (const item of input.items) {
    const type = articleType(item.type);
    const price = Math.max(0, item.price);
    const share = Math.min(100, Math.max(0, item.business)) / 100;
    if (type.group === "none" || !share) {
      lines.push({ id: item.id, label: item.label, detail: `${type.label} · nicht absetzbar`, deductible: 0, later: [] });
      continue;
    }
    if (type.group === "furniture") {
      furnitureSpent += price;
      lines.push({ id: item.id, label: item.label, detail: `${type.label} · ergonomisches Mobiliar (gemeinsam max. ${currency(FURNITURE_CAP)})`, deductible: 0, later: [] });
      continue;
    }
    const business = round(price * share);
    if (price > GWG_LIMIT && type.years > 1) {
      // Depreciation over the useful life; bought in the second half of the year means half a year now and the rest at the end.
      const yearly = business / type.years;
      const secondHalf = Number(item.date.slice(5, 7)) >= 7;
      const first = round(secondHalf ? yearly / 2 : yearly);
      const later = secondHalf ? [...Array.from({ length: type.years - 1 }, () => round(yearly)), round(business - first - round(yearly) * (type.years - 1))]
        : Array.from({ length: type.years - 1 }, () => round(yearly));
      work += first;
      lines.push({ id: item.id, label: item.label, deductible: first, later,
        detail: `${type.label} · ${Math.round(share * 100)} % beruflich = ${currency(business)} · über ${type.years} Jahre abgeschrieben${secondHalf ? ", Halbjahres-AfA" : ""}` });
    } else {
      work += business;
      lines.push({ id: item.id, label: item.label, deductible: business, later: [],
        detail: `${type.label} · ${Math.round(share * 100)} % beruflich${price > GWG_LIMIT ? "" : ", sofort absetzbar"}` });
    }
  }
  const days = Math.max(0, Math.floor(input.days));
  let furniture = 0;
  let furnitureCarry = 0;
  if (furnitureSpent > 0) {
    if (days >= FURNITURE_MIN_DAYS) {
      furniture = round(Math.min(FURNITURE_CAP, furnitureSpent));
      furnitureCarry = round(furnitureSpent - furniture);
    } else warnings.push(`Ergonomisches Mobiliar zählt erst ab ${FURNITURE_MIN_DAYS} Homeoffice-Tagen im Jahr.`);
  }
  const teleworkDays = Math.min(TELEWORK_MAX_DAYS, days);
  const telework = round(Math.max(0, teleworkDays * TELEWORK_PER_DAY - Math.max(0, input.employerPaid)));
  const otherCosts = Math.max(0, input.otherCosts);
  const werbungskosten = round(work + furniture + telework + otherCosts);
  // The flat 132 € are already in the payroll tax; only costs above it reduce the tax (conservative reading).
  const aboveFlat = round(Math.max(0, werbungskosten - WERBUNGSKOSTEN_PAUSCHALE));
  let refund = 0;
  let rate = input.rate ?? 0;
  if (input.income !== undefined && input.income > 0) {
    const taxable = Math.max(0, input.income - WERBUNGSKOSTEN_PAUSCHALE);
    refund = round(incomeTax(taxable, input.year) - incomeTax(Math.max(0, taxable - aboveFlat), input.year));
    rate = marginalRate(taxable, input.year);
  } else refund = round(aboveFlat * rate);
  if (werbungskosten > 0 && werbungskosten <= WERBUNGSKOSTEN_PAUSCHALE)
    warnings.push(`Deine Werbungskosten liegen unter der Pauschale von ${currency(WERBUNGSKOSTEN_PAUSCHALE)}, die schon automatisch berücksichtigt ist.`);
  if (input.year >= 2027) warnings.push("Ab 2027 ändert sich die Telearbeitspauschale. Bitte die Regeln für 2027 prüfen.");
  return { lines, work: round(work), furniture, furnitureCarry, telework, werbungskosten, aboveFlat, refund, rate, warnings };
}

export function homeOfficeResultCard(input: HomeOfficeInput, result: HomeOfficeResult): { text: string; card: AssistantCard } {
  type Line = AssistantCard["lines"][number];
  const itemLines: Line[] = result.lines.slice(0, 30).map((line) => ({
    label: line.label.slice(0, 200), value: line.deductible, transactionIds: [line.id],
    detail: `${line.detail}${line.later.length ? ` · später noch ${line.later.map((value) => currency(value)).join(", ")}` : ""}`.slice(0, 300),
    tone: line.deductible > 0 ? "good" as const : "info" as const,
  }));
  const summary: Line[] = [
    ...(result.furniture || result.furnitureCarry ? [{ label: "Ergonomisches Mobiliar", value: result.furniture,
      detail: result.furnitureCarry ? `${currency(result.furnitureCarry)} darüber gehen in die nächsten Jahre (je max. ${currency(FURNITURE_CAP)})` : `max. ${currency(FURNITURE_CAP)} pro Jahr` }] : []),
    ...(result.telework ? [{ label: "Telearbeitspauschale (Differenz)", value: result.telework,
      detail: `${Math.min(TELEWORK_MAX_DAYS, input.days)} Tage × ${currency(TELEWORK_PER_DAY)} minus ${currency(input.employerPaid)} vom Arbeitgeber` }] : []),
    ...(input.otherCosts ? [{ label: "Sonstige Werbungskosten", value: round(input.otherCosts) }] : []),
    { label: "Werbungskosten gesamt", value: result.werbungskosten },
    { label: "Abzüglich Werbungskostenpauschale", value: -WERBUNGSKOSTEN_PAUSCHALE, detail: "ist schon in der Lohnsteuer berücksichtigt" },
    { label: "Wirkt steuerlich", value: result.aboveFlat },
    { label: "Geschätzte Erstattung", value: result.refund, tone: result.refund > 0 ? "good" as const : "warn" as const,
      detail: input.income ? `Tarif ${tariffYear(input.year)}, Einkommen ${currency(input.income)}, Grenzsteuersatz ${Math.round(result.rate * 100)} %`
        : `Grenzsteuersatz ${Math.round(result.rate * 100)} %` },
    ...result.warnings.map((warning) => ({ label: warning.slice(0, 200), tone: "warn" as const })),
  ];
  const ids = result.lines.map((line) => line.id).slice(0, 50);
  return {
    text: result.refund > 0
      ? `Für ${input.year} bekommst du für deine Home-Office-Sachen voraussichtlich etwa ${currency(result.refund)} zurück. Absetzbar sind ${currency(result.werbungskosten)}, davon wirken ${currency(result.aboveFlat)} über der Pauschale von ${currency(WERBUNGSKOSTEN_PAUSCHALE)}.`
      : `Für ${input.year} ergibt sich keine Erstattung: Die absetzbaren ${currency(result.werbungskosten)} liegen nicht über der Pauschale von ${currency(WERBUNGSKOSTEN_PAUSCHALE)}${input.income || input.rate ? "" : " oder es fehlt das Einkommen"}.`,
    card: { kind: "homeoffice_result", title: `Home-Office ${input.year} · Erstattung`, total: result.refund, year: input.year,
      lines: [...itemLines, ...summary].slice(0, 40), transactionIds: ids,
      note: "Ohne Gewähr, keine Steuerberatung. Belege aufheben. PC, Bildschirm und Tastatur zusammen gekauft gelten als eine Einheit. Die Erstattung kann durch andere Posten, Absetzbeträge oder die Negativsteuer abweichen." },
  };
}

// Opens the interactive selection in the chat.
export function homeOfficeStart(state: AppState, year: number): { text: string; card: AssistantCard } {
  const candidates = homeOfficeCandidates(state, year);
  return {
    text: candidates.length
      ? `Ich habe ${candidates.length} ${candidates.length === 1 ? "Kauf" : "Käufe"} aus ${year} gefunden, die Home-Office-Sachen sein könnten. Wähl aus, was dazugehört, und sag mir bei jedem, was es war. Dann rechne ich aus, was du zurückbekommst.`
      : `Für ${year} habe ich keine typischen Home-Office-Käufe gefunden. Du kannst unten alle Ausgaben aus ${year} durchsuchen und die richtigen auswählen.`,
    card: { kind: "homeoffice", title: `Home-Office-Rechner ${year}`, year, lines: [],
      note: "Ohne Gewähr, keine Steuerberatung. Gerechnet wird mit 40 % Privatanteil bei Geräten, 300 € für ergonomisches Mobiliar ab 26 Homeoffice-Tagen und der Werbungskostenpauschale von 132 €." },
  };
}
