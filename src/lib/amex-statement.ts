import type { AppState, Transaction } from "@/lib/types";
import type { AccountedTransaction } from "@/lib/shared-holiday";
import { isWorkingDay, shiftCalendarDate } from "@/lib/holidays-at-kaernten";
import {
  amexReserveBalance,
  isAmexCard,
  isAmexCardPayment,
  isAmexDirectDebit,
  isAmexPartnerCard,
  isAmexReservePocket,
  isAmexSettlement,
} from "@/lib/amex-balance";

/** Amex closes every statement on the 10th: purchases up to the 10th are on it, from the 11th on the next one. */
export const AMEX_CLOSING_DAY = 10;
/** Without history: Amex debits about a week after the statement date. */
const DEFAULT_DEBIT_OFFSET = 7;
/** A closed statement without a recorded debit stays due for at most three weeks (later: data is just missing). */
const DUE_WINDOW_DAYS = 21;
const HISTORY_CYCLES = 6;

export type AmexCycle = { start: string; closing: string };

const cents = (value: number) => Math.round(value * 100);
const euros = (value: number) => value / 100;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
const utcDate = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);

/** The statement a purchase on `date` belongs to: from the 11th of the previous month up to the 10th. */
export function amexCycle(date: string): AmexCycle {
  const [year, month, day] = date.split("-").map(Number);
  const closingMonth = day > AMEX_CLOSING_DAY ? month + 1 : month;
  return {
    start: utcDate(year, closingMonth - 1, AMEX_CLOSING_DAY + 1),
    closing: utcDate(year, closingMonth, AMEX_CLOSING_DAY),
  };
}

export const previousAmexCycle = (cycle: AmexCycle) => amexCycle(shiftCalendarDate(cycle.start, -1));

/** The most recent statement date strictly before `date`. */
const lastClosing = (date: string) => shiftCalendarDate(amexCycle(date).start, -1);

/** A payment of the card balance: bank debit/transfer or the matching credit on the card itself. */
const bankSettlement = (row: Transaction) => isAmexSettlement(row) && !isAmexReservePocket(row.pocket);
const cardSettlement = (row: Transaction) => isAmexCard(row) && row.amount > 0 &&
  (isAmexCardPayment(row) || /^transfer/i.test(row.category));
const settlement = (row: Transaction) => bankSettlement(row) || cardSettlement(row);

export type AmexDebitSchedule = {
  /** Days after the statement date on which Amex debits the giro (moved to the next working day). */
  offsetDays: number;
  /** How many of the recent debits fit this offset. */
  basedOn: number;
  /** Recent debit dates the offset was derived from. */
  recent: string[];
};

/** When Amex usually debits the giro, learned from the last statements' debits. */
export function amexDebitSchedule(bookings: readonly Transaction[], today: string): AmexDebitSchedule {
  const since = shiftCalendarDate(today, -400);
  const payments = bookings.filter((row) => row.date <= today && row.date >= since && bankSettlement(row));
  const direct = payments.filter(isAmexDirectDebit);
  // Manual transfers follow the user's timing, the direct debits Amex's own schedule.
  const pool = direct.length >= 2 ? direct : payments;
  const byClosing = new Map<string, Transaction>();
  for (const row of pool) {
    const closing = lastClosing(row.date);
    const offset = daysBetween(closing, row.date);
    if (offset < 3 || offset > DUE_WINDOW_DAYS) continue;
    const known = byClosing.get(closing);
    if (!known || row.amount < known.amount) byClosing.set(closing, row);
  }
  const debits = [...byClosing].sort(([a], [b]) => a.localeCompare(b)).slice(-HISTORY_CYCLES);
  if (!debits.length) return { offsetDays: DEFAULT_DEBIT_OFFSET, basedOn: 0, recent: [] };
  // A Monday debit may have been due on the weekend before, so every skipped day is a candidate.
  const counts = new Map<number, number>();
  for (const [closing, row] of debits) {
    const candidates = [daysBetween(closing, row.date)];
    for (let date = shiftCalendarDate(row.date, -1); date > closing && !isWorkingDay(date); date = shiftCalendarDate(date, -1))
      candidates.push(daysBetween(closing, date));
    for (const offset of candidates) counts.set(offset, (counts.get(offset) ?? 0) + 1);
  }
  const [offsetDays, basedOn] = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return { offsetDays, basedOn, recent: debits.map(([, row]) => row.date) };
}

export function expectedAmexDebit(closing: string, schedule: Pick<AmexDebitSchedule, "offsetDays">) {
  let date = shiftCalendarDate(closing, schedule.offsetDays);
  while (!isWorkingDay(date)) date = shiftCalendarDate(date, 1);
  return date;
}

/** The last working day before the debit: money moved by then is on the giro in time. */
export function amexTransferDeadline(debit: string) {
  let date = shiftCalendarDate(debit, -1);
  while (!isWorkingDay(date)) date = shiftCalendarDate(date, -1);
  return date;
}

/**
 * Start of the period an Amex "Gesamtsaldo" covers on `date`: the open statement, or the closed one
 * before it while its debit has not been booked yet.
 */
export function amexBalancePeriodStart(transactions: readonly Transaction[], date: string) {
  const open = amexCycle(date);
  const closed = previousAmexCycle(open);
  const paid = transactions.some((row) => row.date > closed.closing && row.date <= date && settlement(row));
  return paid || daysBetween(closed.closing, date) > DUE_WINDOW_DAYS ? open.start : closed.start;
}

export type AmexStatementRow = {
  booking: AccountedTransaction;
  /** Charge as a positive amount, credits negative. */
  amount: number;
  partner: boolean;
  /** Already put aside on the Amex Rückzahlung pocket (same amount moved there). */
  reserved: boolean;
  /** Imported, but still waiting in the review queue ("Prüfen"). */
  review: boolean;
};

export type AmexStatement = {
  cycle: AmexCycle;
  /** open: still collecting purchases; due: closed, pocket money still to move; transferred: pocket share moved to the giro. */
  status: "open" | "due" | "transferred";
  /** Amount Amex will debit for this statement. */
  total: number;
  /** Sum of the confirmed bookings up to the 10th. */
  booked: number;
  /** Sum of this statement's imported bookings that still wait in the review queue. */
  pending: number;
  pendingCount: number;
  /** Bookings of this statement in the review queue whose amount or date could not be read. */
  unreadable: number;
  /** Part of the Amex balance that no imported booking explains. */
  missing: number;
  snapshotDate?: string;
  /** Purchases on the partner card. */
  partner: number;
  hasPocket: boolean;
  pocketName: string;
  pocketBalance: number;
  /** Already on the pocket for purchases from the 11th; stays there for the next statement. */
  nextReserved: number;
  /** Take this from the pocket for this statement. */
  fromPocket: number;
  /** Still to pay on top of the pocket. */
  additional: number;
  /** Moved from the pocket since the statement date. */
  transferred: number;
  transferredOn?: string;
  /** Still to move from the pocket to the giro. */
  toTransfer: number;
  expectedDebit: string;
  deadline: string;
  daysLeft: number;
  schedule: AmexDebitSchedule;
  rows: AmexStatementRow[];
  lastDebit?: { date: string; amount: number };
};

type Deposit = { row: Transaction; used: boolean };

/**
 * Imported Amex bookings that still wait in the review queue ("Prüfen"): they are on the bill, only not confirmed yet.
 * Drafts that repair an existing booking and card repayments are left out; drafts without amount or date are only counted.
 */
function waitingBookings(state: AppState, known: ReadonlySet<string>, today: string) {
  const drafts = (state.reviewQueue ?? []).flatMap((item) => item.kind === "booking" && !item.sourceRepair ? [item.draft] : [])
    .filter((draft) => !known.has(draft.id) && (!draft.date || draft.date <= today));
  const ready: AccountedTransaction[] = [];
  const unreadable: { date: string; capturedAt?: string }[] = [];
  for (const draft of drafts) {
    if (!isAmexCard(draft as Transaction)) continue;
    if (!draft.date || draft.amount === null) {
      unreadable.push({ date: draft.date, ...(draft.amexCapturedAt ? { capturedAt: draft.amexCapturedAt } : {}) });
      continue;
    }
    const row: Transaction = { ...draft, date: draft.date, amount: draft.amount };
    if (!isAmexCardPayment(row) && !cardSettlement(row)) ready.push(row);
  }
  return { ready, unreadable };
}

/**
 * Two or three own purchases that one transfer to the pocket covers to the cent (e.g. a big purchase and a small one of the
 * same day moved together). Only for amounts with cents, so a round transfer never matches by chance.
 */
function coveredTogether(charges: readonly Transaction[], amount: number): Transaction[] | undefined {
  if (amount % 100 === 0 || charges.length < 2) return undefined;
  const pool = charges.slice(-30);
  for (let a = 0; a < pool.length; a += 1) {
    for (let b = a + 1; b < pool.length; b += 1) {
      const pair = cents(-pool[a].amount) + cents(-pool[b].amount);
      if (pair === amount) return [pool[a], pool[b]];
      if (pair >= amount) continue;
      for (let c = b + 1; c < pool.length; c += 1)
        if (pair + cents(-pool[c].amount) === amount) return [pool[a], pool[b], pool[c]];
    }
  }
  return undefined;
}

/** Exact amount or rounded up to the next euro – the way purchases are mirrored onto the pocket. */
function mirrors(deposit: number, charge: number) {
  return deposit === charge || (charge % 100 !== 0 && deposit === Math.ceil(charge / 100) * 100);
}

/**
 * The statement that is due next (purchases up to the 10th), how much of it comes from the
 * "Amex Rückzahlung" pocket, what has to be paid on top and by when the pocket money must be on the giro.
 */
export function amexStatement(
  state: AppState,
  bookings: readonly AccountedTransaction[],
  today = state.settings.asOf,
): AmexStatement | null {
  // Card-side transfer credits stay in: they cancel their counterpart on the same statement.
  const known = new Set(bookings.map((row) => row.id));
  const waiting = waitingBookings(state, known, today);
  const waitingIds = new Set(waiting.ready.map((row) => row.id));
  const cards = [...bookings.filter((row) => isAmexCard(row) && row.date <= today && !isAmexCardPayment(row)), ...waiting.ready];
  const snapshots = (state.amexBalanceSnapshots ?? []).filter((item) => item.date <= today);
  if (!cards.length && !snapshots.length) return null;

  const open = amexCycle(today);
  const closed = previousAmexCycle(open);
  const payments = bookings.filter((row) => row.date <= today && settlement(row));
  const paidClosed = payments.some((row) => row.date > closed.closing);
  const closedRows = cards.filter((row) => row.date >= closed.start && row.date <= closed.closing);
  const due = !paidClosed && daysBetween(closed.closing, today) <= DUE_WINDOW_DAYS &&
    (closedRows.length > 0 || snapshots.some((item) => item.periodStart === closed.start));
  const cycle = due ? closed : open;

  const statementRows = cards.filter((row) => row.date >= cycle.start && row.date <= cycle.closing);
  const booked = statementRows.filter((row) => !waitingIds.has(row.id)).reduce((total, row) => total - cents(row.amount), 0);
  const inReview = statementRows.filter((row) => waitingIds.has(row.id));
  const pending = inReview.reduce((total, row) => total - cents(row.amount), 0);
  const unreadable = waiting.unreadable.filter((item) => item.date
    ? item.date >= cycle.start && item.date <= cycle.closing
    : !!item.capturedAt && item.capturedAt >= cycle.start && item.capturedAt <= cycle.closing).length;
  const snapshot = snapshots.filter((item) => item.periodStart === cycle.start)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  let total = booked + pending;
  if (snapshot) {
    const after = statementRows.filter((row) => row.date > snapshot.date)
      .reduce((sum, row) => sum - cents(row.amount), 0);
    // A balance captured after the statement date already contains the first purchases of the next one.
    const next = cards.filter((row) => row.date > cycle.closing && row.date <= snapshot.date)
      .reduce((sum, row) => sum - cents(row.amount), 0);
    total = cents(snapshot.balance) + cents(snapshot.pendingBalance ?? 0) + after - next;
  }
  total = Math.max(0, total);

  const movements = state.transactions.filter((row) => /^revolut$/i.test(row.bank) &&
    isAmexReservePocket(row.pocket) && row.date <= today);
  const pocketSnapshots = (state.accountSnapshots ?? []).filter((item) =>
    item.bank === "Revolut" && isAmexReservePocket(item.name) && item.date <= today);
  const hasPocket = movements.length > 0 || pocketSnapshots.length > 0;
  const pocketName = (pocketSnapshots.sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.name ??
    movements.at(-1)?.pocket ?? "Amex Rückzahlung").replace(/\s*\(eur\)$/i, "");
  const pocketBalance = cents(amexReserveBalance(state, today));

  const deposits: Deposit[] = movements.filter((row) => row.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date)).map((row) => ({ row, used: false }));
  const reserved = new Set<string>();
  const covered = new Set<string>();
  let nextReserved = 0;
  const own = cards.filter((row) => row.amount < 0 && !isAmexPartnerCard(row) && row.date >= cycle.start)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const charge of own) {
    const amount = cents(-charge.amount);
    const window = (deposit: Deposit) => !deposit.used && deposit.row.date >= shiftCalendarDate(charge.date, -2) &&
      deposit.row.date <= shiftCalendarDate(charge.date, 14);
    const match = deposits.find((deposit) => window(deposit) && cents(deposit.row.amount) === amount) ??
      deposits.find((deposit) => window(deposit) && mirrors(cents(deposit.row.amount), amount));
    if (!match) continue;
    match.used = true;
    covered.add(charge.id);
    if (charge.date <= cycle.closing) reserved.add(charge.id);
    else nextReserved += cents(match.row.amount);
  }
  for (const deposit of deposits.filter((item) => !item.used)) {
    const near = own.filter((charge) => !covered.has(charge.id) && deposit.row.date >= shiftCalendarDate(charge.date, -2) &&
      deposit.row.date <= shiftCalendarDate(charge.date, 14));
    const together = coveredTogether(near, cents(deposit.row.amount));
    if (!together) continue;
    deposit.used = true;
    for (const charge of together) {
      covered.add(charge.id);
      if (charge.date <= cycle.closing) reserved.add(charge.id);
      else nextReserved += cents(-charge.amount);
    }
  }

  // From the statement date on, money leaving the pocket goes to the giro for this bill;
  // same-day back-and-forth corrections on the pocket are not transfers.
  const corrections = deposits.filter((deposit) => !deposit.used).map(({ row }) => `${row.date}|${cents(row.amount)}`);
  const withdrawals = due ? movements.filter((row) => row.amount < 0 && row.date >= cycle.closing &&
    !corrections.includes(`${row.date}|${cents(-row.amount)}`)) : [];
  const transferred = withdrawals.reduce((sum, row) => sum - cents(row.amount), 0);
  nextReserved = Math.min(nextReserved, pocketBalance);
  const fromPocket = Math.min(total, pocketBalance - nextReserved + transferred);
  const toTransfer = Math.max(0, fromPocket - transferred);
  const status = !due ? "open" : transferred > 0 && toTransfer < 100 ? "transferred" : "due";

  const schedule = amexDebitSchedule(bookings, today);
  const expectedDebit = expectedAmexDebit(cycle.closing, schedule);
  const deadline = amexTransferDeadline(expectedDebit);
  const lastPayment = payments.filter(bankSettlement).sort((a, b) => b.date.localeCompare(a.date))[0];
  const rows = statementRows.map((booking) => ({
    booking,
    amount: euros(-cents(booking.amount)),
    partner: isAmexPartnerCard(booking),
    reserved: reserved.has(booking.id),
    review: waitingIds.has(booking.id),
  })).sort((a, b) => b.booking.date.localeCompare(a.booking.date) || b.amount - a.amount);

  return {
    cycle,
    status,
    total: euros(total),
    booked: euros(booked),
    pending: euros(pending),
    pendingCount: inReview.length,
    unreadable,
    missing: euros(Math.max(0, total - booked - pending)),
    ...(snapshot ? { snapshotDate: snapshot.date } : {}),
    partner: euros(statementRows.filter(isAmexPartnerCard).reduce((sum, row) => sum - cents(row.amount), 0)),
    hasPocket,
    pocketName,
    pocketBalance: euros(pocketBalance),
    nextReserved: euros(nextReserved),
    fromPocket: euros(fromPocket),
    additional: euros(total - fromPocket),
    transferred: euros(transferred),
    ...(withdrawals.length ? { transferredOn: withdrawals.map((row) => row.date).sort().at(-1) } : {}),
    toTransfer: euros(toTransfer),
    expectedDebit,
    deadline,
    daysLeft: daysBetween(today, deadline),
    schedule,
    rows,
    ...(lastPayment ? { lastDebit: { date: lastPayment.date, amount: -lastPayment.amount } } : {}),
  };
}
