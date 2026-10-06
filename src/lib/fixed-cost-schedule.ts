import { actualBookings, classify, daysInMonth, monthKey, round } from "@/lib/calc";
import { accountLabel } from "@/lib/accounts";
import { canonicalCategory, groupedContractCategories } from "@/lib/categories";
import { fixedRowCategory, matchingFixedRow } from "@/lib/fixed";
import { legacyFingerprint, statementFingerprint } from "@/lib/import/identity";
import { merchantAliasSourceKey } from "@/lib/import/merchant-rules";
import { personalAmount, type AccountedTransaction } from "@/lib/shared-holiday";
import type { AppState, FinanceRow } from "@/lib/types";

export type FixedCostScheduleItem = {
  id: string;
  name: string;
  planned: number;
  openAmount: number;
  bookedAmount: number;
  bookedDates: string[];
  expectedFrom?: string;
  expectedTo?: string;
  account?: string;
  status: "open" | "due" | "unconfirmed" | "booked";
};

function expectedDates(history: AccountedTransaction[], month: string) {
  const previous = history.filter((row) => monthKey(row.date) < month)
    .sort((a, b) => b.date.localeCompare(a.date));
  const recentMonths = new Set([...new Set(previous.map((row) => monthKey(row.date)))].slice(0, 3));
  const recent = previous.filter((row) => recentMonths.has(monthKey(row.date)));
  if (!recent.length) return {};
  const days = recent.map((row) => Number(row.date.slice(8)));
  const atMonthEnd = recent.every((row) => Number(row.date.slice(8)) === daysInMonth(monthKey(row.date)));
  const end = daysInMonth(month);
  const from = atMonthEnd ? end : Math.min(end, ...days);
  const to = atMonthEnd ? end : Math.min(end, Math.max(...days));
  return {
    expectedFrom: `${month}-${String(from).padStart(2, "0")}`,
    expectedTo: `${month}-${String(to).padStart(2, "0")}`,
  };
}

export function fixedCostSchedule(state: AppState) {
  const asOf = state.settings.asOf;
  const month = monthKey(asOf);
  const plans = state.financeRows.filter((row) => row.kind === "fixed" && (row.values[month] ?? 0) > 0);
  const receiptLinks = new Map<string, Set<string>>();
  for (const receipt of state.fixedReceipts ?? []) {
    if (!receipt.rowId) continue;
    for (const key of [receipt.key, ...(receipt.booking ? [
      receipt.booking.id, statementFingerprint(receipt.booking), legacyFingerprint(receipt.booking),
    ] : [])]) {
      const links = receiptLinks.get(key) ?? new Set<string>();
      links.add(receipt.rowId);
      receiptLinks.set(key, links);
    }
  }
  const history = new Map<string, AccountedTransaction[]>();
  for (const booking of actualBookings(state)) {
    if (booking.date > asOf || booking.amount >= 0 || booking.fixedCost === false) continue;
    const result = classify(booking);
    if (result.isTransfer || !result.isFixedCost) continue;
    const linkedIds = new Set([booking.id, statementFingerprint(booking), legacyFingerprint(booking)]
      .flatMap((key) => [...receiptLinks.get(key) ?? []]));
    const explicit = state.financeRows.filter((row) => row.kind === "fixed" && linkedIds.has(row.id) &&
      (!fixedRowCategory(row) || fixedRowCategory(row) === canonicalCategory(result.category)));
    if (explicit.length > 1) continue;
    const matched = explicit.length === 1 ? explicit[0] :
      matchingFixedRow(state, result.category, booking);
    let plan: FinanceRow | undefined = matched;
    if (!plan) {
      const text = [booking.merchantAlias, booking.description, booking.rawDescription]
        .filter(Boolean).join(" ").toLocaleLowerCase("de-AT");
      const named = state.financeRows.filter((row) => row.kind === "fixed" && !row.fixedSource &&
        (!fixedRowCategory(row) || fixedRowCategory(row) === canonicalCategory(result.category)) &&
        text.includes(row.label.toLocaleLowerCase("de-AT")));
      if (named.length === 1) plan = named[0];
    }
    if (!plan) continue;
    const bookings = history.get(plan.id) ?? [];
    bookings.push(booking);
    history.set(plan.id, bookings);
  }
  const items = plans.map((plan): FixedCostScheduleItem => {
    const bookings = history.get(plan.id) ?? [];
    const current = bookings.filter((row) => monthKey(row.date) === month);
    const merchant = (row: AccountedTransaction) => JSON.stringify([merchantAliasSourceKey(row), accountLabel(row)]);
    const category = fixedRowCategory(plan);
    const aggregate = !plan.fixedSource && category && plan.label === category &&
      groupedContractCategories.includes(category) && new Set(bookings.map(merchant)).size > 1;
    const planned = plan.values[month]!;
    const bookedAmount = round(current.reduce((amount, booking) => amount - personalAmount(booking), 0));
    const openAmount = current.length ? aggregate ? round(Math.max(0, planned - bookedAmount)) : 0 : planned;
    const confirmed = new Set(current.map(merchant));
    const dates = expectedDates(aggregate && current.length && openAmount
      ? bookings.filter((row) => !confirmed.has(merchant(row))) : bookings, month);
    const latest = [...bookings].sort((a, b) => b.date.localeCompare(a.date))[0];
    return {
      id: plan.id, name: plan.label, planned, openAmount, bookedAmount,
      bookedDates: [...new Set(current.map((row) => row.date))].sort(),
      ...dates,
      ...(latest && latest.bank !== "Auszugsbeleg" ? { account: accountLabel(latest) } : {}),
      status: !openAmount ? "booked" : !dates.expectedTo || dates.expectedTo > asOf ? "open" :
        dates.expectedTo === asOf ? "due" : "unconfirmed",
    };
  }).sort((a, b) => (a.expectedFrom ?? "9999").localeCompare(b.expectedFrom ?? "9999") || a.name.localeCompare(b.name, "de-AT"));
  const open = items.filter((item) => item.status !== "booked");
  const booked = items.filter((item) => item.bookedDates.length).map((item): FixedCostScheduleItem => ({ ...item, status: "booked" }));
  return {
    month, asOf, open, booked,
    openTotal: round(open.reduce((total, item) => total + item.openAmount, 0)),
    bookedTotal: round(booked.reduce((total, item) => total + item.bookedAmount, 0)),
  };
}
