import type { AppState, PlannedOneOff, Transaction } from "@/lib/types";
import { classify } from "@/lib/calc";

const cents = (amount: number) => Math.round(amount * 100);

export type PlannedOccurrence = {
  id: string;
  itemId: string;
  name: string;
  date: string;
  amount: number;
  ownAmount: number;
  pocket: PlannedOneOff["pocket"];
  sharedWithRaphael: boolean;
  sharedPaidManually: boolean;
  bookingId?: string;
};

export function plannedOccurrences(items: PlannedOneOff[] = []): PlannedOccurrence[] {
  return items.flatMap((item) => Array.from({ length: item.installments }, (_, index) => {
    const [year, month, day] = item.date.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1 + index, 1));
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
    const due = date.toISOString().slice(0, 10);
    const amount = (index === item.installments - 1 && item.total !== undefined
      ? cents(item.total) - cents(item.amount) * index : cents(item.amount)) / 100;
    return {
      id: `planned:${item.id}:${due}`, itemId: item.id, name: item.name, date: due, amount,
      ownAmount: item.sharedWithRaphael ? Math.round(cents(amount) / 2) / 100 : amount,
      pocket: item.pocket, sharedWithRaphael: item.sharedWithRaphael === true,
      sharedPaidManually: item.paidOccurrences?.includes(due) === true,
    };
  })).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function matchPlannedOneOffs(items: PlannedOneOff[] = [], bookings: Transaction[] = []) {
  const occurrences = plannedOccurrences(items);
  if (!occurrences.length) return occurrences;
  const used = new Set<string>();
  const expenses = new Map<string, Transaction[]>();
  for (const row of bookings) {
    if (row.amount >= 0 || classify(row).isTransfer) continue;
    const day = expenses.get(row.date) ?? [];
    day.push(row);
    expenses.set(row.date, day);
  }
  for (const day of expenses.values()) day.sort((a, b) => a.id.localeCompare(b.id));
  for (const item of occurrences) {
    for (let offset = -3; offset <= 3; offset++) {
      const day = new Date(`${item.date}T12:00:00Z`);
      day.setUTCDate(day.getUTCDate() + offset);
      const match = expenses.get(day.toISOString().slice(0, 10))?.find((row) =>
        !used.has(row.id) && Math.abs(cents(-row.amount) - cents(item.amount)) <= 200);
      if (match) {
        item.bookingId = match.id;
        used.add(match.id);
        break;
      }
    }
  }
  return occurrences;
}

const seededPlans: PlannedOneOff[] = [
  { id: "seed-monitor-2026", name: "Monitor-Rate", date: "2026-10-06", amount: 55, total: 664, installments: 12, pocket: "Giro" },
  { id: "seed-schrank-2026", name: "Schrank", date: "2026-10-10", amount: 400, installments: 1, pocket: "Giro", sharedWithRaphael: true },
  { id: "seed-teppich-2026", name: "Teppich", date: "2026-10-10", amount: 180, installments: 1, pocket: "Giro", sharedWithRaphael: true },
  { id: "seed-vorhaenge-2026", name: "Vorhänge", date: "2026-10-15", amount: 400, installments: 1, pocket: "Giro", sharedWithRaphael: true },
  { id: "seed-fuehrerschein-2026", name: "Führerschein", date: "2026-10-20", amount: 780, installments: 1, pocket: "Sparkonto" },
];

export function isSeededSharedBooking(row: Transaction) {
  if (row.bank.toLowerCase() !== "amex" || row.date < "2026-09-11" || row.date > "2026-10-10") return false;
  const text = [row.description, row.rawDescription, ...(row.rawDetails ?? [])].join(" ");
  return (cents(row.amount) === -20782 && /ikea.*klagenfurt/i.test(text)) ||
    (cents(row.amount) === -12600 && /airbnb/i.test(text)) ||
    (cents(row.amount) === -16490 && /mollie|tapeso/i.test(text));
}

export function synchronizePlannedOneOffs(state: AppState): AppState {
  const originalBookings = [...state.transactions, ...(state.fixedReceipts ?? []).flatMap((item) =>
    item.booking ? [{ ...item.booking, id: item.key, date: item.date, amount: item.amount }] : [])];
  const matched = new Map(matchPlannedOneOffs(state.plannedOneOffs, originalBookings)
    .filter((item) => item.bookingId && item.sharedWithRaphael).map((item) => [item.bookingId, item]));
  const mark = (row: Transaction, id = row.id) => {
    const item = matched.get(id);
    if ((isSeededSharedBooking(row) || item) && (!row.sharedWithRaphael || (item?.sharedPaidManually && !row.sharedPaidManually)))
      return { ...row, sharedWithRaphael: true, ...(item?.sharedPaidManually ? { sharedPaidManually: true } : {}) };
    return row;
  };
  const transactions = state.transactions.map((row) => mark(row));
  const fixedReceipts = state.fixedReceipts?.map((item) => {
    if (!item.booking) return item;
    const booking = mark(item.booking, item.key);
    return booking === item.booking ? item : { ...item, booking };
  });
  const bookings = [...transactions, ...(fixedReceipts ?? []).flatMap((item) => item.booking ? [item.booking] : [])];
  const carpetBooked = bookings.some((row) => isSeededSharedBooking(row) && cents(row.amount) === -16490);
  const plannedOneOffs = state.plannedOneOffs?.filter((item) => item.id !== "seed-teppich-2026" || !carpetBooked);
  if (transactions.every((row, index) => row === state.transactions[index]) &&
    fixedReceipts?.every((item, index) => item === state.fixedReceipts?.[index]) !== false &&
    plannedOneOffs?.length === state.plannedOneOffs?.length) return state;
  return { ...state, transactions,
    ...(fixedReceipts ? { fixedReceipts } : {}),
    ...(plannedOneOffs ? { plannedOneOffs } : {}),
  };
}

export function initializePlannedOneOffs(state: AppState): AppState {
  if (state.plannedOneOffsSeeded) return synchronizePlannedOneOffs(state);
  const bookings = [...state.transactions, ...(state.fixedReceipts ?? []).flatMap((item) => item.booking ? [item.booking] : [])];
  const occurrences = matchPlannedOneOffs(seededPlans, bookings);
  const matches = new Set(occurrences.filter((item) => item.bookingId && item.sharedWithRaphael).map((item) => item.bookingId));
  const mark = (row: Transaction) => matches.has(row.id) ? { ...row, sharedWithRaphael: true } : row;
  const seed = !state.plannedOneOffs?.length;
  return synchronizePlannedOneOffs({
    ...state, plannedOneOffsSeeded: true,
    plannedOneOffs: seed ? seededPlans : state.plannedOneOffs,
    transactions: seed ? state.transactions.map(mark) : state.transactions,
    ...(seed && state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((item) => item.booking ? { ...item, booking: mark(item.booking) } : item) } : {}),
  });
}
