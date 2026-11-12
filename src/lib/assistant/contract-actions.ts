import { findCategories } from "./answers";
import { normalizeMessage } from "./normalize";
import { parseAmount, parseAssistantMessage, resolveDate } from "./intent";
import { matchName } from "./tools";
import { selectBookings } from "./booking-actions";
import { contractBookingsRequest } from "./contract-requests";
import { currency, dateLabel } from "@/lib/format";
import { matchesTransactionSearch } from "@/lib/transaction-tools";
import { detectContracts, type Contract } from "@/lib/contracts";
import type { AssistantPageContext } from "@/lib/assistant-context";
import type { AppState, AssistantOperation, ContractInterval, ContractNotice } from "@/lib/types";

export type ContractPlan = { operations: AssistantOperation[]; title: string; note?: string } | { text: string; choices?: string[] };
type Action = Extract<AssistantOperation, { op: "contract_action" }>["action"];

const intervals: [RegExp, ContractInterval][] = [
  [/\balle (?:zwei|2) wochen\b|\b14-?tägig\b|\bzweiwöchentlich\b/, "biweekly"], [/\bwöchentlich\b|\bwoechentlich\b|\bjede woche\b|\bpro woche\b/, "weekly"],
  [/\bvierteljährlich\w*|\bvierteljaehrlich\w*|\bquartalsweise\b|\bpro quartal\b|\bim quartal\b|\balle (?:drei|3) monate\b/, "quarterly"],
  [/\bhalbjährlich\w*|\bhalbjaehrlich\w*|\balle (?:sechs|6) monate\b|\bpro halbjahr\b/, "halfyearly"],
  [/\bjährlich\w*|\bjaehrlich\w*|\bpro jahr\b|\bim jahr\b|\beinmal im jahr\b|\bjahresabo\b/, "yearly"],
  [/\bmonatlich\w*|\bpro monat\b|\bim monat\b|\bjeden monat\b|\bmtl\b/, "monthly"],
];
export const intervalIn = (lower: string): ContractInterval | undefined => intervals.find(([pattern]) => pattern.test(lower))?.[1];

/** "3 Monate", "14 Tage", "4 Wochen"; null for "keine Kündigungsfrist" or "jederzeit kündbar". */
export function noticeIn(lower: string): ContractNotice | null | undefined {
  if (/\b(?:keine|ohne) (?:kündigungsfrist|frist)\b|\bjederzeit kündbar\b|^(?:keine|nein|ohne)\b/.test(lower)) return null;
  const match = /\b(\d{1,3}|ein(?:en)?|zwei|drei|vier|sechs)\s*(tag|woche|monat)\w*/.exec(lower);
  if (!match) return undefined;
  const words: Record<string, number> = { ein: 1, einen: 1, zwei: 2, drei: 3, vier: 4, sechs: 6 };
  const value = words[match[1]] ?? Number(match[1]);
  if (!Number.isInteger(value) || value < 1 || value > 730) return undefined;
  return { value, unit: match[2] === "tag" ? "days" : match[2] === "woche" ? "weeks" : "months" };
}

/** A calendar day in the text ("15.12.", "am 1. Dezember", "Ende März"); without a day the 1st of the month. */
export function dayIn(text: string, asOf: string): string | undefined {
  const parsed = parseAssistantMessage(text, asOf);
  return parsed.date ? resolveDate(parsed.date, "expense", asOf) : undefined;
}

export function amountIn(text: string): number | undefined {
  const match = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:€|euro|eur\b)/i.exec(text) ??
    /\b(?:kostet|kosten|betrag|beträgt|betraegt|zahle|zahl|um|für|fuer|auf)\s+(?:jetzt\s+|jetz\s+|ab jetzt\s+|nur noch\s+|neu\s+|nun\s+)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?![.\d])/i.exec(text);
  return match ? parseAmount(`${match[1]}${match[2] ? `,${match[2]}` : ""}`) : undefined;
}

const generic = /\b(?:abos?|abonnements?|verträge|vertraege|vertrag|versicherung(?:en)?|mitgliedschaft|tarif|den|die|das|der|meinen|meine|mein)\b/gi;

function actionOf(lower: string): Action | undefined {
  if (/\b(?:lösch|loesch|entfern)\w*|\bweg\s*[.!]?$/.test(lower)) return "remove";
  if (/\b(?:verwirf|verwerf\w*|zurücksetz\w*|zuruecksetz\w*|wie erkannt)\b/.test(lower)) return "reset";
  if (/\b(?:wieder aktiv|(?:läuft|laeuft) (?:doch |jetzt |ja )?wieder|doch nicht gekündigt|nicht mehr gekündigt|reaktivier\w*|kündigung (?:zurück|aufheben|widerrufen))\b/.test(lower)) return "reactivate";
  if (/\b(?:wieder einblend\w*|wieder anzeig\w*|wiederherstell\w*|wieder herstell\w*|doch ein (?:vertrag|abo))\b/.test(lower)) return "restore";
  if (/\bgekündigt\b/.test(lower)) return "cancel";
  if (/\b(?:kein|keine)\s+(?:vertr[aä]g\w*|abos?|abonnement|versicherung)\b|\bblend\w*\b.{0,40}\baus\b|\bausblend\w*|\bignorier\w*/.test(lower)) return "ignore";
  if (/\b(?:bestätig|bestaetig)\w*|\bist ein (?:echter |richtiger )?(?:vertrag|abo)\b/.test(lower)) return "confirm";
  return undefined;
}
const actionTitle: Record<Action, (name: string) => string> = {
  confirm: (name) => `„${name}“ als Vertrag bestätigen`, ignore: (name) => `„${name}“ ausblenden (kein Vertrag)`,
  restore: (name) => `„${name}“ wieder einblenden`, cancel: (name) => `„${name}“ als gekündigt markieren`,
  reactivate: (name) => `„${name}“ wieder aktiv setzen`, reset: (name) => `Eigene Angaben bei „${name}“ verwerfen`, remove: (name) => `Vertrag „${name}“ entfernen`,
};
const actionChoice: Record<Action, (name: string) => string> = {
  confirm: (name) => `Bestätige ${name}`, ignore: (name) => `${name} ist kein Vertrag`, restore: (name) => `${name} wieder einblenden`,
  cancel: (name) => `${name} ist gekündigt`, reactivate: (name) => `${name} ist wieder aktiv`, reset: (name) => `Änderungen an ${name} verwerfen`,
  remove: (name) => `Lösch den Vertrag ${name}`,
};
const fits: Record<Action, (contract: Contract) => boolean> = {
  confirm: (contract) => contract.status === "review", ignore: (contract) => contract.status !== "ignored", restore: (contract) => contract.status === "ignored",
  cancel: (contract) => contract.status === "active" || contract.status === "review", reactivate: (contract) => contract.status === "cancelled",
  reset: (contract) => contract.edited, remove: (contract) => contract.source === "manual",
};

/** The field changes a message asks for; null clears a field. */
function fieldsIn(text: string, lower: string, asOf: string, status?: Action): Omit<Extract<AssistantOperation, { op: "contract_update" }>, "op" | "contractId"> {
  const fields: Omit<Extract<AssistantOperation, { op: "contract_update" }>, "op" | "contractId"> = {};
  const rename = renameIn(text);
  if (rename) fields.name = rename;
  if (/\bkündigungsfrist\b|\bjederzeit kündbar\b/.test(lower)) {
    const notice = noticeIn(lower.slice(Math.max(0, lower.search(/kündigungsfrist|jederzeit/) - 12)));
    if (notice !== undefined) fields.notice = notice;
  }
  if (/\bmindestlaufzeit\b/.test(lower)) {
    if (/\b(?:keine|ohne) mindestlaufzeit\b/.test(lower)) fields.termEnd = null;
    else {
      const end = dayIn(text.slice(lower.indexOf("mindestlaufzeit")), asOf);
      if (end) fields.termEnd = end;
    }
  }
  if (/\b(?:verlängert|verlaengert) sich (?:nicht|nie)\b|\bkeine (?:automatische )?verlängerung\b/.test(lower)) fields.autoRenew = false;
  else if (/\b(?:verlängert|verlaengert) sich\b/.test(lower)) {
    fields.autoRenew = true;
    const months = /\bum\s+(\d{1,2})\s*monat/.exec(lower) ?? /\bum\s+(?:ein|1)\s+jahr\b/.exec(lower);
    if (months) fields.renewalMonths = months[1] ? Number(months[1]) : 12;
    if (/\bum\s+(\d)\s+jahre?\b/.test(lower)) fields.renewalMonths = Math.min(60, Number(/\bum\s+(\d)\s+jahre?\b/.exec(lower)![1]) * 12);
  }
  if (/\bnächste\w* abbuchung\b|\bnaechste\w* abbuchung\b|\babgebucht am\b|\bfällig am\b/.test(lower)) {
    const next = dayIn(text.slice(lower.search(/abbuchung|abgebucht|fällig/)), asOf);
    if (next) fields.nextDate = next;
  }
  if (/\bkostet\b|\bbetrag\b|\bbeträgt\b|\bbetraegt\b|\bpreis\b/.test(lower) && !/kündigungsfrist/.test(lower.slice(0, lower.search(/kostet|betrag|preis/) + 1))) {
    const amount = amountIn(text.replace(/\b\d{1,2}\.\s?\d{1,2}\.(?:\d{2,4})?/g, " "));
    if (amount !== undefined && amount > 0) fields.amount = amount;
  }
  if ((/\b(?:wird|werden|abgebucht|abbuchung|rhythmus|intervall|turnus|zahle|zahl|bezahl\w*|kostet|ist|sind|läuft|laeuft|stell\w*|änder\w*|aender\w*|umstell\w*|setz\w*|mach\w*)\b/.test(lower) ||
    fields.amount !== undefined) && !/verlänger|verlaenger/.test(lower) && !status) {
    const interval = intervalIn(lower);
    if (interval) fields.interval = interval;
  }
  if (/\bkategorie\b/.test(lower)) {
    const rest = text.slice(lower.indexOf("kategorie") + 9);
    const found = findCategories(rest);
    if (found) fields.category = found.categories[0];
    else if (/unterhaltung|streaming|kino|games|spiele/i.test(rest)) fields.category = "Entertainment";
  }
  const note = /\bnotiz\b[^:]{0,40}:\s*(.{1,500})$/i.exec(text);
  if (note) fields.note = note[1].trim();
  else if (/\b(?:lösch|loesch|entfern)\w*\b.{0,20}\bnotiz\b/.test(lower)) fields.note = null;
  return fields;
}

const renamePatterns = [
  /(?:benenn\w*|umbenenn\w*|nenn\w*)\b.*?\b(?:in|zu)\s+[„"']?([^"“”'.,!?]{2,60}?)[“"']?\s*(?:um)?\s*[.!]?$/i,
  /\b(?:name|namen|bezeichnung)\b.{0,50}?\b(?:auf|in|zu)\s+[„"']?([^"“”'.,!?]{2,60}?)[“"']?\s*(?:ändern|aendern|setzen|um)?\s*[.!]?$/i,
  /^(?:bitte\s+)?nenn\w*\s+(?!mir\b|uns\b).{2,60}?\s+(?:ab jetzt|ab sofort|künftig|kuenftig|in zukunft|nur noch|einfach)\s+[„"']?([^"“”'.,!?]{2,60}?)[“"']?\s*[.!]?$/i,
  /\bsoll\s+(?:ab jetzt\s+|künftig\s+|kuenftig\s+|in zukunft\s+)?[„"']?([^"“”'.,!?]{2,60}?)[“"']?\s+(?:heißen|heissen)\s*[.!]?$/i,
];
/** The new name in "Benenne FITINN in Fitnessstudio um", "Ändere den Namen von FITINN auf Fitnessstudio". */
export const renameIn = (text: string) => renamePatterns.map((pattern) => pattern.exec(text)?.[1]?.trim()).find((name) => !!name && name.length >= 2);

// "Hausrat" for "Hausratversicherung": a word of at least four letters that starts a word of exactly one contract name.
function prefixContract(text: string, contracts: Contract[]): Contract | undefined {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4 && !/^(?:vertrag|buchung|zuordnen|ordne|verknüpfe|verknuepfe|gehört|gehoert|dem|mit)$/.test(word));
  const hits = contracts.filter((contract) => contract.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((part) => words.some((word) => part.startsWith(word))));
  return hits.length === 1 ? hits[0] : undefined;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const contractWords = /\b(?:vertr[aä]g\w*|\w+vertrag|abos?|abonnement\w*)\b/gi;

// "Ordne die Buchung vom 2.10. dem Vertrag Disney Plus zu", "Nimm die Buchung vom 3.10. aus dem Netflix-Vertrag".
function contractBookings(state: AppState, text: string, lower: string, contracts: Contract[], asOf: string): ContractPlan {
  // "Nimm die Buchung in den Netflix-Vertrag auf" adds; "Nimm sie aus dem Vertrag" removes.
  const adds = /\b(?:nimm|nehm\w*)\b.{0,80}\bauf\s*[.!]?$|\baufnehm\w*|\bin den\b.{0,40}\b(?:vertrag|abo)/.test(lower);
  const remove = !adds && (/\b(?:nimm|nehm\w*|entfern\w*|lös\w*|loes\w*|raus|heraus\w*)\b|\b(?:gehört|gehoert|gehören|gehoeren)\s+nicht\b|\bnicht\s+(?:mehr\s+)?(?:zu|zum)\b/.test(lower));
  const spoken = text.replace(/\b(?:buchung|abbuchung|umsatz|zahlung|lastschrift)\w*/gi, " ").replace(generic, " ");
  const contract = matchName(spoken, contracts, (item) => item.name) ?? prefixContract(spoken, contracts);
  if (!contract) {
    // "Ordne die Disney Plus Buchung dem Vertrag Disney Plus zu" without such a contract: offer to make one from the booking.
    const asked = /\b(?:[Vv]ertrag|[Aa]bo)\s+[„"]?(\p{Lu}[\p{L}\p{N}+&' -]{1,40}?)[“"]?\s+(?:zu|hinzu)?\s*[.!]?$/u.exec(text)?.[1]?.trim();
    const { rows } = selectBookings(state, text.replace(/\b(?:vertrag|abo)\b.*$/i, " "), asOf);
    if (asked && !remove) return { text: `Einen Vertrag „${asked}“ gibt es noch nicht. Soll ich aus der Buchung einen neuen Vertrag machen?`,
      choices: [`Markiere die ${asked} Buchung${rows[0] ? ` vom ${dateLabel(rows[0].date)}` : ""} als Vertrag`, ...contracts.slice(0, 3).map((item) => `${text.replace(/[.!]+$/, "")} – Vertrag ${item.name}`.slice(0, 120))] };
    return { text: `Welchem Vertrag soll ich die Buchung ${remove ? "wegnehmen" : "zuordnen"}? Zur Auswahl: ${contracts.slice(0, 4).map((item) => item.name).join(", ")}.`,
      choices: contracts.slice(0, 4).map((item) => `${text.replace(/[.!]+$/, "")} – Vertrag ${item.name}`.slice(0, 120)) };
  }
  const rest = text.replace(new RegExp(escape(contract.name), "gi"), " ").replace(contractWords, " ");
  const { rows, what, specific } = selectBookings(state, rest, asOf);
  const charged = new Set(contract.charges.map((charge) => charge.id));
  const all = /\b(?:alle|beide|sämtliche|saemtliche)\b/.test(lower);
  const named = specific ? rows : state.transactions.filter((row) => matchesTransactionSearch(row, contract.name)).sort((a, b) => b.date.localeCompare(a.date));
  const pool = named.filter((row) => row.amount < 0 && (remove ? charged.has(row.id) : !charged.has(row.id) && !row.ignored));
  const label = what ? ` ${what}` : "";
  if (!pool.length) {
    if (remove) return { text: `Keine Buchung${label} gehört zu „${contract.name}“.` };
    return { text: named.some((row) => charged.has(row.id)) ? `Die Buchung${label} gehört schon zu „${contract.name}“.` : `Ich finde keine passende Abbuchung${label}. Nenn mir Datum oder Betrag, z. B. „vom 2.10. über 9,99 €“.` };
  }
  if (pool.length > 1 && !all) return { text: `Ich finde ${pool.length} passende Buchungen${label}. Welche meinst du?`,
    choices: pool.slice(0, 4).map((row) => remove ? `Nimm die Buchung vom ${dateLabel(row.date)} über ${currency(Math.abs(row.amount))} aus dem Vertrag ${contract.name}`
      : `Ordne die Buchung vom ${dateLabel(row.date)} über ${currency(Math.abs(row.amount))} dem Vertrag ${contract.name} zu`) };
  const ids = pool.slice(0, 50).map((row) => row.id);
  return { operations: [{ op: "contract_bookings", contractId: contract.id, ...(remove ? { remove: ids } : { add: ids }) }],
    title: remove ? `${ids.length === 1 ? "Buchung" : `${ids.length} Buchungen`} aus dem Vertrag „${contract.name}“ nehmen` : `${ids.length === 1 ? "Buchung" : `${ids.length} Buchungen`} dem Vertrag „${contract.name}“ zuordnen` };
}

/** Turns "Netflix ist gekündigt zum 31.12." or "Kündigungsfrist von Magenta ist 3 Monate" into a contract change. */
export function contractEdit(state: AppState, input: string, asOf: string, page?: AssistantPageContext | null): ContractPlan {
  const text = normalizeMessage(input);
  const lower = text.toLowerCase();
  const contracts = detectContracts(state, asOf);
  if (!contracts.length) return { text: "Ich finde noch keine Verträge. Leg einen an, zum Beispiel mit „Leg einen neuen Vertrag an“." };
  if (contractBookingsRequest(lower)) return contractBookings(state, text, lower, contracts, asOf);
  // "Das monatliche Netflix-Abo ist gekündigt": a status change; the rhythm word only describes the contract.
  const status = actionOf(lower);
  const fields = fieldsIn(text, lower, asOf, status);
  const action = Object.keys(fields).length ? undefined : status;
  // "Bestätige alle Vorschläge": every open suggestion at once.
  if (action === "confirm" && /\balle\b/.test(lower)) {
    const open = contracts.filter((contract) => contract.status === "review").slice(0, 20);
    if (!open.length) return { text: "Es gibt keine offenen Vertragsvorschläge mehr." };
    return { operations: open.map((contract) => ({ op: "contract_action" as const, contractId: contract.id, action: "confirm" as const })),
      title: `${open.length === 1 ? "1 Vorschlag" : `${open.length} Vorschläge`} als Vertrag bestätigen` };
  }
  const opened = page?.contractId && /\b(?:dies\w*|den|der|das|ihn|es)\b/.test(lower) ? contracts.find((contract) => contract.id === page.contractId) : undefined;
  const named = rename(text, fields.name);
  const contract = matchName(named.replace(generic, " "), contracts, (item) => item.name) ?? opened;
  if (!action && !Object.keys(fields).length) return { text: "Was soll ich am Vertrag ändern? Zum Beispiel „Netflix ist gekündigt zum 31.12.“, „Kündigungsfrist von Magenta ist 3 Monate“ oder „Spotify kostet jetzt 12,99 €“." };
  if (!contract) {
    const pool = contracts.filter((item) => !action || fits[action](item)).slice(0, 4);
    const asked = /\b(?:[Vv]ertrag|[Aa]bo|[Vv]ersicherung)\s+[„"]?(\p{Lu}[\p{L}\p{N}+&' -]{1,40}?)[“"]?\s*[.!]?$/u.exec(text)?.[1]?.trim();
    const missing = asked ? `Einen Vertrag „${asked}“ finde ich nicht. ` : "";
    if (!pool.length) return { text: `${missing}Dafür finde ich keinen passenden Vertrag.` };
    return { text: `${missing}Welchen Vertrag meinst du? Zur Auswahl: ${pool.map((item) => item.name).join(", ")}.`,
      choices: pool.map((item) => action ? actionChoice[action](item.name) : `${text.replace(/[.!]+$/, "")} bei ${item.name}`.slice(0, 120)) };
  }
  // A detected contract cannot be deleted, only hidden ("kein Vertrag"); its bookings stay.
  if (action === "remove" && contract.source !== "manual") {
    if (contract.status === "ignored") return { text: `„${contract.name}“ ist schon ausgeblendet.` };
    return { operations: [{ op: "contract_action", contractId: contract.id, action: "ignore" }], title: actionTitle.ignore(contract.name),
      note: `„${contract.name}“ habe ich aus deinen Buchungen erkannt – löschen geht da nicht, aber ich blende ihn als „kein Vertrag“ aus. Die Buchungen selbst bleiben.` };
  }
  if (action) {
    const date = action === "cancel" ? dayIn(text.replace(new RegExp(contract.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " "), asOf) : undefined;
    return { operations: [{ op: "contract_action", contractId: contract.id, action, ...(date ? { date } : {}) }], title: actionTitle[action](contract.name) };
  }
  return { operations: [{ op: "contract_update", contractId: contract.id, ...fields }], title: `Vertrag „${contract.name}“ ändern` };
}

// The old name, not the new one, identifies the contract when renaming.
const rename = (text: string, newName?: string) => newName ? text.replace(newName, " ") : text;
