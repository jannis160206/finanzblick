import { currency, monthLabel } from "@/lib/format";
import { planningMonths } from "@/lib/planning-range";
import { variableBudgetLineId, variableBudgetLines } from "@/lib/variable-budgets";
import type { AppState, AssistantOperation, FinanceRow } from "@/lib/types";
import { findCategories } from "./answers";
import { addMonth, parseAmount, parseAssistantMessage } from "./intent";
import { matchName, rowWord } from "./tools";

/**
 * Positions of the month plan, like "Position hinzufügen/bearbeiten/löschen" and the plan grid:
 * "Füg eine Position Fitnessstudio (Fixkosten, 39,90 € ab Oktober) hinzu", "Setz die Miete im Dezember auf 700 €".
 */
// sure: the positions were identified, so the answer is final even without a change ("hat nur 200 €").
export type PlanRowPlan = { operations: AssistantOperation[]; title: string; note?: string } | { text: string; choices?: string[]; sure?: boolean };

// Budget lines (Tanken, Lebensmittel …) are variable rows the app recomputes from one amount per month; single months cannot be set.
const budgetLine = (row: FinanceRow) => row.kind === "variable" ? variableBudgetLines.find((line) => line.id === variableBudgetLineId(row)) : undefined;
const budgetOnly = (row: FinanceRow, amount?: number): PlanRowPlan => {
  const line = budgetLine(row);
  const label = line?.label ?? row.label;
  return { text: `„${label}“ ist ein Budget und gilt für jeden Monat gleich – einzelne Monate setze ich dort nicht.${amount !== undefined ? ` Soll ich das Budget ab sofort auf ${currency(amount)} setzen?` : ""}`,
    ...(amount !== undefined ? { choices: [`Setz das Budget ${label} auf ${amount.toLocaleString("de-DE")} €`] } : {}), sure: true };
};

const kindIn = (lower: string): FinanceRow["kind"] | undefined =>
  /\beinnahme\w*|\beinkommen\b|\beinkünfte\b/.test(lower) ? "income" : /\bvariabel\w*|\bbudget\w*/.test(lower) ? "variable" : /\bfix(?:e|kosten)?\w*/.test(lower) ? "fixed" : undefined;

function amountOf(text: string): number | undefined {
  const match = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:€|euro|eur\b)/i.exec(text) ?? /\bauf\s+(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?![.\d])/i.exec(text);
  return match ? parseAmount(`${match[1]}${match[2] ? `,${match[2]}` : ""}`) : undefined;
}

// "im Dezember" is one month, "ab Jänner" every planned month from then on, "von März bis Juni" the span.
function monthsIn(text: string, asOf: string): string[] | undefined {
  const lower = text.toLowerCase();
  const all = planningMonths(asOf);
  const parsed = parseAssistantMessage(text.replace(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?\s*(?:€|euro|eur\b)/gi, " "), asOf);
  if (/\b(?:jeden monat|monatlich|pro monat|im monat|ab jetzt|künftig|kuenftig|immer)\b/.test(lower) && !parsed.date) return all.filter((month) => month >= asOf.slice(0, 7));
  if (!parsed.date) return undefined;
  const start = parsed.date.month;
  const span = /\bbis\s+(?:ende\s+)?(jänner|januar|feber|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\b/.exec(lower);
  if (span && /\b(?:von|ab)\b/.test(lower)) {
    const end = parseAssistantMessage(span[0], start > asOf ? `${start}-01` : asOf).date?.month;
    if (end && end >= start) return all.filter((month) => month >= start && month <= end);
  }
  if (/\bab\b|\bseit\b/.test(lower)) return all.filter((month) => month >= start);
  return all.includes(start) ? [start] : undefined;
}

const rowWords = /\b(?:(?:plan|monatsplan)-?)?position\b|\b(?:plan|budget|monatsplan)-?(?:zeile|posten)\b/gi;
const quotedOrAfter = (text: string) =>
  /[„"]([^“"]{1,100})[“"]/.exec(text)?.[1] ??
  /\b(?:(?:plan|monatsplan)-?position|position|(?:plan|budget|monatsplan)-?(?:zeile|posten))\s+(?:namens\s+|für\s+|fuer\s+)?([\p{L}][\p{L}\p{N}&.' -]{0,60}?)(?=\s*(?:$|[,.(!?\d]|\s(?:mit|als|im|ab|für|fuer|hinzu|an|ein|auf|in|zu|um|monatlich|variabel|fix\w*|gehört|gehoert|ist|soll|kategorie)\b))/iu.exec(text)?.[1];
const moveWords = /umschicht|umverteil|umbuch|verschieb|\bschieb|übertrag|uebertrag|\bschicht\w*\b.{0,60}\bum\b/;

// "Verschieb im Dezember 100 € von Geschenke zu Urlaub": two positions of the month plan, month by month.
function moveBetween(state: AppState, text: string, lower: string, asOf: string): PlanRowPlan | undefined {
  const rows = state.financeRows;
  const split = /\b(?:zu|zum|zur|nach|in|ins|auf)\s+(?:die\s+|den\s+|das\s+|der\s+)?(?:position\s+)?(?=\p{L})/iu.exec(text.slice(Math.max(0, lower.search(/\b(?:von|vom|aus)\b/))));
  if (!split) return undefined;
  const start = Math.max(0, lower.search(/\b(?:von|vom|aus)\b/));
  const fromText = text.slice(start, start + split.index);
  const toText = text.slice(start + split.index);
  const from = matchName(fromText.replace(rowWords, " "), rows, (item) => item.label);
  if (!from) return undefined;
  const to = matchName(toText.replace(rowWords, " "), rows.filter((item) => item.id !== from.id), (item) => item.label);
  const amount = amountOf(text) ?? parseAmount(/(?<![\d.,])(\d{1,6}(?:,\d{1,2})?)(?!\s*\.|\d)/.exec(text.replace(/\b\d{1,2}\.\s?\d{1,2}\.(?:\d{2,4})?/g, " "))?.[1] ?? "");
  const list = rows.filter((item) => item.id !== from.id).slice(0, 6).map((item) => `„${item.label}“`).join(", ");
  if (!to) return { text: `Wohin soll das Geld von „${from.label}“? Im Monatsplan gibt es ${list || "keine weitere Position"}.` };
  if (!amount) return { text: `Wie viel soll ich von „${from.label}“ zu „${to.label}“ verschieben?`, sure: true };
  const months = monthsIn(text, asOf);
  if (!months?.length) return { text: `Für welchen Monat soll ich ${currency(amount)} von „${from.label}“ zu „${to.label}“ verschieben? Zum Beispiel „im Dezember“.`, sure: true };
  if (months.length > 12) return { text: "Das sind zu viele Monate auf einmal. Bitte nenn einen Monat oder einen Zeitraum bis zu einem Jahr.", sure: true };
  const lines = [from, to].map(budgetLine);
  if (lines[0] && lines[1]) return { text: `„${lines[0].label}“ und „${lines[1].label}“ sind Budgets und gelten für jeden Monat gleich. Umschichten kann ich sie ab sofort.`,
    choices: [`Verschieb ${amount.toLocaleString("de-DE")} € von ${lines[0].label} zu ${lines[1].label}`], sure: true };
  if (lines[0] || lines[1]) return budgetOnly(lines[0] ? from : to);
  const short = months.find((month) => (from.values[month] ?? 0) < amount);
  if (short) return { text: `In ${monthLabel(short)} hat „${from.label}“ nur ${currency(from.values[short] ?? 0)} – so viel kann ich nicht verschieben.`, sure: true };
  const operations: AssistantOperation[] = months.flatMap((month) => [
    { op: "plan_value" as const, rowId: from.id, months: [month], value: Math.round(((from.values[month] ?? 0) - amount) * 100) / 100 },
    { op: "plan_value" as const, rowId: to.id, months: [month], value: Math.round(((to.values[month] ?? 0) + amount) * 100) / 100 },
  ]);
  return { operations, title: `${currency(amount)} von „${from.label}“ zu „${to.label}“ verschieben` };
}

export function planRowAction(state: AppState, text: string, asOf: string): PlanRowPlan | undefined {
  const lower = text.toLowerCase();
  const rows = state.financeRows;
  const create = /\b(?:füg|fueg|leg|trag|erstell|nimm)\w*\b.*(?:\bposition\b|zeile\b|posten\b)|\bneue[nrs]?\s+(?:plan|budget|monatsplan)?-?(?:position|zeile|posten)\b|(?:\bposition\b|zeile\b|posten\b).*\b(?:hinzu|anlegen|eintragen|erstellen)\b/.test(lower) &&
    rowWord.test(lower);
  if (create) {
    const label = quotedOrAfter(text)?.trim();
    if (!label) return { text: "Wie soll die neue Position im Monatsplan heißen? Zum Beispiel „Füg eine Position Fitnessstudio hinzu“." };
    // "Leg eine Position Geschenke an" while "Geschenke & Spenden" is a budget: that budget is meant.
    const line = variableBudgetLines.find((item) => item.pattern.test(label) || item.label.toLowerCase().startsWith(label.toLowerCase()));
    if (line) {
      const value = amountOf(text);
      return { text: `„${line.label}“ gibt es schon als Budget. Soll ich das Budget ändern${value !== undefined ? ` – auf ${currency(value)} im Monat` : ""}?`,
        choices: [value !== undefined ? `Setz das Budget ${line.label} auf ${value.toLocaleString("de-DE")} €` : `Wie steht mein Budget ${line.label}?`], sure: true };
    }
    if (rows.some((row) => row.label.toLowerCase() === label.toLowerCase())) return { text: `Eine Position „${label}“ gibt es schon. Soll ich ihre Werte ändern, z. B. „Setz ${label} im Dezember auf 50 €“?` };
    const asked = amountOf(text) ?? /(?<![\d.,-])(\d{1,6}(?:,\d{1,2})?)\s*(?:€|euro)?\s*(?:monatlich|pro monat|im monat)\b/i.exec(text)?.[1];
    if (/(?:-|−|minus\s*)\s*\d/.test(text) || asked === 0) return { text: "Der Betrag einer Position muss größer als 0 € sein. Wie viel soll ich eintragen?" };
    const rowId = `row-${crypto.randomUUID()}`;
    // Like "Position hinzufügen": a new position is income or a fixed cost; variable budgets are the app's own lines.
    const kind = kindIn(lower.replace(label.toLowerCase(), " ")) === "income" ? "income" : "fixed";
    const note = /\bvariab/.test(lower) ? `Variable Budgets gibt es nur für die festen Budgets (${variableBudgetLines.map((line) => line.label).join(", ")}) – ich lege „${label}“ deshalb als Fixkosten-Position an.` : undefined;
    const category = /\bkategorie\b/.test(lower) ? findCategories(text.slice(lower.indexOf("kategorie") + 9))?.categories[0] : undefined;
    const operations: AssistantOperation[] = [{ op: "plan_row_save", rowId, create: true, label: label.slice(0, 100), kind, ...(category ? { planCategory: category } : {}) }];
    const amount = amountOf(text) ?? parseAmount(/(?<![\d.,])(\d{1,6}(?:,\d{1,2})?)\s*(?:€|euro)?\s*(?:monatlich|pro monat|im monat)\b/i.exec(text)?.[1] ?? "");
    const months = amount !== undefined ? monthsIn(text, asOf) ?? planningMonths(asOf).filter((month) => month >= addMonth(asOf.slice(0, 7), 0)) : undefined;
    if (amount !== undefined && months?.length) operations.push({ op: "plan_value", rowId, months: months.slice(0, 36), value: amount });
    return { operations, title: `Position „${label}“ im Monatsplan anlegen`, ...(note ? { note } : {}) };
  }
  if (moveWords.test(lower) && /\b(?:von|vom|aus)\b/.test(lower)) {
    const moved = moveBetween(state, text, lower, asOf);
    if (moved) return moved;
  }
  const row = matchName(text.replace(rowWords, " "), rows, (item) => item.label);
  if (!row) {
    // "Miete im Dezember 700" without such a position: offer to create it.
    const cell = /^(?:die\s+|den\s+|das\s+)?([\p{L}][\p{L}&-]{2,30}(?:\s+[\p{L}&-]{2,30})?)\s+((?:im|ab)\s+\p{L}+)\s+(?:auf\s+)?(\d[\d.,]*)\s*(?:€|euro)?\s*[.!]?$/iu.exec(text.trim());
    if (cell && !/^(?:budget|sparziel)/i.test(cell[1]) && !rows.some((item) => item.kind === "variable" && budgetLine(item) && new RegExp(cell[1], "i").test(item.label))) {
      const name = cell[1].charAt(0).toUpperCase() + cell[1].slice(1);
      return { text: `Eine Position „${name}“ gibt es im Monatsplan nicht. Soll ich sie anlegen?`, choices: [`Füg eine Position ${name} mit ${cell[3]} € ${cell[2]} hinzu`] };
    }
    if (!rowWord.test(lower)) return undefined;
    const asked = quotedOrAfter(text)?.trim();
    const list = rows.slice(0, 6).map((item) => `„${item.label}“`).join(", ");
    return { text: `${asked ? `Eine Position „${asked}“ finde ich im Monatsplan nicht.` : "Welche Position meinst du?"} ${rows.length ? `Vorhanden sind ${list}.` : "Im Monatsplan gibt es noch keine Positionen."}`.trim() };
  }
  if (/\b(?:lösch|loesch|entfern|streich)\w*/.test(lower)) return { operations: [{ op: "plan_row_delete", rowId: row.id }], title: `Position „${row.label}“ löschen` };
  const rename = /(?:benenn\w*|umbenenn\w*|nenn\w*)\b.*?\b(?:in|zu)\s+[„"']?([^"“”'.,!?]{2,100}?)[“"']?\s*(?:um)?\s*[.!]?$/i.exec(text);
  if (rename) return { operations: [{ op: "plan_row_save", rowId: row.id, label: rename[1].trim() }], title: `Position „${row.label}“ umbenennen` };
  // "Setz die Kategorie der Position Strom auf Energie", "Position Handy Kategorie Telefon & Internet".
  if (/\bkategorie\b/.test(lower)) {
    const found = findCategories(text.slice(lower.indexOf("kategorie") + 9));
    if (!found) return { text: `In welche Kategorie gehört „${row.label}“? Zum Beispiel Wohnen & Haushalt, Energie & Nebenkosten oder Versicherungen.` };
    return { operations: [{ op: "plan_row_save", rowId: row.id, planCategory: found.categories[0] }], title: `Kategorie von „${row.label}“ ändern` };
  }
  const kind = /\b(?:ist|sind|als|zu|mach\w*)\b/.test(lower) ? kindIn(lower.replace(row.label.toLowerCase(), " ")) : undefined;
  const amount = amountOf(text);
  const line = budgetLine(row);
  if (line && amount === undefined && /\bautomatisch\b|\bzurücksetz|\bzuruecksetz/.test(lower)) {
    const adjusted = state.budgetAdjustments?.[line.id];
    return adjusted ? { operations: [{ op: "budget_plan", line: line.id, adjustment: 0 }], title: `Budget ${line.label} auf Standard zurücksetzen` }
      : { text: `„${line.label}“ wird schon automatisch geplant.`, sure: true };
  }
  if (line && amount !== undefined) return budgetOnly(row, amount);
  if (amount === undefined) {
    if (kind === "variable" && kind !== row.kind) return { text: `Eine Position kann Einnahme oder Fixkosten sein; variable Budgets gibt es nur für ${variableBudgetLines.map((item) => item.label).join(", ")}.`, sure: true };
    if (kind && kind !== row.kind) return { operations: [{ op: "plan_row_save", rowId: row.id, kind }], title: `Position „${row.label}“ ändern` };
    return { text: `Was soll ich bei „${row.label}“ ändern? Zum Beispiel „Setz ${row.label} im Dezember auf 50 €“ oder „Benenne ${row.label} in … um“.` };
  }
  const months = monthsIn(text, asOf);
  if (!months?.length) return { text: `Für welchen Monat soll ${row.label} ${amount.toLocaleString("de-DE", { minimumFractionDigits: 2 })} € sein? Zum Beispiel „im Dezember“ oder „ab Jänner“.`,
    choices: [`Setz ${row.label} ab nächsten Monat auf ${amount.toLocaleString("de-DE")} €`] };
  return { operations: [{ op: "plan_value", rowId: row.id, months, value: amount }], title: `Monatsplan: ${row.label}` };
}
