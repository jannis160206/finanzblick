import { isAnonymousPaypal } from "@/lib/ai/booking-matchers";
import { merchantAliasAssignment } from "@/lib/merchant-identity";
import type { AppState, Transaction } from "@/lib/types";
import { parseStatementAmount, parseStatementDate, readCsv } from "./statements";

export type PaypalActivity = { date: string; name: string; amount: number; code?: string };
export type PaypalMatch = { id: string; target: "review" | "booking"; name: string; date: string; amount: number };
export type PaypalMatchResult = { state: AppState; matched: PaypalMatch[]; ambiguous: number; unmatched: number; rows: number };

const MAX_DAYS = 4;
const DAY_MS = 86_400_000;
const key = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const cents = (value: number) => Math.round(value * 100);

const COLUMNS = {
  date: ["datum", "date"],
  name: ["name"],
  gross: ["brutto", "gross"],
  currency: ["wahrung", "currency"],
  status: ["status"],
  type: ["typ", "type"],
  code: ["transaktionscode", "transactionid"],
} as const;

function usDate(raw: string) {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}` : null;
}

// PayPal's "Aktivitäten" download (German or English headers). Only completed EUR payments to a named party count.
export function parsePaypalActivity(text: string): PaypalActivity[] {
  const table = readCsv(text.replace(/^\uFEFF/, ""));
  const headerIndex = table.findIndex((row) => row.cells.some((cell) => COLUMNS.gross.includes(key(cell) as never)));
  if (headerIndex < 0) throw new Error("Das ist kein PayPal-Aktivitätenexport (Spalte „Brutto“ fehlt).");
  const header = table[headerIndex].cells.map(key);
  const column = (names: readonly string[]) => header.findIndex((cell) => names.includes(cell));
  const at = Object.fromEntries(Object.entries(COLUMNS).map(([name, names]) => [name, column(names)])) as
    Record<keyof typeof COLUMNS, number>;
  if (at.date < 0 || at.name < 0) throw new Error("Im PayPal-Export fehlen die Spalten „Datum“ oder „Name“.");
  const english = header.includes("gross");
  return table.slice(headerIndex + 1).flatMap(({ cells }) => {
    const get = (index: number) => (index >= 0 ? cells[index] ?? "" : "").trim();
    const name = get(at.name).replace(/\s+/g, " ");
    const status = key(get(at.status));
    const currency = get(at.currency).toUpperCase();
    if (!name || (status && !["abgeschlossen", "completed"].includes(status)) || (currency && currency !== "EUR")) return [];
    // Card or bank top-ups are PayPal's own funding legs, not the shop.
    if (/bankgutschrift|allgemeine abbuchung|general (?:card|bank) (?:withdrawal|deposit)|währungsumrechnung|currency conversion/i.test(get(at.type)))
      return [];
    const date = (english ? usDate(get(at.date)) : null) ?? parseStatementDate(get(at.date)) ?? usDate(get(at.date));
    const amount = parseStatementAmount(get(at.gross));
    if (!date || amount === null || amount === 0) return [];
    const code = get(at.code);
    return [{ date, name: name.slice(0, 90), amount, ...(code ? { code: code.slice(0, 40) } : {}) }];
  });
}

type Target = { id: string; target: PaypalMatch["target"]; date: string; amount: number };

function targets(state: AppState): Target[] {
  const anonymous = (row: Pick<Transaction, "id" | "amount" | "description" | "merchantAlias">) =>
    !row.merchantAlias && isAnonymousPaypal({ id: row.id, amount: row.amount, description: row.description });
  return [
    ...(state.reviewQueue ?? []).flatMap((item) => item.kind === "booking" && item.draft.amount !== null && item.draft.date &&
      anonymous({ ...item.draft, amount: item.draft.amount })
      ? [{ id: item.id, target: "review" as const, date: item.draft.date, amount: item.draft.amount }] : []),
    ...state.transactions.filter(anonymous).map((row) => ({ id: row.id, target: "booking" as const, date: row.date, amount: row.amount })),
  ];
}

const close = (left: string, right: string) => Math.abs(Date.parse(left) - Date.parse(right)) <= MAX_DAYS * DAY_MS;

// A bank booking gets the shop only if exactly one PayPal payment fits and that payment fits no other booking.
export function matchPaypalActivity(state: AppState, activity: readonly PaypalActivity[]): PaypalMatchResult {
  const open = targets(state);
  const fits = (booking: Target, row: PaypalActivity) => cents(row.amount) === cents(booking.amount) && close(row.date, booking.date);
  const matched: PaypalMatch[] = [];
  let ambiguous = 0;
  for (const booking of open) {
    const options = activity.filter((row) => fits(booking, row));
    if (!options.length) continue;
    // Several payments at that amount and time are fine as long as they all name the same shop.
    if (new Set(options.map((row) => key(row.name))).size !== 1) {
      ambiguous++;
      continue;
    }
    matched.push({ ...booking, name: options[0].name });
  }
  const byId = new Map(matched.map((match) => [match.id, match.name]));
  const name = <T extends Pick<Transaction, "merchantAlias" | "merchantId" | "merchantLogo" | "merchantMatch">>(row: T, alias: string) =>
    ({ ...row, ...merchantAliasAssignment(row, alias), merchantNameConfirmed: undefined });
  const next = !matched.length ? state : {
    ...state,
    transactions: state.transactions.map((row) => byId.has(row.id) ? name(row, byId.get(row.id)!) : row),
    reviewQueue: state.reviewQueue?.map((item) => item.kind === "booking" && byId.has(item.id)
      ? { ...item, draft: name(item.draft, byId.get(item.id)!) } : item),
    // A proposal made without the shop's name is outdated now.
    ...(state.aiSuggestions ? { aiSuggestions: state.aiSuggestions.filter((entry) => !byId.has(entry.id)) } : {}),
  };
  return { state: next, matched, ambiguous, unmatched: open.length - matched.length - ambiguous, rows: activity.length };
}
