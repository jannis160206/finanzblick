import type { AppState, Transaction } from "@/lib/types";
import { classify } from "@/lib/calc";
import { matchingFixedRow } from "@/lib/fixed";
import { personalAmount, type AccountedTransaction } from "@/lib/shared-holiday";
import type { PlannedOccurrence } from "@/lib/planned-one-offs";
import { monthlyVariableBudget, variableBudgetId } from "@/lib/variable-budgets";
import { merchantAliasSourceKey } from "@/lib/import/merchant-rules";

const cents = (value: number) => Math.round(value * 100);
const key = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("de-AT");
const isCard = (row: Transaction) => /^(amex|american express)$/.test(key(row.bank));
const ownPocket = (name: string | null) => /^(amex(?: jannis| konto| pocket)?|american express)$/.test(key(name ?? ""));
const partner = (row: Transaction) => /\braphael\b/i.test(row.pocket ?? "");
const source = (row: Transaction) => [row.description, row.rawDescription, ...(row.rawDetails ?? [])].join(" ");
const cardPayment = (row: Transaction) => isCard(row) && row.amount > 0 &&
  /zahlung\s*\/\s*überweisung\s+erhalten/i.test(source(row));
const bankPayment = (row: Transaction) => !isCard(row) && row.amount < 0 &&
  /^(raiffeisen|revolut)$/i.test(row.bank) &&
  !/einzustecken|einstecken|auszahlung bei pocket|interne? (?:überweisung|umbuchung)/i.test(source(row)) &&
  !/monatsgeb|mitgliedsgeb/i.test(source(row)) &&
  (/american express|AT\s*20\s*1910\s*0000\s*1019\s*5000/i.test(source(row)) ||
    /amex.*(?:abrechnung|sammel|ausgleich|rückzahlung|ruckzahlung|lastschrift)/i.test(source(row)));

function reservedBalance(state: AppState) {
  const snapshot = (state.accountSnapshots ?? [])
    .filter((item) => ownPocket(item.name) && item.date <= state.settings.asOf)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const movements = state.transactions.filter((row) => /^revolut$/i.test(row.bank) &&
    ownPocket(row.pocket) && row.date <= state.settings.asOf && (!snapshot || row.date > snapshot.date));
  return Math.max(0, cents(snapshot?.balance ?? 0) + movements.reduce((total, row) => total + cents(row.amount), 0));
}

type OpenCharge = {
  row: AccountedTransaction;
  remaining: number;
  ownRemaining: number;
  refundable: number;
  ownRefunded: number;
  merchant: string | undefined;
};

// Only a current funding gap is projected, not the same card bill in every future month.
export function amexFunding(
  state: AppState,
  bookings: AccountedTransaction[],
  occurrences: PlannedOccurrence[],
) {
  const rows = bookings.filter((row) => row.date <= state.settings.asOf);
  const cards = rows.filter(isCard);
  const payments = rows.filter(bankPayment);
  const matched = new Set<string>();
  for (const row of cards.filter(cardPayment)) {
    const duplicate = payments.find((payment) => !matched.has(payment.id) &&
      cents(-payment.amount) === cents(row.amount) &&
      Math.abs(Date.parse(payment.date) - Date.parse(row.date)) <= 3 * 86_400_000);
    if (duplicate) matched.add(duplicate.id);
  }
  const events = [...cards, ...payments.filter((row) => !matched.has(row.id))]
    .sort((a, b) => a.date.localeCompare(b.date) ||
      Number(a.amount > 0 || bankPayment(a)) - Number(b.amount > 0 || bankPayment(b)));
  const open: OpenCharge[] = [];
  const credit = new Map<boolean, number>();
  let ownCredit = 0;
  const unmatchedRefunds = new Map<string, number>();
  for (const row of events) {
    const repayment = cardPayment(row) || bankPayment(row);
    if (!repayment && row.amount < 0) {
      const available = credit.get(partner(row)) ?? 0;
      const used = Math.min(available, cents(-row.amount));
      credit.set(partner(row), available - used);
      const own = partner(row) ? 0 : cents(-personalAmount(row));
      const ownUsed = Math.min(ownCredit, own);
      ownCredit -= ownUsed;
      const remaining = cents(-row.amount) - used;
      open.push({ row, remaining, ownRemaining: Math.min(remaining, own - ownUsed),
        refundable: cents(-row.amount), ownRefunded: 0, merchant: merchantAliasSourceKey(row) });
      continue;
    }
    let amount = cents(Math.abs(row.amount));
    if (repayment) {
      for (const charge of open) {
        if (!charge.remaining) continue;
        const paid = Math.min(charge.remaining, amount);
        charge.ownRemaining -= Math.round(paid * charge.ownRemaining / charge.remaining);
        charge.remaining -= paid;
        amount -= paid;
        if (!amount) break;
      }
      // Excess old settlements can belong to statements that were never imported.
      continue;
    }
    const merchant = merchantAliasSourceKey(row);
    const matches = merchant ? open.filter((charge) => charge.merchant === merchant &&
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
      charge.ownRefunded += share;
      ownRefund += share;
      unmatched -= refund;
      if (!unmatched) break;
    }
    if (!partner(row)) {
      ownRefund += unmatched;
      unmatchedRefunds.set(row.id, unmatched);
    }
    const preferred = new Set(matches);
    const refundable = [...matches, ...open.filter((charge) =>
      !preferred.has(charge) && partner(charge.row) === partner(row))];
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
    credit.set(partner(row), (credit.get(partner(row)) ?? 0) + amount);
    ownCredit += ownRefund;
  }
  const ownOpen = open.filter((item) => !partner(item.row)).map((item) => ({
    row: item.row,
    amount: item.ownRemaining,
  }));
  const outstanding = open.reduce((total, item) => total + item.remaining, 0);
  const ownOutstanding = ownOpen.reduce((total, item) => total + item.amount, 0);
  const reserved = reservedBalance(state);
  const shortfall = Math.max(0, ownOutstanding - reserved);
  const balance = { outstanding: outstanding / 100, ownOutstanding: ownOutstanding / 100,
    reserved: reserved / 100, shortfall: shortfall / 100 };
  if (!shortfall) return { ...balance, plannedCoverage: 0, additional: 0 };
  const month = state.settings.asOf.slice(0, 7);
  const capacities = new Map<string, number>();
  for (const row of monthlyVariableBudget(month, state.holidayRanges).rows)
    capacities.set(`budget:${row.id}`, cents(row.total));
  for (const row of state.financeRows.filter((row) => row.kind === "fixed"))
    capacities.set(`fixed:${row.id}`, cents(Math.max(0, row.values[month] ?? 0)));
  const planned = new Map(occurrences.filter((item) => item.bookingId && item.date.slice(0, 7) === month)
    .map((item) => [item.bookingId!, item]));
  for (const item of planned.values()) capacities.set(item.id, cents(item.ownAmount));
  const coverageKeys = new Map<string, string | undefined>();
  const findCoverage = (row: AccountedTransaction) => {
    const occurrence = planned.get(row.id);
    if (occurrence) return occurrence.id;
    if (row.date.slice(0, 7) !== month) return;
    const result = classify(row);
    if (result.isTransfer) return;
    if (result.isFixedCost) {
      const fixed = matchingFixedRow(state, result.category, row) ??
        (isCard(row) && /^monatsgeb/i.test(row.description)
          ? matchingFixedRow(state, "AMEX Monatsgebühr", row) : undefined);
      return fixed ? `fixed:${fixed.id}` : undefined;
    }
    const budget = result.includeInPlan ? variableBudgetId(result.category, row.fixedCost) : undefined;
    return budget ? `budget:${budget}` : undefined;
  };
  const coverageKey = (row: AccountedTransaction) => {
    if (!coverageKeys.has(row.id)) coverageKeys.set(row.id, findCoverage(row));
    return coverageKeys.get(row.id);
  };
  const openById = new Map(ownOpen.map((item) => [item.row.id, item.amount]));
  const refundedById = new Map(open.map((item) => [item.row.id, item.ownRefunded]));
  const consumed = new Map<string, number>();
  // The same allowance cannot cover both paid purchases and the outstanding card bill.
  for (const row of rows) {
    const group = coverageKey(row);
    if (!group || partner(row)) continue;
    const used = isCard(row) && row.amount > 0
      ? -(unmatchedRefunds.get(row.id) ?? 0)
      : cents(-personalAmount(row)) - (openById.get(row.id) ?? 0) - (refundedById.get(row.id) ?? 0);
    consumed.set(group, (consumed.get(group) ?? 0) + used);
  }
  for (const [group, used] of consumed)
    capacities.set(group, Math.max(0, (capacities.get(group) ?? 0) - Math.max(0, used)));
  let plannedCoverage = 0;
  for (const item of ownOpen) {
    const group = coverageKey(item.row);
    if (!group) continue;
    const covered = Math.min(item.amount, capacities.get(group) ?? 0);
    plannedCoverage += covered;
    capacities.set(group, (capacities.get(group) ?? 0) - covered);
  }
  return {
    ...balance,
    plannedCoverage: Math.min(shortfall, plannedCoverage) / 100,
    additional: Math.max(0, shortfall - plannedCoverage) / 100,
  };
}
