import { findCategories } from "./answers";
import { normalizeMessage } from "./normalize";
import { parseAmount, parseAssistantMessage, resolveDate } from "./intent";
import { matchName } from "./tools";
import { detectContracts, type Contract } from "@/lib/contracts";
import type { AssistantPageContext } from "@/lib/assistant-context";
import type { AppState, AssistantOperation, ContractInterval, ContractNotice } from "@/lib/types";

export type ContractPlan = { operations: AssistantOperation[]; title: string } | { text: string; choices?: string[] };
type Action = Extract<AssistantOperation, { op: "contract_action" }>["action"];

const intervals: [RegExp, ContractInterval][] = [
  [/\balle (?:zwei|2) wochen\b|\b14-?tägig\b|\bzweiwöchentlich\b/, "biweekly"], [/\bwöchentlich\b|\bwoechentlich\b|\bjede woche\b|\bpro woche\b/, "weekly"],
  [/\bvierteljährlich\b|\bvierteljaehrlich\b|\bquartalsweise\b|\bpro quartal\b|\bim quartal\b|\balle (?:drei|3) monate\b/, "quarterly"],
  [/\bhalbjährlich\b|\bhalbjaehrlich\b|\balle (?:sechs|6) monate\b|\bpro halbjahr\b/, "halfyearly"],
  [/\bjährlich\b|\bjaehrlich\b|\bpro jahr\b|\bim jahr\b|\beinmal im jahr\b|\bjahresabo\b/, "yearly"],
  [/\bmonatlich\b|\bpro monat\b|\bim monat\b|\bjeden monat\b|\bmtl\b/, "monthly"],
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
    /\b(?:kostet|kosten|betrag|beträgt|betraegt|zahle|zahl|um|für|fuer|auf)\s+(?:jetzt\s+|ab jetzt\s+|nur noch\s+|neu\s+|nun\s+)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?![.\d])/i.exec(text);
  return match ? parseAmount(`${match[1]}${match[2] ? `,${match[2]}` : ""}`) : undefined;
}

const generic = /\b(?:abos?|abonnements?|verträge|vertraege|vertrag|versicherung(?:en)?|mitgliedschaft|tarif|den|die|das|der|meinen|meine|mein)\b/gi;

function actionOf(lower: string): Action | undefined {
  if (/\b(?:lösch|loesch|entfern)\w*/.test(lower)) return "remove";
  if (/\b(?:verwirf|verwerf\w*|zurücksetz\w*|zuruecksetz\w*|wie erkannt)\b/.test(lower)) return "reset";
  if (/\b(?:wieder aktiv|läuft wieder|laeuft wieder|doch nicht gekündigt|nicht mehr gekündigt|reaktivier\w*|kündigung (?:zurück|aufheben|widerrufen))\b/.test(lower)) return "reactivate";
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
function fieldsIn(text: string, lower: string, asOf: string): Omit<Extract<AssistantOperation, { op: "contract_update" }>, "op" | "contractId"> {
  const fields: Omit<Extract<AssistantOperation, { op: "contract_update" }>, "op" | "contractId"> = {};
  const rename = /(?:benenn\w*|umbenenn\w*|nenn\w*)\b.*?\b(?:in|zu)\s+[„"']?([^"“”'.,!?]{2,60}?)[“"']?\s*(?:um)?\s*[.!]?$/i.exec(text);
  if (rename) fields.name = rename[1].trim();
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
  if (/\b(?:wird|werden|abgebucht|abbuchung|rhythmus|zahle|zahl|kostet)\b/.test(lower) || fields.amount !== undefined) {
    const interval = intervalIn(lower);
    if (interval) fields.interval = interval;
  }
  if (/\bkategorie\b/.test(lower)) {
    const found = findCategories(text.slice(lower.indexOf("kategorie") + 9));
    if (found) fields.category = found.categories[0];
  }
  const note = /\bnotiz\b[^:]{0,40}:\s*(.{1,500})$/i.exec(text);
  if (note) fields.note = note[1].trim();
  else if (/\b(?:lösch|loesch|entfern)\w*\b.{0,20}\bnotiz\b/.test(lower)) fields.note = null;
  return fields;
}

/** Turns "Netflix ist gekündigt zum 31.12." or "Kündigungsfrist von Magenta ist 3 Monate" into a contract change. */
export function contractEdit(state: AppState, input: string, asOf: string, page?: AssistantPageContext | null): ContractPlan {
  const text = normalizeMessage(input);
  const lower = text.toLowerCase();
  const contracts = detectContracts(state, asOf);
  if (!contracts.length) return { text: "Ich finde noch keine Verträge. Leg einen an, zum Beispiel mit „Leg einen neuen Vertrag an“." };
  const fields = fieldsIn(text, lower, asOf);
  const action = Object.keys(fields).length ? undefined : actionOf(lower);
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
    if (!pool.length) return { text: "Dafür finde ich keinen passenden Vertrag." };
    return { text: `Welchen Vertrag meinst du? Zur Auswahl: ${pool.map((item) => item.name).join(", ")}.`,
      choices: pool.map((item) => action ? actionChoice[action](item.name) : `${text.replace(/[.!]+$/, "")} bei ${item.name}`.slice(0, 120)) };
  }
  if (action) {
    const date = action === "cancel" ? dayIn(text.replace(new RegExp(contract.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " "), asOf) : undefined;
    return { operations: [{ op: "contract_action", contractId: contract.id, action, ...(date ? { date } : {}) }], title: actionTitle[action](contract.name) };
  }
  return { operations: [{ op: "contract_update", contractId: contract.id, ...fields }], title: `Vertrag „${contract.name}“ ändern` };
}

// The old name, not the new one, identifies the contract when renaming.
const rename = (text: string, newName?: string) => newName ? text.replace(newName, " ") : text;
