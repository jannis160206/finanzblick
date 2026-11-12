import { planningMonths } from "@/lib/planning-range";
import type { AppState, AssistantOperation, FinanceRow } from "@/lib/types";
import { findCategories } from "./answers";
import { addMonth, parseAmount, parseAssistantMessage } from "./intent";
import { matchName } from "./tools";

/**
 * Positions of the month plan, like "Position hinzufügen/bearbeiten/löschen" and the plan grid:
 * "Füg eine Position Fitnessstudio (Fixkosten, 39,90 € ab Oktober) hinzu", "Setz die Miete im Dezember auf 700 €".
 */
export type PlanRowPlan = { operations: AssistantOperation[]; title: string } | { text: string; choices?: string[] };

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

const quotedOrAfter = (text: string) =>
  /[„"]([^“"]{1,100})[“"]/.exec(text)?.[1] ??
  /\b(?:plan)?position\s+(?:namens\s+|für\s+|fuer\s+)?([\p{L}][\p{L}\p{N}&.' -]{0,60}?)(?=\s*(?:$|[,.(!?]|\s(?:mit|als|im|ab|für|fuer|hinzu|an|ein|auf|in|zu|um)\b))/iu.exec(text)?.[1];

export function planRowAction(state: AppState, text: string, asOf: string): PlanRowPlan | undefined {
  const lower = text.toLowerCase();
  const rows = state.financeRows;
  const create = /\b(?:füg|fueg|leg|trag|erstell|nimm)\w*\b.*\b(?:plan)?position\b|\bneue (?:plan)?position\b|\b(?:plan)?position\b.*\b(?:hinzu|anlegen|eintragen|erstellen)\b/.test(lower);
  if (create) {
    const label = quotedOrAfter(text)?.trim();
    if (!label) return { text: "Wie soll die neue Position im Monatsplan heißen? Zum Beispiel „Füg eine Position Fitnessstudio hinzu“." };
    if (rows.some((row) => row.label.toLowerCase() === label.toLowerCase())) return { text: `Eine Position „${label}“ gibt es schon. Soll ich ihre Werte ändern, z. B. „Setz ${label} im Dezember auf 50 €“?` };
    const rowId = `row-${crypto.randomUUID()}`;
    const kind = kindIn(lower.replace(label.toLowerCase(), " ")) ?? "fixed";
    const category = /\bkategorie\b/.test(lower) ? findCategories(text.slice(lower.indexOf("kategorie") + 9))?.categories[0] : undefined;
    const operations: AssistantOperation[] = [{ op: "plan_row_save", rowId, create: true, label: label.slice(0, 100), kind, ...(category ? { planCategory: category } : {}) }];
    const amount = amountOf(text);
    const months = amount !== undefined ? monthsIn(text, asOf) ?? planningMonths(asOf).filter((month) => month >= addMonth(asOf.slice(0, 7), 0)) : undefined;
    if (amount !== undefined && months?.length) operations.push({ op: "plan_value", rowId, months: months.slice(0, 36), value: amount });
    return { operations, title: `Position „${label}“ im Monatsplan anlegen` };
  }
  const row = matchName(text.replace(/\b(?:plan)?position\b/gi, " "), rows, (item) => item.label);
  if (!row) {
    if (!/\b(?:plan)?position\b/.test(lower)) return undefined;
    const asked = quotedOrAfter(text)?.trim();
    const list = rows.slice(0, 6).map((item) => `„${item.label}“`).join(", ");
    return { text: `${asked ? `Eine Position „${asked}“ finde ich im Monatsplan nicht.` : "Welche Position meinst du?"} ${rows.length ? `Vorhanden sind ${list}.` : "Im Monatsplan gibt es noch keine Positionen."}`.trim() };
  }
  if (/\b(?:lösch|loesch|entfern|streich)\w*/.test(lower)) return { operations: [{ op: "plan_row_delete", rowId: row.id }], title: `Position „${row.label}“ löschen` };
  const rename = /(?:benenn\w*|umbenenn\w*|nenn\w*)\b.*?\b(?:in|zu)\s+[„"']?([^"“”'.,!?]{2,100}?)[“"']?\s*(?:um)?\s*[.!]?$/i.exec(text);
  if (rename) return { operations: [{ op: "plan_row_save", rowId: row.id, label: rename[1].trim() }], title: `Position „${row.label}“ umbenennen` };
  const kind = /\b(?:ist|sind|als|zu|mach\w*)\b/.test(lower) ? kindIn(lower.replace(row.label.toLowerCase(), " ")) : undefined;
  const amount = amountOf(text);
  if (amount === undefined && /\bautomatisch\b|\bzurücksetz|\bzuruecksetz/.test(lower) && row.kind === "variable") {
    const months = monthsIn(text, asOf);
    if (months) return { operations: [{ op: "plan_value", rowId: row.id, months, value: null }], title: `${row.label} wieder automatisch planen` };
  }
  if (amount === undefined) {
    if (kind && kind !== row.kind) return { operations: [{ op: "plan_row_save", rowId: row.id, kind }], title: `Position „${row.label}“ ändern` };
    return { text: `Was soll ich bei „${row.label}“ ändern? Zum Beispiel „Setz ${row.label} im Dezember auf 50 €“ oder „Benenne ${row.label} in … um“.` };
  }
  const months = monthsIn(text, asOf);
  if (!months?.length) return { text: `Für welchen Monat soll ${row.label} ${amount.toLocaleString("de-DE", { minimumFractionDigits: 2 })} € sein? Zum Beispiel „im Dezember“ oder „ab Jänner“.`,
    choices: [`Setz ${row.label} ab nächsten Monat auf ${amount.toLocaleString("de-DE")} €`] };
  return { operations: [{ op: "plan_value", rowId: row.id, months, value: amount }], title: `Monatsplan: ${row.label}` };
}
