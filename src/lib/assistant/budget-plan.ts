import { currency } from "@/lib/format";
import type { AppState, AssistantOperation } from "@/lib/types";
import { defaultBudgetAmount, variableBudgetLines, type VariableBudgetId } from "@/lib/variable-budgets";
import { parseAmount } from "./intent";

// Everyday words for the monthly budget lines ("Spritbudget", "Essen gehen", "Supermarkt").
const aliases: [VariableBudgetId, RegExp][] = [
  // "Essen" alone is the groceries line; "Mittagessen" and "essen gehen" are their own lines.
  ["food", /lebensmit+e?l|haushalt|supermarkt|einkäufe|einkaeufe|einkaufen|groceries|(?<![a-zäöüß])essen(?!\s*gehen|gehen)/g],
  ["lunch", /mittag/g],
  ["fuel", /tank|sprit|benzin|diesel/g],
  ["leisure", /freizeit|hobb(?:y|ies)/g],
  ["going-out", /restaurant|liefer|ausgehen|auswärts|auswaerts|essen gehen|essengehen|take-?away/g],
  ["gifts", /geschenk|spende/g],
  ["buffer", /puffer/g],
];

const budgetWord = /budget|\bplan\b|\bplans\b|planwert|\blimit\b|\brahmen\b|monatlich|pro monat|im monat/;
const moveWord = /umschicht|umverteil|umbuch|verschieb|\bschieb|\bnimm\b|übertrag|uebertrag|\bschicht\w*\b.{0,60}\bum\b|\bpack\w*\b.{0,40}\bvon\b/;
const upWord = /erhöh|erhoeh|erhö(?=\s|$)|\bmehr\b|rauf|hochsetz|hochstell|hochschraub|aufstock|\bplus\b|dazu/;
const downWord = /senk|reduzier|kürz|kuerz|weniger|runter|verringer|\bminus\b/;
const resetWord = /zurücksetz|zuruecksetz|zurück auf|standard|ursprünglich|urspruenglich|wieder normal|wie vorher|\bsetz\w*\b.{0,50}\bzurück\b|\bstell\w*\b.{0,50}\bzurück\b/;
const changeWord = new RegExp([upWord.source, downWord.source, resetWord.source, moveWord.source,
  "anpass|ändern|aender|änder|setz|stell|\\bauf\\s+\\d|\\bum\\s+\\d"].join("|"));
// "mach das Spritbudget 220", "Lebensmittelbudget soll 300 sein".
const setWord = /\b(?:mach|soll|sollen|stell|setz|neu|ändere?|aendere?)\b/;

/** Budget lines in the order they are mentioned. */
export function budgetLinesIn(lower: string): { id: VariableBudgetId; index: number }[] {
  const found: { id: VariableBudgetId; index: number }[] = [];
  for (const [id, pattern] of aliases) {
    const first = [...lower.matchAll(pattern)][0];
    if (first?.index !== undefined) found.push({ id, index: first.index });
  }
  return found.sort((a, b) => a.index - b.index);
}

/** "Plan für Lebensmittel um 295 € erhöhen", "Tankbudget auf 200", "50 € von Freizeit zu Restaurants umschichten". */
// "Budget für Einhörner auf 100", "Kinobudget auf 50": a budget that does not exist, answered with the lines that do.
const unknownBudget = /\bbudget\s+(?:für|fuer|von)\s+([\p{L}][\p{L}-]{1,30})\b.{0,30}\b(?:auf|um)\s+-?\d|\b([\p{L}]{3,30})budget\b.{0,30}\b(?:auf|um)\s+-?\d/u;
const moveSides = /\b(?:von|vom|aus)\b.{1,40}\b(?:zu|zum|zur|nach|in|ins|auf)\b/;

export function budgetPlanRequest(lower: string, known = false): boolean {
  const lines = budgetLinesIn(lower);
  if (!lines.length) return !known && unknownBudget.test(lower) && !/\?\s*$/.test(lower) && !/sparziel|\bziel\b|\brate\b/.test(lower);
  const budget = budgetWord.test(lower);
  // "Puffer 300" is the remembered Giro buffer, "Giro Puffer"/"Pufferbudget" the budget line.
  if (lines.length === 1 && lines[0].id === "buffer" && !budget && !/giro[\s-]*puffer/.test(lower)) return false;
  if (/ausgegeben|bezahlt|gezahlt|gekauft|verbraucht|kostet|leisten|leistbar|geht sich|reicht/.test(lower)) return false;
  if (lines.length >= 2 && moveWord.test(lower) && /\d/.test(lower)) return true;
  if (moveWord.test(lower) && moveSides.test(lower) && /\d/.test(lower) && !known) return true;
  if (budget && /\d/.test(lower) && setWord.test(lower)) return true;
  // "Lebensmittel Budget 450", "Tankbudget 200 €".
  if (budget && /\d\s*(?:€|euro)?\s*[.!]?$/.test(lower) && lower.split(/\s+/).length <= 5 && !/\?/.test(lower)) return true;
  if (!changeWord.test(lower)) return false;
  if (budget) return true;
  // Without the word "Budget" only a clear command with an amount: "Tanken um 50 erhöhen".
  return !known && /\d/.test(lower) && !/\?\s*$/.test(lower) && !/sparziel|\bziel\b|\brate\b/.test(lower);
}

function amountIn(text: string): number | undefined {
  for (const match of text.matchAll(/(?<![\d.,])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?![\d,]|\.\d)/g)) {
    const after = text.slice((match.index ?? 0) + match[0].length);
    if (/^\s*\.?\s*(?:jänner|januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|monat)/.test(after)) continue;
    const value = parseAmount(`${match[1]}${match[2] ? `,${match[2]}` : ""}`);
    if (value !== undefined && value > 0) return value;
  }
  return undefined;
}

const lineOf = (id: VariableBudgetId) => variableBudgetLines.find((line) => line.id === id)!;

export type BudgetPlanParse = { operations: AssistantOperation[]; title: string } | { text: string; suggestions?: string[] };

export function parseBudgetPlan(state: AppState, input: string, asOf: string): BudgetPlanParse {
  const lower = input.toLowerCase();
  const month = asOf.slice(0, 7);
  const lines = budgetLinesIn(lower);
  const adjustments = state.budgetAdjustments ?? {};
  const base = (id: VariableBudgetId) => defaultBudgetAmount(lineOf(id), month, state.holidayRanges ?? []);
  const current = (id: VariableBudgetId) => Math.max(0, base(id) + (adjustments[id] ?? 0));
  const names = variableBudgetLines.map((line) => line.label).join(", ");
  if (/(?:\bauf|=)\s*(?:-|−|minus\s*)\s*\d/.test(lower)) return { text: "Ein Budget kann nicht negativ sein. Auf welchen Betrag ab 0 € soll ich es setzen?" };
  if (!lines.length) {
    const unknown = unknownBudget.exec(lower);
    const name = unknown ? (unknown[1] ?? unknown[2]) : undefined;
    const label = name ? name.charAt(0).toUpperCase() + name.slice(1) : undefined;
    const value = amountIn(lower);
    if (label) return { text: `Ein Budget „${label}“ gibt es nicht – Budgets gibt es für ${names}. Soll ich „${label}“ als eigene Position im Monatsplan anlegen?`,
      suggestions: [`Füg eine Position „${label}“ hinzu, variabel${value ? `, ${value.toLocaleString("de-DE")} € monatlich` : ""}`, "Wie steht mein Budget?"] };
    return { text: `Welches Budget soll ich ändern? Budgets gibt es für ${names}.`,
      suggestions: ["Budget Lebensmittel um 50 € erhöhen", "Tankbudget auf 200 € setzen"] };
  }
  const amount = amountIn(lower);
  const first = lineOf(lines[0].id);

  if (lines.length >= 2 && (moveWord.test(lower) || /\bvon\b.*\b(?:zu|nach|für|fuer|in|auf)\b/.test(lower))) {
    const before = (index: number) => lower.slice(Math.max(0, index - 30), index);
    const from = lines.find((line) => /\b(?:von|vom|aus|bei|weg)\b[^\d]{0,25}$/.test(before(line.index))) ?? lines[0];
    const to = lines.find((line) => line !== from) ?? lines[1];
    const giver = lineOf(from.id), taker = lineOf(to.id);
    if (!amount) return { text: `Wie viel soll ich von ${giver.label} zu ${taker.label} umschichten?` };
    if (from.id === to.id) return { text: `Von ${giver.label} zu ${taker.label} ist dasselbe Budget. Wohin soll das Geld?` };
    if (amount > current(from.id)) return { text: `${giver.label} hat nur ${currency(current(from.id))} im Monat – so viel kann ich nicht umschichten.` };
    return {
      title: `${currency(amount)} von ${giver.label} zu ${taker.label} umschichten`,
      operations: [
        { op: "budget_plan", line: from.id, adjustment: (adjustments[from.id] ?? 0) - amount },
        { op: "budget_plan", line: to.id, adjustment: (adjustments[to.id] ?? 0) + amount },
      ],
    };
  }

  // "Verschieb 50 € von Freizeit nach Urlaub": only one side is a budget, so nothing is guessed.
  if (moveWord.test(lower) && moveSides.test(lower)) {
    const other = /\b(?:zu|zum|zur|nach|in|ins|auf|von|vom|aus)\s+(?:das\s+|die\s+|den\s+|dem\s+)?([\p{L}][\p{L}-]{2,30})/gu;
    const outside = [...lower.matchAll(other)].map((match) => match[1]).find((word) => !budgetLinesIn(word).length && !/^(?:budget|monat|jänner|januar|dezember|november)/.test(word));
    return { text: `${outside ? `„${outside.charAt(0).toUpperCase() + outside.slice(1)}“ ist kein Budget. ` : ""}Umschichten kann ich zwischen zwei Budgets (${names}) – oder zwischen zwei Positionen im Monatsplan für einen bestimmten Monat, z. B. „Verschieb 50 € von Freizeit zu Restaurants“.` };
  }
  if (resetWord.test(lower)) {
    if (!adjustments[first.id]) return { text: `${first.label} steht schon auf dem Standard von ${currency(base(first.id))} im Monat.` };
    return { title: `Budget ${first.label} auf Standard zurücksetzen`, operations: [{ op: "budget_plan", line: first.id, adjustment: 0 }] };
  }
  if (!amount) return { text: `Um wie viel soll ich das Budget für ${first.label} ändern? Aktuell: ${currency(current(first.id))} im Monat.`,
    suggestions: [`${first.label} um 50 € erhöhen`, `${first.label} um 50 € senken`] };
  const down = downWord.test(lower), up = upWord.test(lower), by = /\bum\s+(?:€\s*)?\d/.test(lower);
  const absolute = /\bauf\s+(?:€\s*)?\d/.test(lower) && !by || !up && !down && !by;
  if (absolute) return {
    title: `Budget ${first.label} auf ${currency(amount)} setzen`,
    operations: [{ op: "budget_plan", line: first.id, adjustment: Math.round((amount - base(first.id)) * 100) / 100 }],
  };
  if (down === up) return { text: `Soll ich das Budget für ${first.label} um ${currency(amount)} erhöhen oder senken?`,
    suggestions: [`${first.label} um ${amount} € erhöhen`, `${first.label} um ${amount} € senken`] };
  const delta = down ? -amount : amount;
  return {
    title: `Budget ${first.label} um ${currency(amount)} ${down ? "senken" : "erhöhen"}`,
    operations: [{ op: "budget_plan", line: first.id, adjustment: Math.round(((adjustments[first.id] ?? 0) + delta) * 100) / 100 }],
  };
}
