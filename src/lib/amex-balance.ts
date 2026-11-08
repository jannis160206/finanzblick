import type { AppState, Transaction } from "@/lib/types";
import { personalAmount, type AccountedTransaction } from "@/lib/shared-holiday";
import { merchantAliasSourceKey } from "@/lib/import/merchant-rules";
import { matchPlannedOneOffs, type PlannedOccurrence } from "@/lib/planned-one-offs";

const cents = (value: number) => Math.round(value * 100);
const key = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("de-AT");
const isCard = (row: Transaction) => /^(amex|american express)$/.test(key(row.bank));
const reservePocket = (name: string | null) => /^(amex(?: jannis| konto| pocket| rückzahlung| ruckzahlung| rueckzahlung)?|american express)(?: \(eur\))?$/.test(key(name ?? ""));
const partner = (row: Transaction) => /\braphael\b/i.test(row.pocket ?? "");
const source = (row: Transaction) => [row.description, row.rawDescription, ...(row.rawDetails ?? [])].join(" ");
const cardPayment = (row: Transaction) => isCard(row) && row.amount > 0 &&
  /zahlung\s*\/\s*(?:ü|ue|u)berweisung\s+erhalten/i.test(source(row));
// Amex SEPA creditor ID; legacy workbook rows carry only this or their original category.
const amexDirectDebit = (row: Transaction) => /GB03ZZZSDDDEUT0000000165752/i.test(source(row)) ||
  /^amex abrechnung\b/i.test(row.sourceCategory ?? "");
const bankPayment = (row: Transaction) => !isCard(row) && row.amount < 0 &&
  /^(raiffeisen|revolut)$/i.test(row.bank) &&
  !/einzustecken|einstecken|auszahlung bei pocket|interne? (?:überweisung|umbuchung)/i.test(source(row)) &&
  !/monatsgeb|mitgliedsgeb/i.test(source(row)) &&
  (amexDirectDebit(row) || /american express|AT\s*20\s*1910\s*0000\s*1019\s*5000/i.test(source(row)) ||
    /amex.*(?:abrechnung|sammel|ausgleich|rückzahlung|ruckzahlung|lastschrift)/i.test(source(row)));

function reservedBalance(state: AppState) {
  const snapshot = (state.accountSnapshots ?? [])
    .filter((item) => item.bank === "Revolut" && reservePocket(item.name) && item.date <= state.settings.asOf)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const movements = state.transactions.filter((row) => /^revolut$/i.test(row.bank) &&
    reservePocket(row.pocket) && row.date <= state.settings.asOf && (!snapshot || row.date > snapshot.date));
  return Math.max(0, cents(snapshot?.balance ?? 0) + movements.reduce((total, row) => total + cents(row.amount), 0));
}

type OpenCharge = {
  row: AccountedTransaction;
  remaining: number;
  ownRemaining: number;
  refundable: number;
  merchant: string | undefined;
};

// Only a current funding gap is projected, not the same card bill in every future month.
export function amexFunding(
  state: AppState,
  bookings: AccountedTransaction[],
  occurrences: PlannedOccurrence[] = matchPlannedOneOffs(state.plannedOneOffs, bookings),
) {
  const snapshot = (state.amexBalanceSnapshots ?? []).filter((item) => item.date <= state.settings.asOf)
    .sort((a, b) => b.date.localeCompare(a.date) || b.periodStart.localeCompare(a.periodStart))[0];
  const rows = bookings.filter((row) => row.date <= state.settings.asOf);
  const cards = rows.filter(isCard);
  const payments = rows.filter(bankPayment);
  const matched = new Set<string>();
  const covered = new Set<string>();
  for (const row of cards.filter(cardPayment)) {
    const duplicate = payments.find((payment) => !matched.has(payment.id) &&
      cents(-payment.amount) === cents(row.amount) &&
      Math.abs(Date.parse(payment.date) - Date.parse(row.date)) <= 3 * 86_400_000);
    if (duplicate) {
      matched.add(duplicate.id);
      if (snapshot && duplicate.date <= snapshot.date) covered.add(row.id);
    }
  }
  const events = [...cards.filter((row) => !covered.has(row.id)), ...payments.filter((row) => !matched.has(row.id))]
    .filter((row) => !snapshot || row.date >= snapshot.periodStart)
    .sort((a, b) => a.date.localeCompare(b.date) ||
      Number(a.amount > 0 || bankPayment(a)) - Number(b.amount > 0 || bankPayment(b)));
  const open: OpenCharge[] = [];
  const credit = new Map<boolean, number>();
  let snapshotCredit = 0;
  let ownCredit = 0;
  const repay = (amount: number) => {
    for (const charge of open) {
      if (!charge.remaining) continue;
      const paid = Math.min(charge.remaining, amount);
      charge.ownRemaining -= Math.round(paid * charge.ownRemaining / charge.remaining);
      charge.remaining -= paid;
      amount -= paid;
      if (!amount) break;
    }
    return amount;
  };
  let aligned = false;
  const alignSnapshot = () => {
    if (!snapshot || aligned) return;
    aligned = true;
    const balance = cents(snapshot.balance) + cents(snapshot.pendingBalance ?? 0);
    const known = open.reduce((total, charge) => total + charge.remaining, 0);
    credit.clear();
    ownCredit = 0;
    if (known > Math.max(0, balance)) repay(known - Math.max(0, balance));
    if (balance < 0) {
      snapshotCredit = -balance;
      ownCredit = -balance;
    } else if (balance > known) {
      // A partial scroll still has the full bill. This gap is not a saved booking.
      const missing = balance - known;
      open.push({ row: { id: "amex-unlisted-balance", date: snapshot.periodStart, bank: "Amex", pocket: "Amex",
        description: "Amex-Saldo", amount: -missing / 100, category: "Prüfen", includeInPlan: false },
        remaining: missing, ownRemaining: missing, refundable: missing, merchant: undefined });
    }
  };
  for (const row of events) {
    if (snapshot && row.date > snapshot.date) alignSnapshot();
    const repayment = cardPayment(row) || bankPayment(row);
    if (snapshot && repayment && row.date <= snapshot.date) continue;
    if (!repayment && row.amount < 0) {
      const available = aligned ? snapshotCredit : credit.get(partner(row)) ?? 0;
      const used = Math.min(available, cents(-row.amount));
      if (aligned) snapshotCredit -= used;
      else credit.set(partner(row), available - used);
      const own = partner(row) ? 0 : cents(-personalAmount(row));
      const ownUsed = Math.min(ownCredit, own, aligned ? used : Infinity);
      ownCredit -= ownUsed;
      if (aligned) ownCredit = Math.min(ownCredit, snapshotCredit);
      const remaining = cents(-row.amount) - used;
      open.push({ row, remaining, ownRemaining: Math.min(remaining, own - ownUsed),
        refundable: cents(-row.amount), merchant: merchantAliasSourceKey(row) });
      continue;
    }
    let amount = cents(Math.abs(row.amount));
    if (repayment) {
      const excess = repay(amount);
      if (aligned) {
        snapshotCredit += excess;
        ownCredit += excess;
      }
      // Without a snapshot, excess settlements may belong to missing old statements.
      continue;
    }
    const merchant = merchantAliasSourceKey(row);
    const matches = row.holidayRefundFor
      ? open.filter((charge) => charge.row.id === row.holidayRefundFor && charge.refundable > 0)
      : merchant && !row.sharedRefundUnlinked && !row.holidayRefundPending
        ? open.filter((charge) => charge.merchant === merchant &&
          partner(charge.row) === partner(row) && charge.refundable > 0) : [];
    let unmatched = amount;
    let ownRefund = 0;
    for (const charge of matches) {
      const refund = Math.min(unmatched, charge.refundable);
      const gross = cents(-charge.row.amount);
      const own = partner(charge.row) ? 0 : cents(-personalAmount(charge.row));
      const before = Math.round((gross - charge.refundable) * own / gross);
      charge.refundable -= refund;
      const share = Math.round((gross - charge.refundable) * own / gross) - before;
      ownRefund += share;
      unmatched -= refund;
      if (!unmatched) break;
    }
    if (!partner(row)) {
      ownRefund += unmatched;
    }
    const preferred = new Set(matches);
    const refundable = [...matches, ...open.filter((charge) =>
      !preferred.has(charge) && partner(charge.row) === partner(row))];
    if (aligned) {
      const included = new Set(refundable);
      refundable.push(...open.filter((charge) => !included.has(charge)));
    }
    for (const charge of refundable) {
      const paid = Math.min(charge.remaining, amount);
      charge.remaining -= paid;
      amount -= paid;
      if (!amount) break;
    }
    for (const charge of refundable) {
      const paid = Math.min(charge.ownRemaining, ownRefund);
      charge.ownRemaining -= paid;
      ownRefund -= paid;
      if (!ownRefund) break;
    }
    for (const charge of refundable) charge.ownRemaining = Math.min(charge.ownRemaining, charge.remaining);
    if (aligned) snapshotCredit += amount;
    else credit.set(partner(row), (credit.get(partner(row)) ?? 0) + amount);
    ownCredit += ownRefund;
    if (aligned) ownCredit = Math.min(ownCredit, snapshotCredit);
  }
  alignSnapshot();
  const ownOpen = open.filter((item) => !partner(item.row)).map((item) => ({
    row: item.row,
    amount: item.ownRemaining,
  }));
  const outstanding = open.reduce((total, item) => total + item.remaining, 0);
  const ownOutstanding = ownOpen.reduce((total, item) => total + item.amount, 0);
  const reserved = reservedBalance(state);
  const shortfall = Math.max(0, ownOutstanding - reserved);
  const currentPlans = new Set(occurrences.filter((item) => item.bookingId &&
    item.date.slice(0, 7) === state.settings.asOf.slice(0, 7)).map((item) => item.bookingId));
  // A purchase commitment covers its own unpaid portion, never the real card balance.
  const plannedCoverage = Math.min(shortfall, ownOpen.filter((item) => currentPlans.has(item.row.id))
    .reduce((total, item) => total + item.amount, 0));
  const balance = { outstanding: outstanding / 100, ownOutstanding: ownOutstanding / 100,
    reserved: reserved / 100, shortfall: shortfall / 100 };
  return { ...balance, plannedCoverage: plannedCoverage / 100, additional: (shortfall - plannedCoverage) / 100 };
}
