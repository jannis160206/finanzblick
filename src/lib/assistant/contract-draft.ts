import { currency, dateLabel } from "@/lib/format";
import { canonicalCategory, type Category } from "@/lib/categories";
import { contractNotice, contractTypeOf } from "@/lib/contract-types";
import { addMonthsToDate, contractCandidates, intervalLabel, noticeLabel } from "@/lib/contracts";
import { matchesTransactionSearch } from "@/lib/transaction-tools";
import type { AppState, AssistantOperation, ContractDraft, ContractInterval } from "@/lib/types";
import { findCategories } from "./answers";
import { amountIn, dayIn, intervalIn, noticeIn } from "./contract-actions";
import { normalizeMessage } from "./normalize";
import { parseAmount } from "./intent";
import { offTopic } from "./scope";
import { detectSmallTalk } from "./smalltalk";

/**
 * Creating a contract in the chat follows the contract wizard: basics (name, amount, category, notice, minimum term),
 * rhythm (interval, next debit), automatic booking assignment and a preview that has to be confirmed.
 */
type Step = ContractDraft["step"];
export type DraftReply = { text: string; suggestions?: string[] };

const yes = /^(?:ja|jo|jep|gerne?|ok|okay|passt|genau|richtig|stimmt|klar|sicher|mach (?:das|es)|bitte|ja,? bitte|anlegen|speichern|übernehmen|uebernehmen|bestätigen|bestaetigen)\b/;
const no = /^(?:nein|ne|nö|noe|nope|keine?n?|ohne|nicht|gar keine?)\b/;
const skip = /^(?:weiter|überspring\w*|ueberspring\w*|weiß (?:ich )?nicht|weiss (?:ich )?nicht|keine ahnung|egal|später|spaeter|egal)\b/;
export const cancelDraft = (text: string) => /^(?:abbrechen|abbruch|stopp?|doch nicht|vergiss es|lass es|lass gut sein|cancel|nein,? doch nicht)\b/i.test(normalizeMessage(text).trim());
// Only a short "Ja"/"Passt" confirms; "Ja, aber nimm lieber Versicherungen" is a correction.
export const confirmDraft = (text: string) => yes.test(normalizeMessage(text).toLowerCase().trim()) && !/\d/.test(text) &&
  normalizeMessage(text).trim().split(/\s+/).length <= 4 && !/\b(?:aber|doch|lieber|statt|sondern)\b/i.test(text);

/**
 * A message that starts something new instead of answering the open step of a draft: a greeting or thanks, another topic,
 * or a real question. Short answers such as "ja", "500 €" or "Geht das bis Juni?" stay with the draft. While a name is
 * asked for, any word may be that name, so other topics are not checked then.
 */
export function leavesDraft(text: string, askingName = false): boolean {
  const plain = normalizeMessage(text).trim();
  const kind = detectSmallTalk(plain);
  if (kind && !["ack", "unsure", "unclear"].includes(kind)) return true;
  if (!askingName && offTopic(plain)) return true;
  if (!/\?\s*$/.test(plain)) return false;
  return plain.split(/\s+/).length > 4 || !/\d|\b(?:jän|jan|feb|mär|apr|mai|jun|jul|aug|sep|okt|nov|dez|monat|jahr|woche)/i.test(plain);
}

const categoryFor = (name: string): Category => {
  const type = contractTypeOf(name, "Abonnements");
  return type === "insurance" ? "Versicherungen" : type === "mobile" || type === "internet" ? "Telefon & Internet" : type === "gym" ? "Sport & Fitness"
    : type === "energy" ? "Energie & Nebenkosten" : "Abonnements";
};
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** The name in "Leg einen Vertrag für mein Fitnessstudio an" or "Neues Abo: Disney+ 9,99 € im Monat". */
function nameIn(text: string): string | undefined {
  const patterns = [
    /:\s*([^,\d:][^,:]{1,60}?)(?=\s*(?:,|\d|$|\bfür\b|\bum\b|\bmit\b|\bzu\b|\bab\b|\bim\b|\bpro\b))/i,
    /\b(?:namens|name|heißt|heisst)\s+[„"]?([^,„"“\d]{2,60}?)[“"]?(?=\s*(?:,|\d|$|\bfür\b|\bum\b|\bmit\b|\bab\b))/i,
    /\b(?:für|fuer)\s+(?:mein(?:en|e)?\s+|das\s+|die\s+|den\s+|ein(?:en|e)?\s+)?([^,\d.!?]{2,50}?)\s+(?:an|ein|hinzu)\b/i,
    // "Handyvertrag bei Magenta" → "Handyvertrag Magenta", "Vertrag bei A1" → "A1".
    /\b((?:\p{L}+)?(?:vertrag|abo|abonnement|versicherung|mitgliedschaft)\s+(?:bei|von|mit)\s+[\p{Lu}0-9][^,\d.!?]{1,40}?)(?=\s*(?:,|\d|$|\ban\b|\bein\b|\bhinzu\b|\bfür\b|\bum\b))/iu,
    /\b(?:mein(?:en|e)?|neue[nrs]?|eine[nrs]?)\s+(\p{L}+(?:vertrag|abo|versicherung|mitgliedschaft))\b/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const name = match?.[1]?.replace(/^(?:vertrag|abo|abonnement|versicherung|mitgliedschaft)\s+(?:bei|von|mit)\s+/i, "").replace(/\s+(?:bei|von|mit)\s+/i, " ")
      .replace(/\b(?:neue[nrs]?|einen?|den|das|die)\b/gi, " ").replace(/\s+/g, " ").trim();
    if (name && name.length >= 2 && !/^(?:vertrag|abo|versicherung|an|ein)$/i.test(name)) return capitalize(name.slice(0, 100));
  }
  return undefined;
}

// A bare answer to "Wie heißt der Vertrag?": everything before amounts, dates or rhythm words.
function bareName(text: string): string | undefined {
  const cut = text.replace(/^(?:er|es|der vertrag|das abo|die versicherung)\s+(?:heißt|heisst)\s+/i, "")
    .split(/,|\s(?=\d)|\s(?:für|um|mit|ab|im|pro|monatlich|jährlich|jaehrlich|am)\s/i)[0]
    .replace(/[„“"'.!?]+/g, "").trim();
  return cut.length >= 2 && cut.length <= 100 && !/^\d/.test(cut) && !no.test(cut.toLowerCase()) ? capitalize(cut) : undefined;
}

// Everything a message says about the contract, whichever step is open.
function fill(draft: ContractDraft, text: string, asOf: string, step: Step): { draft: ContractDraft; understood: boolean } {
  const lower = text.toLowerCase().trim();
  const next: ContractDraft = { ...draft };
  let understood = false;
  const name = step === "name" ? nameIn(text) ?? bareName(text) : nameIn(text);
  if (name && (step === "name" || !draft.name)) { next.name = name; understood = true; }
  const amount = amountIn(text) ?? (step === "amount" ? parseAmount((/(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/.exec(text)?.[0]) ?? "") : undefined);
  if (amount !== undefined && amount > 0 && amount <= 1_000_000 && (step === "amount" || /€|euro|eur\b|kostet|betrag/i.test(text))) { next.amount = amount; understood = true; }
  const interval = intervalIn(lower) ?? (step === "interval" ? ([[/\bmonat/, "monthly"], [/\bjahr/, "yearly"], [/\bquartal/, "quarterly"], [/\bhalbjahr/, "halfyearly"], [/\bwoche/, "weekly"]] as [RegExp, ContractInterval][])
    .find(([pattern]) => pattern.test(lower))?.[1] : undefined);
  if (interval) { next.interval = interval; understood = true; }
  const datePart = step === "nextDate" ? text : /\b(?:nächste|naechste|ab|am|ersten?)\b/i.test(text) ? text.slice(text.search(/\b(?:nächste|naechste|ab|am|ersten?)\b/i)) : undefined;
  const day = datePart && step !== "term" ? dayIn(datePart, asOf) : undefined;
  if (day && step !== "term") { next.nextDate = day; understood = true; }
  if (step === "category") {
    const found = findCategories(text);
    if (found) { next.category = found.categories[0]; understood = true; }
    else if (yes.test(lower) || skip.test(lower)) { next.category = categoryFor(next.name ?? ""); understood = true; }
  } else if (/\bkategorie\b/.test(lower)) {
    const found = findCategories(text.slice(lower.indexOf("kategorie") + 9));
    if (found) { next.category = found.categories[0]; understood = true; }
  }
  if (step === "notice") {
    const notice = noticeIn(lower);
    if (notice !== undefined) { next.notice = notice; understood = true; }
    else if (skip.test(lower)) { next.notice = null; understood = true; }
  } else if (/kündigungsfrist|jederzeit kündbar/.test(lower)) {
    const notice = noticeIn(lower.slice(Math.max(0, lower.search(/kündigungsfrist|jederzeit/) - 12)));
    if (notice !== undefined) { next.notice = notice; understood = true; }
  }
  if (step === "term" || /mindestlaufzeit|bindung/.test(lower)) {
    const part = step === "term" ? text : text.slice(lower.search(/mindestlaufzeit|bindung/));
    if (no.test(part.toLowerCase().trim()) || skip.test(part.toLowerCase().trim()) || /\b(?:keine|ohne) (?:mindestlaufzeit|bindung)\b/.test(lower)) { next.termEnd = null; understood = true; }
    else {
      // "12 Monate", "2 Jahre": a minimum term counted from today.
      const span = /\b(\d{1,2}|ein|einem|zwei|drei)\s*(monat\w*|jahr\w*)\b/.exec(part.toLowerCase());
      const count = span ? ({ ein: 1, einem: 1, zwei: 2, drei: 3 } as Record<string, number>)[span[1]] ?? Number(span[1]) : 0;
      const end = span && !/\bum\s+$/.test(part.toLowerCase().slice(0, span.index)) && count > 0
        ? addMonthsToDate(asOf, Math.min(120, span[2].startsWith("jahr") ? count * 12 : count)) : dayIn(part, asOf);
      if (end) { next.termEnd = end; understood = true; }
    }
    if (/verlängert sich (?:nicht|nie)|keine verlängerung|endet dann/.test(lower)) next.autoRenew = false;
    const renewal = /\bum\s+(\d{1,2})\s*monat/.exec(lower);
    if (renewal) { next.autoRenew = true; next.renewalMonths = Math.min(60, Math.max(1, Number(renewal[1]))); }
  }
  if (step === "match") {
    if (yes.test(lower)) { next.match = { text: (next.name ?? "").slice(0, 80) }; understood = true; }
    else if (no.test(lower) || skip.test(lower)) { next.match = null; understood = true; }
  }
  return { draft: next, understood };
}

const matching = (state: AppState, asOf: string, name: string) =>
  name.length >= 3 ? contractCandidates(state, asOf).filter((row) => matchesTransactionSearch(row, name)) : [];

function nextStep(draft: ContractDraft, state: AppState, asOf: string): ContractDraft {
  // Same order as the wizard: basics, rhythm, automatic assignment, preview.
  const step: Step = !draft.name ? "name" : draft.amount === undefined ? "amount" : !draft.category ? "category" : draft.notice === undefined ? "notice"
    : draft.termEnd === undefined ? "term" : !draft.interval ? "interval" : !draft.nextDate ? "nextDate"
    : draft.match === undefined && matching(state, asOf, draft.name).length ? "match" : "preview";
  return { ...draft, step, ...(step === "preview" && draft.match === undefined ? { match: null } : {}) };
}

export function startContractDraft(input: string, state: AppState, asOf: string, id: string): ContractDraft {
  const text = normalizeMessage(input);
  // Only what the first message says explicitly; every open field is asked afterwards.
  return nextStep(fill({ id, step: "preview" }, text, asOf, "preview").draft, state, asOf);
}

/** Fills the open step from the answer; `understood` is false when nothing in the answer fits. */
export function continueContractDraft(draft: ContractDraft, input: string, state: AppState, asOf: string): { draft: ContractDraft; understood: boolean } {
  const filled = fill(draft, normalizeMessage(input), asOf, draft.step);
  return { draft: nextStep(filled.draft, state, asOf), understood: filled.understood };
}

export function contractDraftOperation(draft: ContractDraft): Extract<AssistantOperation, { op: "contract_create" }> | undefined {
  if (!draft.name || draft.amount === undefined || !draft.interval || !draft.nextDate) return undefined;
  return { op: "contract_create", contractId: draft.id, name: draft.name, amount: draft.amount, interval: draft.interval, nextDate: draft.nextDate,
    category: canonicalCategory(draft.category ?? categoryFor(draft.name)),
    ...(draft.notice ? { notice: draft.notice } : {}), ...(draft.termEnd ? { termEnd: draft.termEnd } : {}),
    ...(draft.termEnd && draft.autoRenew !== undefined ? { autoRenew: draft.autoRenew } : {}),
    ...(draft.termEnd && draft.renewalMonths ? { renewalMonths: draft.renewalMonths } : {}),
    ...(draft.match ? { match: draft.match } : {}) };
}

/** The question for the open step, with quick replies like the choices in the wizard. */
export function contractStepReply(draft: ContractDraft, state: AppState, asOf: string): DraftReply {
  const name = draft.name ?? "der Vertrag";
  switch (draft.step) {
    case "name": return { text: "Gern, ich lege einen Vertrag an. Wie heißt er? Zum Beispiel „Handyvertrag Magenta“ oder „Fitnessstudio“.", suggestions: ["Abbrechen"] };
    case "amount": return { text: `Wie viel wird für „${name}“ pro Abbuchung abgebucht?`, suggestions: ["Abbrechen"] };
    case "interval": return { text: `Wie oft werden ${currency(draft.amount ?? 0)} abgebucht?`, suggestions: ["Monatlich", "Vierteljährlich", "Halbjährlich", "Jährlich"] };
    case "nextDate": {
      const last = matching(state, asOf, name)[0];
      return { text: `Wann ist die nächste Abbuchung?${last ? ` Zuletzt habe ich am ${dateLabel(last.date)} ${currency(Math.abs(last.amount))} gesehen.` : ""}`,
        suggestions: [`Am ${dateLabel(nextFirst(asOf))}`, "Abbrechen"] };
    }
    case "category": {
      const suggested = categoryFor(name);
      return { text: `In welche Kategorie gehört „${name}“? Ich würde ${suggested} nehmen.`,
        suggestions: [...new Set([suggested, "Abonnements", "Versicherungen", "Telefon & Internet"])].slice(0, 4) };
    }
    case "notice": {
      const typical = contractNotice[contractTypeOf(name, draft.category ?? "Abonnements")];
      return { text: `Gibt es eine Kündigungsfrist? ${typical.text}`, suggestions: ["Keine", "1 Monat", "3 Monate", "14 Tage"] };
    }
    case "term": return { text: "Gibt es eine Mindestlaufzeit? Wenn ja, bis wann – und verlängert er sich danach automatisch?",
      suggestions: ["Keine Mindestlaufzeit", "12 Monate", `Bis ${dateLabel(`${Number(asOf.slice(0, 4)) + 1}-12-31`)}`, "Abbrechen"] };
    case "match": {
      const rows = matching(state, asOf, name);
      return { text: `Ich habe ${rows.length === 1 ? "eine Buchung" : `${rows.length} Buchungen`} mit „${name}“ gefunden (zuletzt ${currency(Math.abs(rows[0].amount))} am ${dateLabel(rows[0].date)}). ` +
        "Soll ich solche Buchungen automatisch diesem Vertrag zuordnen?", suggestions: ["Ja", "Nein"] };
    }
    case "preview": return { text: `So würde ich „${name}“ anlegen: ${currency(draft.amount ?? 0)} ${draft.interval ? intervalLabel[draft.interval] : ""}, nächste Abbuchung ${draft.nextDate ? dateLabel(draft.nextDate) : "–"}` +
      `${draft.notice ? `, Kündigungsfrist ${noticeLabel(draft.notice)}` : ""}. Passt das? Mit „Ja“ oder „Bestätigen“ speichere ich ihn – oder sag mir, was ich ändern soll.` };
  }
}

const nextFirst = (asOf: string) => {
  const [year, month] = asOf.slice(0, 7).split("-").map(Number);
  const date = new Date(Date.UTC(year, month, 1));
  return date.toISOString().slice(0, 10);
};
