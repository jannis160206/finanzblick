import {
  emptyMonth,
  emptyPockets,
  fixedCategories,
  pocketNames,
  type AppState,
  type Category,
  type HolidayRange,
  type Pocket,
  type PocketAmounts,
  type Settings,
  type Transaction,
} from "@/lib/types";
import { fixedRowCategory, matchingFixedRow } from "@/lib/fixed";
import {
  legacyFingerprint,
  numberStatementRows,
  statementFingerprint,
} from "@/lib/import/identity";
import { isLunchTime, statementTime } from "@/lib/holidays-at-kaernten";
import { allocateGoals, goalBalance, pocketKey, savingsGoals, transferMatches } from "@/lib/goals";
import { alwaysLunch, isSharedHoliday, isTravelMerchant, isRaphaelPayment, personalAmount, reconcileSharedHoliday, type AccountedTransaction } from "@/lib/shared-holiday";
import { merchantKeyText, recoverMerchant, unresolvedTerminal } from "@/lib/import/merchant-description";
import { earlySpecialSalary, isTTSPayroll, payrollCategory, payrollText, reconcilePayrollSources } from "@/lib/payroll";
import { canonicalCategory, groupedContractCategories, suggestCategory } from "@/lib/categories";
import { monthlyVariableBudget, variableBudgetValue } from "@/lib/variable-budgets";

export const round = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;
export const sum = (values: number[]) =>
  round(values.reduce((total, value) => total + value, 0));
export const monthKey = (date: string) => date.slice(0, 7);
export function addMonths(month: string, count: number): string {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index - 1 + count, 1))
    .toISOString()
    .slice(0, 7);
}
export const monthsForYear = (year: number) =>
  Array.from(
    { length: 12 },
    (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`,
  );
export function daysInMonth(month: string) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index, 0)).getUTCDate();
}
export function monthsBetween(from: string, to: string) {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + tm - fm;
}

const excluded =
  /eventim|ticketmaster|oeticket|magazin salzburg|salzburger verkehr|sky chefs|\blsg\b|roof burger|filomena|bravofly|urlaub|führerschein|fuhrerschein/i;
const merchantPatterns: [RegExp, string][] = [
  [/\bmartin\s+auer\b/i, "Martin Auer"],
  [/bipa/i, "BIPA"],
  [/hotspot/i, "Hotspot"],
  [/trafik/i, "Trafik"],
  [/mensa|mensen/i, "Mensa"],
  [/billa/i, "BILLA"],
  [/\bspar\b|interspar|eurospar/i, "SPAR"],
  [/\bdm\b|dm-drogerie/i, "dm"],
  [/roof burger/i, "Roof Burger"],
  [/burger/i, "Burger"],
  [/foodora/i, "Foodora"],
  [/pizzeria/i, "Pizzeria"],
  [/sakura/i, "Sakura"],
  [/gams/i, "Gams"],
  [/burgschenke/i, "Burgschenke"],
  [/mc\s*donald'?s/i, "McDonald's"],
  [/\bg2a\b/i, "G2A"],
  [/\bpace\s*pay\b/i, "PACE Pay"],
  [/\bomv\b/i, "OMV"],
  [/\bshell\b/i, "Shell"],
  [/\bjet\b.*tank|tank.*\bjet\b/i, "JET"],
  [/amazon|amz/i, "Amazon"],
  [/\batm\b|bankomat/i, "ATM"],
  [/eventim/i, "Eventim"],
  [/magazin salzburg/i, "Magazin Salzburg"],
  [/salzburger verkehr/i, "Salzburger Verkehr"],
  [/sky chefs/i, "Sky Chefs"],
  [/filomena/i, "Filomena"],
];
export function merchantName(description: string) {
  description = recoverMerchant({ description }).description;
  if (unresolvedTerminal(description)) return "Händler unbekannt";
  const known = merchantPatterns.find(([pattern]) => pattern.test(description));
  return (
    known?.[1] ??
    (description
      .toLocaleLowerCase("de-AT")
      .replace(/\b(?:kartenzahlung|pos|zahlung|debit|sepa)\b/g, "")
      .replace(/\d[\d\s:./*-]*/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 70) ||
      "Sonstiges")
  );
}
export function savingsPocket(account: string | null): Pocket | null {
  if (!account) return null;
  if (/^notgroschen$/i.test(account)) return "Notgroschen";
  if (/^urlaub(?: 2026)?$/i.test(account)) return "Urlaub";
  if (/^(sparkonto|sparen)$/i.test(account)) return "Sparkonto";
  if (/^motorrad(?:konto|[- ]konto)?$/i.test(account)) return "Motorrad";
  return null;
}
export function classify(
  transaction: Pick<
    Transaction,
    "description" | "amount" | "category" | "pocket" | "includeInPlan"
  > &
    Partial<Pick<AccountedTransaction, "bank" | "categoryOverride" | "sourceCategory" | "date" | "time" | "holidayReimbursementFor" | "holidayRange" | "sharedWithRaphael" | "rawDescription" | "rawDetails">>,
) {
  const { description, amount } = recoverMerchant(transaction);
  const forcedLunch = alwaysLunch(description);
  const sharedHoliday = isSharedHoliday(transaction);
  const reimbursement = !!transaction.holidayReimbursementFor;
  const payroll = payrollCategory(transaction);
  const specialIncome =
    amount > 0 && /(?:13\.?\s*(?:monats)?(?:gehalt|lohn)|bonus|sonderzahlung|weihnachtsgeld|urlaubsgeld|holiday|rufbereitschaft)/i.test(
      payrollText(transaction),
    );
  const absolute = Math.abs(amount);
  const sourceCategory = transaction.sourceCategory ?? "";
  const isCardSettlement = /(?:amex|american express).*(?:abrechnung|sammel|ausgleich|rückzahlung|ruckzahlung)/i.test(`${description} ${sourceCategory}`) ||
    (/raiffeisen|revolut/i.test(transaction.bank ?? "") && /\bamex\b|american express/i.test(description) && !/monatsgeb|mitgliedsgeb/i.test(description));
  const lunchAllowed = isLunchTime(transaction.date, transaction.time ?? statementTime(description));
  const isCashWithdrawal =
    /^bargeld$/i.test(sourceCategory) &&
    /\batm\b|bankomat|behebung/i.test(description) &&
    absolute !== 20;
  const explicitInternal =
    transaction.categoryOverride && transaction.category === "Transfer intern";
  const isRoundUp =
    !explicitInternal &&
    /auszahlung bei pocket/i.test(description) &&
    absolute < 2;
  const isAmazon = !explicitInternal && /amazon|amz/i.test(description) && !/amazon\s*prime|prime\s*video/i.test(description);
  const isCurrencyExchange = /^revolut$/i.test(transaction.bank ?? "") &&
    /^umtausch$/i.test(sourceCategory) && /^umgetauscht (?:in|von) [a-z]{3}$/i.test(description);
  const isInternal =
    /einzustecken|auszahlung bei pocket|interne? (?:überweisung|umbuchung)|transfer intern|gesendet von revolut|revolut\*|american express europe|zahlung\/überweisung erhalten/i.test(
      description,
    ) ||
    isCardSettlement ||
    isCashWithdrawal ||
    isCurrencyExchange ||
    transaction.category === "Transfer intern" ||
    /transfer intern/i.test(transaction.sourceCategory ?? "");
  const detectedTransfer = !forcedLunch && !sharedHoliday && !reimbursement && (isRoundUp || (isInternal && !isAmazon));
  let category: Category = transaction.category;
  if (isAmazon) category = "Shopping";
  else if (isRoundUp) category = "Transfer";
  else if (isInternal) category = "Transfer intern";
  else if (payroll) category = payroll;
  else if (/leasing|porsche\s*bank/i.test(description)) category = "Leasing";
  else if (/vollkasko/i.test(description)) category = "Vollkasko";
  else if (/haftpflicht|allianz/i.test(description)) category = "Haftpflicht";
  else if (
    /handy(?:vertrag)?|\ba1\b.*telekom|telekom.*\ba1\b/i.test(description)
  )
    category = "Handyvertrag";
  else if (/apple[\s+-]*care/i.test(description)) category = "Apple Care";
  else if (/spotify/i.test(`${description} ${sourceCategory}`))
    category = "Spotify";
  else if (
    /(?:amex|american express).*(?:monatsgeb|platin)/i.test(sourceCategory) ||
    (/amex|american express/i.test(transaction.bank ?? "") &&
      /^monatsgeb.*hr/i.test(description))
  )
    category = "AMEX Monatsgebühr";
  else if (/barber/i.test(description)) category = "Barber";
  else if (/\bg2a\b/i.test(description)) category = "Freizeit";
  else if (
    /paypal/i.test(description) &&
    absolute <= 20 &&
    amount < 0 &&
    /abo|subscription|recurring|wiederkehrend/i.test(
      `${description} ${transaction.sourceCategory ?? ""}`,
    )
  )
    category = "PayPal Abo";
  else if (
    /\bpace\s*pay\b|\bomv\b|\bshell\b|tankstelle|tanken/i.test(description)
  )
    category = "Mobilität";
  else if (forcedLunch) category = "Mittagessen";
  else if (/trafik/i.test(description))
    category = lunchAllowed ? "Mittagessen" : "Sonstiges";
  else if (/billa|\bspar\b|interspar|eurospar/i.test(description))
    category = lunchAllowed && absolute <= 10 ? "Mittagessen" : "Lebensmittel";
  else if (
    /burger|foodora|pizzeria|sakura|gams|burgschenke|mc\s*donald'?s/i.test(
      description,
    )
  )
    category = "Ausgehen";
  else if (/\batm\b|bankomat/i.test(description) && absolute === 20)
    category = "Barber";
  else if (amount < 0) category = suggestCategory(`${description} ${sourceCategory}`) ?? category;
  if (
    transaction.categoryOverride &&
    !isCardSettlement &&
    !(isAmazon && /Transfer/.test(transaction.category))
  )
    category = transaction.category;
  if (category === "Mittagessen" && !lunchAllowed)
    category = /billa|\bspar\b|interspar|eurospar/i.test(description) ? "Lebensmittel" : /bipa/i.test(description) ? "Gesundheit" : /hotspot|mensa|mensen/i.test(description) ? "Ausgehen" : "Sonstiges";
  if (amount > 0 && specialIncome && !detectedTransfer)
    category = payroll ?? "Einkommen";
  // Old imported receipts and learned employer rules can incorrectly force
  // every payroll payment to Gehalt. Keep unrelated manual choices intact.
  if (payroll && !detectedTransfer &&
    (!transaction.categoryOverride || ["Gehalt", "Rufbereitschaft", "Einkommen"].includes(transaction.category)))
    category = payroll;
  if (forcedLunch) category = "Mittagessen";
  category = canonicalCategory(category);
  // Sharing changes the amount, not the purpose of the purchase. Travel stays
  // travel even when an older merchant rule calls a hotel/grocer everyday spend.
  if (!detectedTransfer && !fixedCategories.includes(category) && !isAmazon &&
    (transaction.category === "Urlaub" || /^urlaub\b/i.test(sourceCategory) ||
      (amount < 0 && isTravelMerchant(description)) || transaction.holidayRange)) category = "Urlaub";
  if (unresolvedTerminal(description) && !transaction.holidayRange && !detectedTransfer) category = "Prüfen";
  // A partner transfer must not become a salary receipt before reconciliation.
  if (isRaphaelPayment(transaction) && ["Gehalt", "Rufbereitschaft", "Einkommen"].includes(category)) category = "Sonstiges";
  if (reimbursement) category = "Transfer";
  const isTransfer =
    detectedTransfer ||
    category === "Transfer" ||
    category === "Transfer intern";
  const pocket =
    isRoundUp || isAmazon ? "Sparkonto" : savingsPocket(transaction.pocket);
  const exclusion =
    isAmazon ||
    category === "Urlaub" ||
    /amex raphael/i.test(transaction.pocket ?? "") ||
    excluded.test(`${description} ${transaction.sourceCategory ?? ""}`) ||
    savingsPocket(transaction.pocket) === "Urlaub";
  const fixedOrIncome = fixedCategories.includes(category);
  const includeInPlan =
    amount !== 0 &&
    !isTransfer &&
    !reimbursement &&
    !exclusion &&
    !fixedOrIncome &&
    category !== "Prüfen" &&
    (transaction.includeInPlan || amount > 0);
  return {
    category,
    planCategory: isRoundUp
      ? "Round-up Sparkonto"
      : isAmazon
        ? "Sparkonto"
        : category,
    pocket,
    isTransfer,
    isRoundUp,
    isAmazon,
    includeInPlan,
    merchant: merchantName(description),
    reason: sharedHoliday
      ? "Geteilt: 50 % Eigenanteil, 50 % Raphael"
      : reimbursement
        ? "Ausgleich geteilter Kosten, kein Einkommen"
        : isAmazon
      ? "Amazon: Extraausgabe"
      : /amex raphael/i.test(transaction.pocket ?? "")
        ? "Amex Raphael: nicht im Budget"
        : isTransfer
          ? "Umbuchung"
          : exclusion
            ? "Ausgeschlossen"
            : amount >= 0
              ? "Eingang"
              : category === "Prüfen"
                ? "Zuordnung prüfen"
                : fixedOrIncome
                  ? "Fixkosten / Einkommen"
                  : !transaction.includeInPlan
                    ? "Manuell ausgeschlossen"
                    : "",
  };
}

// Payroll received on the 26th–30th funds the following month, not both months.
export function bookingMonth(row: Transaction): string {
  const month = monthKey(row.date);
  const day = Number(row.date.slice(8, 10));
  const nextMonth = addMonths(month, 1);
  return row.amount > 0 && classify(row).category === "Gehalt" &&
    ((day >= 26 && day <= 30) || earlySpecialSalary(row, nextMonth))
    ? nextMonth
    : month;
}

export function classifyStatementRows(
  rows: Transaction[],
  existing: Transaction[] = [],
): Transaction[] {
  rows = rows.map(recoverMerchant);
  existing = existing.map(recoverMerchant);
  const refundMerchant = (row: Transaction) =>
    `${row.bank.toLowerCase()}|${row.pocket ?? ""}|${merchantName(row.description.replace(/rückerstattung|erstattung|refund|gutschrift|retoure/gi, ""))}`;
  const debits = new Map<string, Transaction[]>();
  for (const row of [...existing, ...rows].sort((a, b) =>
    b.date.localeCompare(a.date),
  )) {
    if (row.amount >= 0 || classify(row).isTransfer) continue;
    const key = refundMerchant(row);
    const matches = debits.get(key) ?? [];
    matches.push(row);
    debits.set(key, matches);
  }
  const paypalMonths = new Map<string, Set<string>>();
  for (const row of [...existing, ...rows]) {
    if (
      !/paypal/i.test(row.description) ||
      row.amount >= 0 ||
      Math.abs(row.amount) > 20
    )
      continue;
    const key = `${row.bank.toLowerCase()}|${merchantName(row.description)}|${row.amount.toFixed(2)}`;
    const months = paypalMonths.get(key) ?? new Set<string>();
    months.add(monthKey(row.date));
    paypalMonths.set(key, months);
  }
  return rows.map((row) => {
    const paypalKey = `${row.bank.toLowerCase()}|${merchantName(row.description)}|${row.amount.toFixed(2)}`;
    const recurring =
      /paypal/i.test(row.description) &&
      (paypalMonths.get(paypalKey)?.size ?? 0) >= 2;
    const original =
      row.amount > 0 && !row.categoryOverride && !classify(row).isTransfer
        ? debits
            .get(refundMerchant(row))
            ?.find(
              (item) =>
                item.date <= row.date && Math.abs(item.amount) >= row.amount,
            )
        : undefined;
    const refund =
      original && !fixedCategories.includes(classify(original).category)
        ? {
            ...row,
            category: classify(original).category,
            categoryOverride: true,
          }
        : row;
    const result = classify(
      recurring && !row.categoryOverride
        ? {
            ...row,
            sourceCategory: `${row.sourceCategory ?? ""} wiederkehrend`,
          }
        : refund,
    );
    return {
      ...refund,
      category: result.category,
      includeInPlan: result.includeInPlan,
    };
  });
}

export const planWeights = [0.15, 0.2, 0.3, 0.35] as const;
// Keep location/merchant words: a foreign burger shop is not the recurring
// home restaurant just because merchantName groups both under 'Burger'.
const holidayMerchantKey = (row: Transaction) => merchantKeyText(recoverMerchant(row).description)
  .replace(/\b\d{1,2}[./]\d{1,2}[./](?:\d{2}|\d{4})\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
  .replace(/\b(?:kartenzahlung|pos|zahlung|debit|sepa)\b/g, " ")
  .replace(/\d+/g, " ").replace(/\s+/g, " ").trim();

export function accountHolidayRanges(rows: AccountedTransaction[], ranges: HolidayRange[] = [], asOf = "9999-12-31"): AccountedTransaction[] {
  const inside = (date: string) => ranges.some((range) => date >= range.from && date <= range.to);
  const clean = rows.map((row) => { const copy = { ...row }; delete copy.holidayRange; return copy; });
  if (!ranges.length) return clean;
  const home = new Set(clean.filter((row) => row.amount < 0 && row.date <= asOf && !inside(row.date) &&
    !classify(row).isTransfer && classify(row).category !== "Urlaub" && !unresolvedTerminal(row.description)).map(holidayMerchantKey));
  return clean.map((row) => {
    const result = classify(row);
    if (row.amount >= 0 || !inside(row.date) || result.isTransfer || result.isAmazon ||
      fixedCategories.includes(result.category) || home.has(holidayMerchantKey(row))) return row;
    return { ...row, holidayRange: true };
  });
}

export function calculatePlan(transactions: Transaction[], asOf: string, holidayRanges: HolidayRange[] = []) {
  const currentMonth = monthKey(asOf);
  const months = [-4, -3, -2, -1].map((offset) =>
    addMonths(currentMonth, offset),
  );
  const currentFactor = Number(asOf.slice(8, 10)) / daysInMonth(currentMonth);
  const groups = new Map<
    string,
    {
      merchant: string;
      category: Category;
      values: number[];
      current: number;
      seen: Set<string>;
    }
  >();
  for (const transaction of accountHolidayRanges(reconcileSharedHoliday(transactions, asOf).bookings, holidayRanges, asOf)) {
    const result = classify(transaction);
    const key = monthKey(transaction.date);
    if (
      !result.includeInPlan ||
      transaction.date > asOf ||
      (!months.includes(key) && key !== currentMonth)
    )
      continue;
    const groupKey = `${result.merchant}|${result.category}`;
    const group = groups.get(groupKey) ?? {
      merchant: result.merchant,
      category: result.category,
      values: [0, 0, 0, 0],
      current: 0,
      seen: new Set<string>(),
    };
    if (key === currentMonth) group.current -= personalAmount(transaction);
    else {
      group.values[months.indexOf(key)] -= personalAmount(transaction);
      group.seen.add(key);
    }
    groups.set(groupKey, group);
  }
  const merchantMonths = new Map<string, Set<string>>();
  for (const group of groups.values()) {
    const seen = merchantMonths.get(group.merchant) ?? new Set<string>();
    group.seen.forEach((key) => seen.add(key));
    merchantMonths.set(group.merchant, seen);
  }
  const rows = [...groups.values()]
    .map((group) => {
      const appearances = merchantMonths.get(group.merchant)!.size;
      const eligible = appearances >= 2;
      const historical = sum(
        group.values.map((value, i) => value * planWeights[i]),
      );
      const currentContribution = round(group.current * currentFactor);
      return {
        merchant: group.merchant,
        category: group.category,
        values: group.values.map(round),
        current: round(group.current),
        appearances,
        eligible,
        historical,
        currentContribution,
        planned: eligible
          ? Math.max(0, round(historical + currentContribution))
          : 0,
      };
    })
    .sort(
      (a, b) => b.planned - a.planned || a.merchant.localeCompare(b.merchant),
    );
  const byCategory = [...new Set(rows.map((row) => row.category))]
    .map((category) => ({
      category,
      total: sum(
        rows
          .filter((row) => row.category === category)
          .map((row) => row.planned),
      ),
    }))
    .filter((row) => row.total > 0);
  return {
    months,
    currentMonth,
    currentFactor,
    rows,
    byCategory,
    total: sum(rows.map((row) => row.planned)),
    currentTotal: sum(rows.map((row) => row.current)),
    historicalTotal: sum(
      rows.filter((row) => row.eligible).map((row) => row.historical),
    ),
    eligibleCount: new Set(
      rows.filter((row) => row.eligible).map((row) => row.merchant),
    ).size,
  };
}

export function monthlyInterest(
  previousEnd: number,
  month: string,
  settings: Settings,
) {
  if (month < monthKey(settings.interestStart) || previousEnd <= 0) return 0;
  const days = daysInMonth(month);
  const changeMonth = monthKey(settings.rateChangeDate);
  const startDay =
    month === monthKey(settings.interestStart)
      ? Number(settings.interestStart.slice(8, 10))
      : 1;
  let effectiveRate = 0;
  for (let day = startDay; day <= days; day++) {
    const historicalRate = settings.interestRates
      ?.filter(
        (item) => item.date <= `${month}-${String(day).padStart(2, "0")}`,
      )
      .sort((a, b) => b.date.localeCompare(a.date))[0]?.rate;
    const rate =
      historicalRate ??
      (month < changeMonth ||
      (month === changeMonth &&
        day < Number(settings.rateChangeDate.slice(8, 10)))
        ? settings.oldRate
        : settings.newRate);
    effectiveRate += rate / days;
  }
  return round(((previousEnd * effectiveRate) / 12) * (1 - 0.275));
}
export function splitSurplus(surplus: number, bikeBalance: number, settings: Settings): PocketAmounts {
  const result = allocateGoals(surplus, [{ id: "motorcycle", name: "Motorrad", pocket: "Motorrad", target: settings.bikeTarget, date: settings.bikePurchaseDate }], { motorcycle: bikeBalance }, monthKey(settings.asOf));
  return { Notgroschen: 0, Motorrad: result.goals.motorcycle, Sparkonto: result.savings, Urlaub: result.vacation };
}
export function roundUpTotal(transactions: Transaction[], month: string) {
  return sum(
    transactions
      .filter((t) => monthKey(t.date) === month && classify(t).isRoundUp)
      .map((t) => Math.abs(t.amount)),
  );
}
function pocketMovements(
  transactions: Transaction[],
  fromExclusive: string,
  toInclusive: string,
  includeBaselineDay = false,
) {
  const movements = emptyPockets();
  const relevant = transactions.filter((transaction) =>
    (transaction.date > fromExclusive ||
      (transaction.date === fromExclusive && includeBaselineDay && transaction.afterBaseline)) &&
    transaction.date <= toInclusive,
  );
  const roundUpPairs = new Map<string, number>();
  for (const transaction of relevant) {
    if (!classify(transaction).isRoundUp) continue;
    const key = `${transaction.date}|${transaction.bank}|${Math.abs(transaction.amount)}`;
    roundUpPairs.set(key, (roundUpPairs.get(key) ?? 0) + 1);
  }
  for (const transaction of relevant) {
    const classified = classify(transaction);
    if (!classified.pocket) continue;
    if (transaction.bank === "Revolut" && classified.pocket === "Notgroschen")
      continue;
    const pairKey = `${transaction.date}|${transaction.bank}|${transaction.amount}`;
    if (
      transaction.amount > 0 &&
      /um eur sparen .*einzustecken/i.test(transaction.description) &&
      (roundUpPairs.get(pairKey) ?? 0) > 0
    ) {
      roundUpPairs.set(pairKey, roundUpPairs.get(pairKey)! - 1);
      continue;
    }
    movements[classified.pocket] += classified.isRoundUp
      ? Math.abs(transaction.amount)
      : transaction.amount;
  }
  pocketNames.forEach((pocket) => {
    movements[pocket] = round(movements[pocket]);
  });
  return movements;
}
export function latestPocketSnapshot(
  state: AppState,
  pocket: Pocket,
  date = state.settings.asOf,
) {
  if (pocket === "Notgroschen") return undefined;
  return state.pocketSnapshots
    ?.filter(
      (item) =>
        item.pocket === pocket &&
        item.date <= date &&
        item.date >= state.settings.baselineDate,
    )
    .sort((a, b) => b.date.localeCompare(a.date))[0];
}
export function latestTRBalance(state: AppState, date = state.settings.asOf) {
  return state.trBalances
    ?.filter((item) => item.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
}
function revolutMovement(
  state: AppState,
  pocket: Pocket,
  from: string,
  to: string,
  transfersOnly = false,
) {
  const native = state.transactions.filter(
    (row) =>
      row.bank === "Revolut" &&
      savingsPocket(row.pocket) === pocket &&
      row.date > from &&
      row.date <= to &&
      (!transfersOnly || classify(row).isTransfer),
  );
  if (pocket !== "Sparkonto" || transfersOnly)
    return sum(native.map((row) => row.amount));
  const covered = new Map<string, number>();
  for (const row of native.filter((row) => classify(row).isTransfer)) {
    const key = `${row.date}|${row.amount}`;
    covered.set(key, (covered.get(key) ?? 0) + 1);
  }
  const extra = state.transactions
    .filter(
      (row) =>
        row.date > from &&
        row.date <= to &&
        classify(row).isAmazon &&
        !native.includes(row),
    )
    .filter((row) => {
      const key = `${row.date}|${row.amount}`;
      if (!(covered.get(key)! > 0)) return true;
      covered.set(key, covered.get(key)! - 1);
      return false;
    });
  return sum([...native, ...extra].map((row) => row.amount));
}
export function actualPockets(state: AppState, date = state.settings.asOf) {
  const movements = pocketMovements(
    state.transactions,
    state.settings.baselineDate,
    date,
    true,
  );
  return Object.fromEntries(
    pocketNames.map((pocket) => {
      if (pocket === "Notgroschen" && latestTRBalance(state, date))
        return [pocket, latestTRBalance(state, date)!.balance];
      const snapshot = latestPocketSnapshot(state, pocket, date);
      return [
        pocket,
        snapshot
          ? round(
              snapshot.balance +
                revolutMovement(state, pocket, snapshot.date, date),
            )
          : round(state.settings.balances[pocket] + movements[pocket]),
      ];
    }),
  ) as PocketAmounts;
}

export function missingFixedCosts(state: AppState) {
  if (Number(state.settings.asOf.slice(8, 10)) <= 5) return [];
  const month = monthKey(state.settings.asOf);
  const bookings = state.transactions.filter(
    (row) =>
      monthKey(row.date) === month &&
      row.date <= state.settings.asOf &&
      row.amount < 0 &&
      !classify(row).isTransfer,
  );
  const receipts = (state.fixedReceipts ?? []).filter(
    (row) =>
      monthKey(row.date) === month &&
      row.date <= state.settings.asOf &&
      row.amount < 0,
  );
  return state.financeRows
    .filter((row) => {
      if (row.kind !== "fixed" || !(row.values[month]! > 0)) return false;
      const category = fixedRowCategory(row);
      return (
        !receipts.some(
          (item) =>
            item.rowId === row.id || (!item.rowId && category && canonicalCategory(item.category) === category &&
              (!groupedContractCategories.includes(category) ||
                (item.booking && matchingFixedRow(state, category, item.booking)?.id === row.id))),
        ) &&
        !bookings.some(
          (item) =>
            (category && classify(item).category === category &&
              (!groupedContractCategories.includes(category) || matchingFixedRow(state, category, item)?.id === row.id)) ||
            item.description.toLowerCase().includes(row.label.toLowerCase()),
        )
      );
    })
    .map((row) => row.label);
}
export function bikeCountdown(
  balance: number,
  plannedTransfer: number,
  settings: Settings,
) {
  const incompleteMonth =
    Number(settings.bikePurchaseDate.slice(8, 10)) <
    Number(settings.asOf.slice(8, 10))
      ? 1
      : 0;
  const months = Math.max(
    1,
    monthsBetween(
      monthKey(settings.asOf),
      monthKey(settings.bikePurchaseDate),
    ) - incompleteMonth,
  );
  const remaining = round(Math.max(0, settings.bikeTarget - balance));
  const required = round(remaining / months);
  const days = Math.max(
    0,
    Math.ceil(
      (Date.parse(`${settings.bikePurchaseDate}T12:00:00Z`) -
        Date.parse(`${settings.asOf}T12:00:00Z`)) /
        86_400_000,
    ),
  );
  return {
    months,
    days,
    remaining,
    required,
    onTrack: plannedTransfer >= required,
    funded: remaining === 0,
    overdue: settings.asOf > settings.bikePurchaseDate && remaining > 0,
    progress: Math.min(100, Math.max(0, (balance / settings.bikeTarget) * 100)),
  };
}
export function financeRowValue(
  row: AppState["financeRows"][number],
  month: string,
  plan: { currentMonth: string },
  holidayRanges: HolidayRange[] = [],
) {
  if (row.kind === "variable" && month >= plan.currentMonth) return variableBudgetValue(row, month, holidayRanges);
  return row.values[month] ?? 0;
}
export function calculateMonthTotals(
  state: AppState,
  month: string,
  plan: { currentMonth: string },
  bookings: AccountedTransaction[] = actualBookings(state),
) {
  const income = sum(
    state.financeRows
      .filter((row) => row.kind === "income")
      .map((row) => row.values[month] ?? 0),
  );
  const salaryPlan = sum(state.financeRows.filter((row) => {
    const category = payrollCategory({ description: row.label, amount: row.values[month] ?? 0 });
    return row.kind === "income" && fixedRowCategory(row) === "Gehalt" &&
      category !== "Einkommen" && category !== "Rufbereitschaft";
  }).map((row) => row.values[month] ?? 0));
  const fixed = sum(
    state.financeRows
      .filter((row) => row.kind === "fixed")
      .map((row) => row.values[month] ?? 0),
  );
  const variableRows = state.financeRows.filter(
    (row) => row.kind === "variable",
  );
  const variablePlan = month >= monthKey(state.settings.asOf)
    ? monthlyVariableBudget(month, state.holidayRanges).total
    : state.months[month]?.variableOverride ?? sum(variableRows.map((row) => financeRowValue(row, month, plan, state.holidayRanges)));
  const actualSpending = sum(
    bookings
      .filter(
        (t) =>
          bookingMonth(t) === month &&
          t.date <= state.settings.asOf &&
          !["Einkommen", "Gehalt", "Rufbereitschaft"].includes(
            classify(t).category,
          ) &&
          !classify(t).isTransfer,
      )
      .map((t) => -personalAmount(t)),
  );
  return {
    income,
    salaryPlan,
    salaryReceived: sum(bookings.filter((row) => row.amount > 0 && isTTSPayroll(row) &&
      row.date <= state.settings.asOf && bookingMonth(row) === month &&
      classify(row).category === "Gehalt" && !classify(row).isTransfer).map((row) => row.amount)),
    received: sum(
      bookings
        .filter(
          (t) =>
            bookingMonth(t) === month &&
            t.date <= state.settings.asOf &&
            ["Einkommen", "Gehalt", "Rufbereitschaft"].includes(
              classify(t).category,
            ) &&
            !classify(t).isTransfer,
        )
        .map((t) => personalAmount(t)),
    ),
    fixed,
    variablePlan,
    actualSpending,
    surplus: round(income - fixed - variablePlan),
  };
}
export function actualBookings(state: AppState): AccountedTransaction[] {
  const account = (rows: Transaction[]) => accountHolidayRanges(
    reconcileSharedHoliday(reconcilePayrollSources(rows), state.settings.asOf).bookings, state.holidayRanges, state.settings.asOf);
  if (!state.fixedReceipts?.length) return account(state.transactions);
  const known = new Set(
    numberStatementRows(state.transactions).flatMap((row) => [
      statementFingerprint(row),
      legacyFingerprint(row),
    ]),
  );
  const receipts: Transaction[] = [];
  for (const item of state.fixedReceipts ?? []) {
    if (known.has(item.key)) continue;
    known.add(item.key);
    receipts.push({
      bank: "Auszugsbeleg",
      pocket: null,
      description: item.category,
      ...item.booking,
      id: item.key,
      date: item.date,
      amount: item.amount,
      category: item.category,
      categoryOverride: true,
      includeInPlan: false,
    });
  }
  return account([...state.transactions, ...receipts]);
}
export function incomingPocketTransfers(state: AppState, pocket: string, month: string, aliases: string[] = []): number {
  const keys = new Set([pocket, ...aliases].map(pocketKey));
  return sum(state.transactions.filter((row) => row.date.slice(0, 7) === month && row.date <= state.settings.asOf && row.amount > 0 && keys.has(pocketKey(row.pocket ?? "")) && classify(row).isTransfer).map((row) => row.amount));
}
export function synchronizeGoals(state: AppState): AppState {
  const actual = actualPockets(state);
  return { ...state, savingsGoals: savingsGoals(state).map((goal) => {
    const reached = goalBalance(state, goal, actual) >= goal.target;
    const snapshot = (state.accountSnapshots ?? []).filter((item) => item.bank === "Revolut" && [goal.pocket, goal.name].some((name) => pocketKey(name) === pocketKey(item.name)) && item.balance >= goal.target && item.date <= state.settings.asOf).sort((a, b) => a.date.localeCompare(b.date))[0];
    return { ...goal, completedAt: goal.completedAt ?? snapshot?.date ?? (reached ? state.settings.asOf : undefined) };
  }) };
}
export function calculateDashboard(state: AppState) {
  const plan = monthlyVariableBudget(monthKey(state.settings.asOf), state.holidayRanges);
  // Reconcile receipt fingerprints once, not twice for each forecast month.
  const bookings = actualBookings(state);
  const actual = actualPockets(state);
  const currentMonth = monthKey(state.settings.asOf);
  const baselineMonth = monthKey(state.settings.baselineDate);
  const historicalOpening = state.months["2026-01"]?.openingBalances;
  let previous = { ...(historicalOpening ?? state.settings.balances) };
  const goals = savingsGoals(state);
  const actualGoals = Object.fromEntries(goals.map((goal) => [goal.id, goalBalance(state, goal, actual)]));
  let projectedGoals = Object.fromEntries(goals.map((goal) => [goal.id, pocketKey(goal.pocket) === "motorrad" ? previous.Motorrad : 0]));
  const timeline = [...monthsForYear(2026), ...monthsForYear(2027)].map((month) => {
    const totals = calculateMonthTotals(state, month, plan, bookings);
    const input = state.months[month] ?? emptyMonth();
    const historical = month < baselineMonth;
    const available = !historical || !!historicalOpening;
    const start = { ...(month === currentMonth ? actual : month === baselineMonth ? state.settings.balances : previous) };
    const from = month === baselineMonth ? state.settings.baselineDate : `${addMonths(month, -1)}-${daysInMonth(addMonths(month, -1))}`;
    const monthEnd = `${month}-${daysInMonth(month)}`;
    const snapshotDate = monthEnd < state.settings.asOf ? monthEnd : state.settings.asOf;
    const movement = !historical ? pocketMovements(state.transactions, from, monthEnd, month === baselineMonth) : emptyPockets();
    for (const pocket of pocketNames) {
      if (latestPocketSnapshot(state, pocket, snapshotDate) && month > currentMonth)
        movement[pocket] = revolutMovement(state, pocket, from, monthEnd);
    }
    const interest = available ? monthlyInterest(month === currentMonth && latestTRBalance(state, snapshotDate) ? latestTRBalance(state, snapshotDate)!.balance : start.Notgroschen, month, state.settings) : 0;
    if (month === currentMonth) projectedGoals = Object.fromEntries(goals.map((goal) => [goal.id, Math.max(0, actualGoals[goal.id] - incomingPocketTransfers(state, goal.pocket, month, [goal.name]))]));
    const allocation = allocateGoals(historical ? 0 : totals.surplus, goals, projectedGoals, month);
    const split = { ...emptyPockets(), Sparkonto: allocation.savings, Urlaub: allocation.vacation };
    for (const goal of goals) {
      if (pocketKey(goal.pocket) === "motorrad") split.Motorrad += allocation.goals[goal.id];
      projectedGoals[goal.id] = round(Math.max(projectedGoals[goal.id] + allocation.goals[goal.id], month === currentMonth ? actualGoals[goal.id] : 0));
    }
    const end = { ...start };
    const rates = emptyPockets();
    for (const pocket of pocketNames) {
      rates[pocket] = round(historical ? input.pocketIn[pocket] : split[pocket]);
      const settled = month === currentMonth ? incomingPocketTransfers(state, pocket, month) : 0;
      end[pocket] = available ? round(start[pocket] + rates[pocket] - Math.min(rates[pocket], settled) + (month === currentMonth ? 0 : movement[pocket]) - input.pocketOut[pocket] + (pocket === "Notgroschen" ? interest : 0)) : start[pocket];
      if (month < currentMonth && latestPocketSnapshot(state, pocket, monthEnd)) end[pocket] = actualPockets(state, monthEnd)[pocket];
      if (pocket === "Notgroschen" && month <= currentMonth && latestTRBalance(state, snapshotDate)) end[pocket] = latestTRBalance(state, snapshotDate)!.balance;
    }
    if (available) previous = end;
    return { month, ...totals, start, rates, goalRates: allocation.goals, goalEnd: { ...projectedGoals }, out: input.pocketOut, movement, end, interest, bikeTransfer: rates.Motorrad, available,
      remaining: round(totals.surplus - sum(Object.values(allocation.goals))), roundUp: roundUpTotal(state.transactions, month),
      total: sum([...Object.values(end), ...goals.filter((goal) => pocketKey(goal.pocket) !== "motorrad").map((goal) => projectedGoals[goal.id])]),
      warning: !historical && (Object.values(end).some((value) => value < 0) || sum(Object.values(input.pocketIn)) > Math.max(0, totals.surplus)),
    };
  });
  const current = timeline.find((row) => row.month === currentMonth) ?? { ...calculateMonthTotals(state, currentMonth, plan, bookings), month: currentMonth, bikeTransfer: 0, remaining: 0 };
  const allocationMonth = currentMonth;
  const nextTransfer = timeline.find((row) => row.month === allocationMonth)?.bikeTransfer ?? 0;
  const motorcycle = goals.find((goal) => pocketKey(goal.pocket) === "motorrad");
  const countdown = bikeCountdown(actual.Motorrad, nextTransfer, motorcycle ? { ...state.settings, bikeTarget: motorcycle.target, bikePurchaseDate: motorcycle.date } : state.settings);
  const ninetyDays = [0, 1, 2].map((offset) => {
    const month = addMonths(currentMonth, offset);
    return timeline.find((row) => row.month === month) ?? { month, ...calculateMonthTotals(state, month, plan, bookings), bikeTransfer: 0, remaining: calculateMonthTotals(state, month, plan, bookings).surplus };
  });
  const categorySpending = new Map<string, number>();
  for (const transaction of bookings) {
    const result = classify(transaction);
    if (monthKey(transaction.date) !== currentMonth || transaction.date > state.settings.asOf || ["Einkommen", "Gehalt", "Rufbereitschaft"].includes(result.category) || result.isTransfer) continue;
    categorySpending.set(result.category, (categorySpending.get(result.category) ?? 0) - personalAmount(transaction));
  }
  const currentRow = timeline.find((row) => row.month === currentMonth);
  return { plan, goals, actualGoals,
    monthlyFunding: [
      { id: "savings", name: "Sparkonto", pocket: "Sparkonto", amount: currentRow?.rates.Sparkonto ?? 0 },
      ...[...goals].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).map((goal) => ({ ...goal, amount: currentRow?.goalRates[goal.id] ?? 0 })),
      { id: "vacation", name: "Urlaub", pocket: "Urlaub", amount: currentRow?.rates.Urlaub ?? 0 },
    ].filter((item) => item.amount > 0).map((item) => ({ ...item, done: transferMatches(item.amount, incomingPocketTransfers(state, item.pocket, currentMonth, [item.name])) })),
    currentMonth, current, missingFixed: missingFixedCosts(state), timeline, actual,
    totalAssets: sum([...Object.values(actual), ...goals.filter((goal) => pocketKey(goal.pocket) !== "motorrad").map((goal) => actualGoals[goal.id])]),
    countdown, nextTransfer, allocationMonth, ninetyDays,
    currentRoundUp: roundUpTotal(state.transactions.filter((t) => t.date <= state.settings.asOf), currentMonth),
    spending: [...categorySpending].map(([name, value]) => ({ name, value: round(value) })).sort((a, b) => b.value - a.value),
  };
}
export type Dashboard = ReturnType<typeof calculateDashboard>;
