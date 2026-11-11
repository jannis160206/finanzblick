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
import { fixedRowCategory, isFixedExpense, isIncomeCategory, matchingFixedRow } from "@/lib/fixed";
import {
  legacyFingerprint,
  numberStatementRows,
  statementFingerprint,
} from "@/lib/import/identity";
import { isLunchTime, statementTime } from "@/lib/holidays-at-kaernten";
import { allocateGoals, corePocket, goalBalance, goalBalanceStatus, goalExtraIncome, goalProjectionBalances, physicalAssetTotal, physicalPocketBalances, physicalProjectionTotal, pocketKey, savingsGoals, savingsRate, transferMatches } from "@/lib/goals";
import { isSharedHoliday, isTravelMerchant, isRaphaelPayment, personalAmount, reconcileSharedHoliday, type AccountedTransaction } from "@/lib/shared-holiday";
import { hasRecurringFuelEvidence, merchantPurposeSourceCategory, recurringAmazonCategory, recurringLunchCategory, revolutLunchMerchant, unnamedFuelPurpose } from "@/lib/recurring-purpose";
import { ambiguousMerchant, merchantKeyText, recoverMerchant, unresolvedTerminal } from "@/lib/import/merchant-description";
import { earlySpecialSalary, isTTSPayroll, payrollCategory, payrollText, reconcilePayrollSources } from "@/lib/payroll";
import { reconcileLeasingSources } from "@/lib/leasing";
import { amazonMerchant, groceryMerchant, knownMerchantCategory, canonicalCategory, groupedContractCategories, isTravelCategory } from "@/lib/categories";
import { monthlyVariableBudget, variableBudgetId, variableBudgetValue, type VariableBudgetId } from "@/lib/variable-budgets";
import { hasCategoryChoice, hasManualCategory } from "@/lib/manual-category";
import { categoryParts } from "@/lib/splits";
import { matchPlannedOneOffs, type PlannedOccurrence } from "@/lib/planned-one-offs";
import { amexMerchantCategory } from "@/lib/import/amex-merchants";
import { amexFunding } from "@/lib/amex-balance";
import { isDutyFreePurchase } from "@/lib/booking-purpose";
import { applyNamedTransfer, isNamedTransfer, revolutSavingsTransferAmount } from "@/lib/transfers";
import { bankOperation, bankTransferPurpose } from "@/lib/bank-operation";
import { planningMonths } from "@/lib/planning-range";
import { trInterestRate } from "@/lib/tr-interest";

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
export function knownMerchantName(description: string) {
  return merchantPatterns.find(([pattern]) => pattern.test(description))?.[1];
}
export function merchantName(description: string, alias?: string) {
  if (alias) return alias;
  description = recoverMerchant({ description }).description;
  if (unresolvedTerminal(description)) return "Händler unbekannt";
  const known = knownMerchantName(description);
  return (
    known ??
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
type ClassifyInput = Parameters<typeof classifyUncached>[0];
type Classification = ReturnType<typeof classifyUncached>;
// Set by accountHolidayRanges on would-be lunch bookings inside a stored vacation: no lunch rule applies then.
type VacationMarker = { vacationDay?: boolean };
const classificationCache = new WeakMap<object, { fields: Map<string, unknown>; result: Classification }>();
const sameFields = (fields: Map<string, unknown>, entries: [string, unknown][]) =>
  fields.size === entries.length && entries.every(([key, value]) => fields.has(key) && Object.is(fields.get(key), value));
// classify is pure in its input. A cached result is reused only while every top-level
// field of the very same booking object is unchanged, so in-place edits cannot go stale.
export function classify(transaction: ClassifyInput): Classification {
  const entries = Object.entries(transaction);
  const hit = classificationCache.get(transaction);
  if (hit && sameFields(hit.fields, entries)) return { ...hit.result };
  const result = classifyUncached(transaction);
  classificationCache.set(transaction, { fields: new Map(entries), result });
  return { ...result };
}
function classifyUncached(
  transaction: Pick<
    Transaction,
    "description" | "amount" | "category" | "pocket" | "includeInPlan"
  > &
    Partial<Pick<AccountedTransaction, "bank" | "categoryOverride" | "manualCategory" | "fixedCost" | "sourceCategory" | "date" | "time" | "holidayReimbursementFor" | "sharedRepaymentFor" | "holidayRange" | "sharedWithRaphael" | "rawDescription" | "rawDetails" | "merchantAlias" | "automaticCategoryEvidence" | "ignored" | "reviewed">> &
    VacationMarker,
) : ReturnType<typeof classifyCounted> & { ignored?: true } {
  if (!transaction.ignored) return classifyCounted(transaction);
  // Ignored bookings keep their category and pocket (balances stay correct) but count like
  // a transfer, so every spending, income, budget and insight calculation skips them.
  return {
    ...classifyCounted(transaction), isTransfer: true, isFixedCost: false, includeInPlan: false,
    ignored: true as const, reason: "Ignoriert · zählt in keiner Statistik",
  };
}
function classifyCounted(transaction: Parameters<typeof classifyUncached>[0]) {
  const recovered = recoverMerchant(transaction);
  const { description, amount } = recovered;
  const dutyFreeShopping = transaction.categoryOverride &&
    transaction.automaticCategoryEvidence?.category === "Shopping" &&
    isDutyFreePurchase(`${description} ${transaction.merchantAlias ?? ""}`);
  if (isNamedTransfer(recovered) || (transaction.holidayReimbursementFor && transaction.sharedRepaymentFor)) {
    return {
      category: "Transfer" as const, planCategory: "Transfer" as const,
      pocket: savingsPocket(transaction.pocket),
      isTransfer: true, isFixedCost: false, isRoundUp: false, isAmazon: false,
      includeInPlan: false, merchant: merchantName(description, transaction.merchantAlias),
      reason: "Transfer erkannt",
    };
  }
  if (hasManualCategory(transaction)) {
    const category = canonicalCategory(transaction.category);
    const isTransfer = category === "Transfer" || category === "Transfer intern";
    const isFixedCost = !isTransfer && isFixedExpense({ amount, category, fixedCost: transaction.fixedCost });
    const fixedOrIncome = isFixedCost || isIncomeCategory(category) ||
      (amount >= 0 && transaction.fixedCost !== false && fixedCategories.includes(category));
    return {
      category, planCategory: category, pocket: savingsPocket(transaction.pocket),
      isTransfer, isFixedCost, isRoundUp: false, isAmazon: amazonMerchant.test(description),
      includeInPlan: amount !== 0 && !isTransfer && !fixedOrIncome && category !== "Prüfen" &&
        !isTravelCategory(category) && (transaction.includeInPlan || amount > 0),
      merchant: merchantName(description, transaction.merchantAlias),
      reason: category === "Prüfen" ? "Zuordnung prüfen"
        : isTransfer ? "Manuell zugeordnet: Umbuchung"
          : fixedOrIncome ? "Manuell zugeordnet: Fixkosten / Einkommen"
            : isSharedHoliday(transaction) ? "Manuell zugeordnet; geteilt: 50 % Eigenanteil, 50 % Raphael"
              : isTravelCategory(category) ? "Manuell zugeordnet: Reiseausgabe"
                : !transaction.includeInPlan ? "Manuell ausgeschlossen" : "Manuell zugeordnet",
    };
  }
  const sourceText = [description, transaction.rawDescription ?? transaction.description, ...(transaction.rawDetails ?? []), merchantPurposeSourceCategory(transaction.sourceCategory)].filter(Boolean).join(" ");
  const operation = bankOperation(transaction);
  const operationCategory = operation?.kind === "external-transfer"
    ? (transaction.category === "Transfer" || transaction.category === "Transfer intern"
      ? transaction.category : bankTransferPurpose(transaction) ?? operation.category)
    : operation?.category;
  const known = operationCategory ?? knownMerchantCategory(sourceText, amount) ?? amexMerchantCategory({ ...recovered, description, amount });
  const vacation = transaction.vacationDay === true;
  const lunchPurpose = known !== "Prüfen"
    ? recurringLunchCategory(description, transaction.date, amount, vacation)
    : undefined;
  const forcedLunch = lunchPurpose === "Mittagessen";
  const sharedHoliday = isSharedHoliday(transaction);
  const reimbursement = !!transaction.holidayReimbursementFor;
  const payroll = payrollCategory(transaction);
  const specialIncome =
    amount > 0 && /(?:13\.?\s*(?:monats)?(?:gehalt|lohn)|bonus|sonderzahlung|weihnachtsgeld|urlaubsgeld|holiday|rufbereitschaft)/i.test(
      payrollText(transaction),
    );
  const absolute = Math.abs(amount);
  const sourceCategory = transaction.sourceCategory ?? "";
  const isCardSettlement = /(?:amex|american express).*(?:abrechnung|sammel|ausgleich|rückzahlung|ruckzahlung)/i.test(sourceText) ||
    (/raiffeisen|revolut/i.test(transaction.bank ?? "") && /\bamex\b|american express|AT\s*20\s*1910\s*0000\s*1019\s*5000/i.test(sourceText) && !/monatsgeb|mitgliedsgeb/i.test(sourceText));
  let lunchAllowed: boolean | undefined;
  const allowsLunch = () => lunchAllowed ??= !vacation && isLunchTime(transaction.date, transaction.time ?? statementTime(transaction.rawDescription, transaction.description, ...(transaction.rawDetails ?? [])));
  const isRoundUp =
    /auszahlung bei pocket/i.test(description) &&
    absolute < 2;
  const explicitSavingsTransfer = transaction.categoryOverride && transaction.category === "Transfer intern" && savingsPocket(transaction.pocket);
  const isAmazon = amazonMerchant.test(description) && !explicitSavingsTransfer;
  const isCurrencyExchange = /^revolut$/i.test(transaction.bank ?? "") &&
    /^umtausch$/i.test(sourceCategory) && /^umgetauscht (?:in|von) [a-z]{3}$/i.test(description);
  const isInternal =
   operation?.kind === "internal-transfer" ||
   (!operation && (/einzustecken|einstecken|auszahlung bei pocket|interne? (?:überweisung|umbuchung)|transfer intern|gesendet von revolut|revolut\*|american express europe|zahlung\s*\/\s*(?:ü|ue|u)berweisung\s+erhalten/i.test(
      sourceText,
    ) ||
    (/^revolut$/i.test(transaction.bank ?? "") && /\bto jannis br(?:ü|ue)hl\b/i.test(description)) ||
    (/^raiffeisen$/i.test(transaction.bank ?? "") && /\bLT25\s*\d[\d\s]+/i.test(sourceText)) ||
    isCardSettlement ||
    isCurrencyExchange ||
    transaction.category === "Transfer intern" ||
    /transfer intern/i.test(transaction.sourceCategory ?? "")));
  const detectedTransfer = !forcedLunch && !sharedHoliday && !reimbursement && (isRoundUp || (isInternal && !isAmazon));
  // Automatic choices only: manual and learned categories (override without automatic evidence) keep winning.
  const revolutLunch = !operation && amount < 0 && known !== "Prüfen" && !detectedTransfer && !isAmazon &&
    !hasCategoryChoice(transaction) && (!transaction.categoryOverride || !!transaction.automaticCategoryEvidence) &&
    revolutLunchMerchant(transaction.bank, description, transaction.merchantAlias) && allowsLunch();
  const ruleLunch = forcedLunch || revolutLunch;
  let category: Category = transaction.category;
  if (operationCategory) category = operationCategory;
  else if (isAmazon) category = "Shopping";
  else if (isRoundUp) category = "Transfer intern";
  else if (isInternal) category = "Transfer intern";
  else if (payroll) category = payroll;
  else if (known) category = known === "Lebensmittel" && absolute <= 10 && allowsLunch() ? "Mittagessen" : known;
  else if (
    /(?:amex|american express).*(?:monatsgeb|platin)/i.test(sourceCategory) ||
    (/amex|american express/i.test(transaction.bank ?? "") &&
      /^monatsgeb.*hr/i.test(description))
  )
    category = "AMEX Monatsgebühr";
  if (
    transaction.categoryOverride &&
    !detectedTransfer &&
    !(isAmazon && /Transfer/.test(transaction.category))
  )
    category = transaction.category;
  if (category === "Mittagessen" && !ruleLunch && !allowsLunch())
    category = lunchPurpose ?? (groceryMerchant.test(description) ? "Lebensmittel" : "Prüfen");
  if (/\btrafik\b/i.test(description)) category = "Shopping";
  if (!operation && (isAmazon || recurringAmazonCategory(description))) category = recurringAmazonCategory(description) ?? "Shopping";
  if (!operation && unnamedFuelPurpose(description, amount) && hasRecurringFuelEvidence(transaction)) category = "Tanken";
  if (isRoundUp) category = "Transfer intern";
  if (amount > 0 && specialIncome && !detectedTransfer)
    category = payroll ?? "Einkommen";
  // Old imported receipts and learned employer rules can incorrectly force
  // every payroll payment to Gehalt. Keep unrelated manual choices intact.
  if (payroll && !detectedTransfer &&
    (!transaction.categoryOverride || ["Gehalt", "Rufbereitschaft", "Einkommen"].includes(transaction.category)))
    category = payroll;
  if (ruleLunch) category = "Mittagessen";
  else if (lunchPurpose && category === "Mittagessen") category = lunchPurpose;
  if (operation?.kind === "interest") category = operation.category;
  if (detectedTransfer) category = "Transfer intern";
  category = canonicalCategory(category);
  // Sharing changes the amount, not the purpose of the purchase. Travel stays
  // travel even when an older merchant rule calls a hotel/grocer everyday spend.
  if (!detectedTransfer && !ruleLunch &&
    !dutyFreeShopping &&
    !(transaction.fixedCost !== false && fixedCategories.includes(category)) &&
    !isFixedExpense({ amount, category, fixedCost: transaction.fixedCost }) &&
    !isIncomeCategory(category) && !isAmazon && !isTravelCategory(category) &&
    (transaction.category === "Urlaub" || /^urlaub\b/i.test(sourceCategory) ||
      (amount < 0 && isTravelMerchant(description)) || transaction.holidayRange)) category = "Urlaub";
  if (!transaction.categoryOverride && unresolvedTerminal(description) && !transaction.holidayRange && !detectedTransfer) category = "Prüfen";
  if (!transaction.categoryOverride && ambiguousMerchant(recovered) && !detectedTransfer) category = "Prüfen";
  if (known === "Prüfen" && !transaction.categoryOverride && !detectedTransfer &&
    !(operation?.kind === "external-transfer" && payroll)) category = "Prüfen";
  if (amount > 0 && transaction.categoryOverride && transaction.category === "Rückerstattungen" &&
    !detectedTransfer && !reimbursement && operation?.kind !== "interest") category = "Rückerstattungen";
  // A partner transfer must not become a salary receipt before reconciliation.
  if (isRaphaelPayment(transaction) && ["Gehalt", "Rufbereitschaft", "Einkommen"].includes(category)) category = "Sonstiges";
  if (reimbursement) category = "Transfer";
  const isTransfer =
    detectedTransfer ||
    category === "Transfer" ||
    category === "Transfer intern";
  const pocket =
    isRoundUp ? "Sparkonto" : savingsPocket(transaction.pocket);
  const exclusion =
    isAmazon ||
    isTravelCategory(category) ||
    transaction.automaticCategoryEvidence?.budgetExcluded === true ||
    (dutyFreeShopping && (!!transaction.holidayRange || transaction.category === "Urlaub" ||
      /^urlaub\b/i.test(sourceCategory) || isTravelMerchant(description))) ||
    /amex raphael/i.test(transaction.pocket ?? "") ||
    excluded.test(`${description} ${transaction.sourceCategory ?? ""}`) ||
    savingsPocket(transaction.pocket) === "Urlaub";
  const isFixedCost = !isTransfer && isFixedExpense({ amount, category, fixedCost: transaction.fixedCost });
  const fixedOrIncome = isFixedCost || isIncomeCategory(category) ||
    (amount >= 0 && transaction.fixedCost !== false && fixedCategories.includes(category));
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
      : category,
    pocket,
    isTransfer,
    isFixedCost,
    isRoundUp,
    isAmazon,
    includeInPlan,
    merchant: operation?.kind === "interest" ? "Zinsertrag" : merchantName(description, transaction.merchantAlias),
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
  if (row.amount <= 0) return month;
  const day = Number(row.date.slice(8, 10));
  if (day < 20 || day > 30) return month;
  const nextMonth = addMonths(month, 1);
  return ((day >= 26 && day <= 30) || earlySpecialSalary(row, nextMonth)) &&
    classify(row).category === "Gehalt"
    ? nextMonth
    : month;
}

export function classifyStatementRows(
  rows: Transaction[],
  existing: Transaction[] = [],
): Transaction[] {
  rows = rows.map((row) => applyNamedTransfer(recoverMerchant(row)));
  existing = existing.map(recoverMerchant);
  const refundMerchant = (row: Transaction) =>
    `${row.bank.toLowerCase()}|${row.pocket ?? ""}|${merchantName(row.description.replace(/rückerstattung|erstattung|refund|gutschrift|retoure/gi, ""), row.merchantAlias)}`;
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
  return rows.map((row) => {
    const original =
      row.amount > 0 && !row.categoryOverride && !hasManualCategory(row) && !classify(row).isTransfer
        ? debits
            .get(refundMerchant(row))
            ?.find(
              (item) =>
                item.date <= row.date && Math.abs(item.amount) >= row.amount,
            )
        : undefined;
    const refund =
      original && !classify(original).isFixedCost && !isIncomeCategory(classify(original).category)
        ? {
            ...row,
            category: classify(original).category,
            categoryOverride: true,
            ...(original.fixedCost === false ? { fixedCost: false } : {}),
          }
        : row;
    const result = classify(refund);
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
  const clean = rows.map((row) => {
    if (!("holidayRange" in row) && !("vacationDay" in row)) return row;
    const copy: AccountedTransaction & VacationMarker = { ...row };
    delete copy.holidayRange;
    delete copy.vacationDay;
    return copy;
  });
  if (!ranges.length) return clean;
  const home = new Set(clean.filter((row) => row.amount < 0 && row.date <= asOf && !inside(row.date) &&
    !classify(row).isTransfer && !isTravelCategory(classify(row).category) && !unresolvedTerminal(row.description)).map(holidayMerchantKey));
  return clean.map((row) => {
    if (hasManualCategory(row) || row.amount >= 0 || !inside(row.date)) return row;
    const result = classify(row);
    const marked: AccountedTransaction & VacationMarker = result.category === "Mittagessen" ? { ...row, vacationDay: true } : row;
    if (result.isTransfer || result.isAmazon || result.isFixedCost || isIncomeCategory(result.category) || home.has(holidayMerchantKey(row))) return marked;
    return { ...marked, holidayRange: true };
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
  for (const transaction of reconcileSharedHoliday(accountHolidayRanges(transactions, holidayRanges, asOf), asOf, [],
    (row) => classify(row).category).bookings) {
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
  paidRate?: number,
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
    const historicalRate = paidRate ?? settings.interestRates
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
    if (transaction.amount >= 0 || !classify(transaction).isRoundUp) continue;
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
      classified.pocket === "Sparkonto" &&
      /\bein(?:zu)?stecken\b/i.test(transaction.description) &&
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
  return sum(native.map((row) => row.amount));
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
  const ordinaryKeys = new Set(state.fixedReceipts?.length && state.transactions.some((row) => row.fixedCost === false)
    ? numberStatementRows(state.transactions).filter((row) => row.fixedCost === false)
      .flatMap((row) => [statementFingerprint(row), legacyFingerprint(row)])
    : []);
  const bookings = state.transactions.filter(
    (row) =>
      monthKey(row.date) === month &&
      row.date <= state.settings.asOf &&
      row.amount < 0 &&
      !classify(row).isTransfer && row.fixedCost !== false,
  );
  const receipts = (state.fixedReceipts ?? []).filter(
    (row) =>
      monthKey(row.date) === month &&
      row.date <= state.settings.asOf &&
      row.amount < 0 && row.booking?.fixedCost !== false && !ordinaryKeys.has(row.key),
  );
  return state.financeRows
    .filter((row) => {
      if (row.kind !== "fixed" || !(row.values[month]! > 0)) return false;
      const category = fixedRowCategory(row);
      return (
        !receipts.some(
          (item) =>
            item.rowId === row.id || (!item.rowId && category && canonicalCategory(item.category) === category &&
              (!(row.fixedSource || groupedContractCategories.includes(category)) ||
                (item.booking && matchingFixedRow(state, category, item.booking)?.id === row.id))),
        ) &&
        !bookings.some(
          (item) =>
            (category && classify(item).category === category &&
              (!(row.fixedSource || groupedContractCategories.includes(category)) || matchingFixedRow(state, category, item)?.id === row.id)) ||
            (!row.fixedSource && item.description.toLowerCase().includes(row.label.toLowerCase())),
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
    progress: settings.bikeTarget > 0 ? Math.min(100, Math.max(0, (balance / settings.bikeTarget) * 100)) : 0,
  };
}
export function financeRowValue(
  row: AppState["financeRows"][number],
  month: string,
  plan: { currentMonth: string; adjustments?: AppState["budgetAdjustments"] },
  holidayRanges: HolidayRange[] = [],
) {
  if (row.kind === "variable" && month >= plan.currentMonth) return variableBudgetValue(row, month, holidayRanges, plan.adjustments);
  return row.values[month] ?? 0;
}

/** none: no bookings; spending: the month itself is imported; full: the previous month too, so payroll paid at its end is included. */
export type ActualCoverage = "none" | "spending" | "full";
type MonthlyActuals = { actualSpending: number; fixedSpending: number; received: number; salaryReceived: number; actualCoverage: ActualCoverage };
const emptyActuals = (): MonthlyActuals => ({ actualSpending: 0, fixedSpending: 0, received: 0, salaryReceived: 0, actualCoverage: "none" });
// Per-calculation index, never a persistent cache: edits, imports, sharing and
// the as-of date must immediately affect the next dashboard calculation.
function indexMonthlyActuals(bookings: AccountedTransaction[], asOf: string) {
  const months = new Map<string, MonthlyActuals>();
  const imported = new Set<string>();
  for (const row of bookings) {
    if (row.date > asOf) continue;
    imported.add(monthKey(row.date));
    const result = classify(row);
    if (result.isTransfer) continue;
    const month = bookingMonth(row);
    const totals = months.get(month) ?? emptyActuals();
    if (["Einkommen", "Gehalt", "Rufbereitschaft"].includes(result.category))
      totals.received += personalAmount(row);
    else {
      totals.actualSpending -= personalAmount(row);
      if (result.isFixedCost && row.fixedCost !== false) totals.fixedSpending -= personalAmount(row);
    }
    if (row.amount > 0 && result.category === "Gehalt" && isTTSPayroll(row))
      totals.salaryReceived += row.amount;
    months.set(month, totals);
  }
  for (const month of imported) if (!months.has(month)) months.set(month, emptyActuals());
  for (const [month, totals] of months) {
    totals.actualSpending = round(totals.actualSpending);
    totals.fixedSpending = round(totals.fixedSpending);
    totals.received = round(totals.received);
    totals.salaryReceived = round(totals.salaryReceived);
    totals.actualCoverage = !imported.has(month) ? "none" : imported.has(addMonths(month, -1)) ? "full" : "spending";
  }
  return months;
}

/** Variable-budget spending per month and budget line, split receipts included; the dashboard's budget cards use the same rule. */
export function budgetSpendingByMonth(bookings: AccountedTransaction[], asOf: string) {
  const months = new Map<string, Map<VariableBudgetId, number>>();
  for (const transaction of bookings) {
    if (transaction.date > asOf) continue;
    const result = classify(transaction);
    if (outsideSpending(result)) continue;
    const month = monthKey(transaction.date);
    const spending = months.get(month) ?? new Map<VariableBudgetId, number>();
    for (const part of categoryParts(transaction, result.category)) {
      const budgetId = budgetGroupFor(transaction, { ...result, category: part.category });
      if (budgetId) spending.set(budgetId, (spending.get(budgetId) ?? 0) - personalAmount(transaction) * part.share);
    }
    months.set(month, spending);
  }
  return months;
}

export function calculateMonthTotals(
  state: AppState,
  month: string,
  plan: { currentMonth: string },
  bookings: AccountedTransaction[] = actualBookings(state),
  actuals = indexMonthlyActuals(bookings, state.settings.asOf),
  occurrences: PlannedOccurrence[] = matchPlannedOneOffs(state.plannedOneOffs, bookings),
  amex = amexFunding(state, bookings, occurrences),
) {
  const goalExtras = sum(savingsGoals(state).map((goal) => goalExtraIncome(goal, month)));
  const income = round(goalExtras + sum(
    state.financeRows
      .filter((row) => row.kind === "income")
      .map((row) => row.values[month] ?? 0),
  ));
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
  const variableBudget = month >= monthKey(state.settings.asOf)
    ? monthlyVariableBudget(month, state.holidayRanges, state.budgetAdjustments).total
    : state.months[month]?.variableOverride ?? sum(variableRows.map((row) => financeRowValue(row, month, plan, state.holidayRanges)));
  const amexOpen = month === monthKey(state.settings.asOf) ? amex.additional : 0;
  const variablePlan = round(variableBudget + amexOpen);
  const { actualSpending, fixedSpending, received, salaryReceived, actualCoverage } = actuals.get(month) ?? emptyActuals();
  const plannedIds = new Set(occurrences.filter((item) => item.bookingId).map((item) => item.bookingId));
  const plannedOneOffs = round(sum(occurrences.filter((item) => monthKey(item.date) === month).map((item) => item.ownAmount)) -
    sum(bookings.filter((row) => row.date <= state.settings.asOf && monthKey(row.date) === month &&
      row.holidayRefundFor && plannedIds.has(row.holidayRefundFor)).map(personalAmount)));
  return {
    income,
    goalExtras,
    salaryPlan,
    salaryReceived,
    received,
    fixed,
    amexOpen,
    variablePlan,
    actualSpending,
    fixedSpending,
    actualCoverage,
    plannedOneOffs,
    surplus: round(income - fixed - variablePlan - plannedOneOffs),
  };
}
const outsideSpending = (result: Classification) =>
  ["Einkommen", "Gehalt", "Rufbereitschaft"].includes(result.category) || result.isTransfer;
const budgetGroupFor = (transaction: AccountedTransaction, result: Classification) =>
  result.includeInPlan ? variableBudgetId(result.category, transaction.fixedCost) : undefined;
// The single rule that decides which bookings feed a variable budget line. The dashboard
// totals and the ledger drilldown both use it, so a card and its list can never diverge.
export function variableBudgetGroup(transaction: AccountedTransaction, month: string, asOf: string): VariableBudgetId | undefined {
  if (monthKey(transaction.date) !== month || transaction.date > asOf) return undefined;
  const result = classify(transaction);
  return outsideSpending(result) ? undefined : budgetGroupFor(transaction, result);
}
export function actualBookings(state: AppState): AccountedTransaction[] {
  const account = (rows: Transaction[]) => reconcileSharedHoliday(accountHolidayRanges(
    reconcileLeasingSources(reconcilePayrollSources(rows.map(recoverMerchant)), (row) => classify(row).category),
    state.holidayRanges, state.settings.asOf), state.settings.asOf, state.plannedOneOffs, (row) => classify(row).category).bookings;
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
      category: item.booking && hasManualCategory(item.booking) ? item.booking.category : item.category,
      categoryOverride: true,
      includeInPlan: item.booking && hasManualCategory(item.booking) ? item.booking.includeInPlan : false,
    });
  }
  return account([...state.transactions, ...receipts]);
}
export function incomingPocketTransfers(state: AppState, pocket: string, month: string, aliases: string[] = [], through = state.settings.asOf): number {
  const keys = new Set([pocket, ...aliases].map(pocketKey));
  return sum(state.transactions.filter((row) => row.bank === "Revolut" && row.date.slice(0, 7) === month && row.date <= through && row.amount > 0 && keys.has(pocketKey(row.pocket ?? "")) && classify(row).isTransfer).map((row) => row.amount));
}
export function synchronizeGoals(state: AppState): AppState {
  const actual = actualPockets(state);
  return { ...state, savingsGoals: savingsGoals(state).map((goal) => {
    const balance = goalBalanceStatus(state, goal, actual);
    const reached = balance.status === "known" && balance.amount !== null && balance.amount >= goal.target;
    const snapshot = balance.status === "known" ? (state.accountSnapshots ?? []).filter((item) => item.bank === "Revolut" && pocketKey(goal.pocket) === pocketKey(item.name) && item.balance >= goal.target && item.date <= state.settings.asOf).sort((a, b) => a.date.localeCompare(b.date))[0] : undefined;
    return { ...goal, completedAt: goal.completedAt ?? snapshot?.date ?? (reached ? state.settings.asOf : undefined) };
  }) };
}
export function calculateDashboard(state: AppState) {
  const plan = monthlyVariableBudget(monthKey(state.settings.asOf), state.holidayRanges, state.budgetAdjustments);
  // Reconcile receipt fingerprints once, not twice for each forecast month.
  const bookings = actualBookings(state);
  const actuals = indexMonthlyActuals(bookings, state.settings.asOf);
  const plannedOneOffs = matchPlannedOneOffs(state.plannedOneOffs, bookings);
  const amex = amexFunding(state, bookings, plannedOneOffs);
  const totalsForMonth = (month: string) => calculateMonthTotals(state, month, plan, bookings, actuals, plannedOneOffs, amex);
  const actual = actualPockets(state);
  const currentMonth = monthKey(state.settings.asOf);
  const trRate = trInterestRate(state);
  // From the current month on, the rate Trade Republic actually paid; earlier months keep the stored rate history.
  const creditedRate = trRate?.source === "credits" ? trRate.rate : undefined;
  const savingsTransferred = revolutSavingsTransferAmount(state.transactions, currentMonth, state.settings.asOf);
  const baselineMonth = monthKey(state.settings.baselineDate);
  const historicalOpening = state.months["2026-01"]?.openingBalances;
  let previous = { ...(historicalOpening ?? state.settings.balances) };
  const goals = savingsGoals(state);
  const motorcycle = goals.find((goal) => pocketKey(goal.pocket) === "motorrad");
  const actualGoals = Object.fromEntries(goals.map((goal) => [goal.id, goalBalance(state, goal, actual)]));
  const goalStatuses = Object.fromEntries(goals.map((goal) => [goal.id, goalBalanceStatus(state, goal, actual)]));
  const physical = physicalPocketBalances(state, actual);
  let projectedPhysical: Record<string, number | null> = {};
  const projectedCompletions = new Map<string, string>();
  const timeline = planningMonths(state.settings.asOf).map((month) => {
    const totals = totalsForMonth(month);
    const input = state.months[month] ?? emptyMonth();
    const historical = month < baselineMonth;
    const available = !historical || !!historicalOpening;
    const start = { ...(month === currentMonth ? actual : month === baselineMonth ? state.settings.balances : previous) };
    const from = month === baselineMonth ? state.settings.baselineDate : `${addMonths(month, -1)}-${daysInMonth(addMonths(month, -1))}`;
    const monthEnd = `${month}-${daysInMonth(month)}`;
    const snapshotDate = monthEnd < state.settings.asOf ? monthEnd : state.settings.asOf;
    const observed = physicalPocketBalances(state, actualPockets(state, snapshotDate), snapshotDate);
    if (month <= currentMonth) projectedPhysical = Object.fromEntries(Object.entries(observed).map(([key, balance]) => [key, balance.amount]));
    for (const pocket of pocketNames) {
      const key = pocketKey(pocket);
      if (observed[key]?.amount !== null && observed[key]?.amount !== undefined) {
        if (month === currentMonth) start[pocket] = observed[key].amount;
        projectedPhysical[key] = start[pocket];
      } else projectedPhysical[key] = null;
    }
    const movement = !historical ? pocketMovements(state.transactions, from, monthEnd, month === baselineMonth) : emptyPockets();
    for (const pocket of pocketNames) {
      if (latestPocketSnapshot(state, pocket, snapshotDate) && month > currentMonth)
        movement[pocket] = revolutMovement(state, pocket, from, monthEnd);
    }
    const interest = available ? monthlyInterest(month === currentMonth && latestTRBalance(state, snapshotDate) ? latestTRBalance(state, snapshotDate)!.balance : start.Notgroschen, month, state.settings, month >= currentMonth ? creditedRate : undefined) : 0;
    let projectedGoals = goalProjectionBalances(goals, projectedPhysical);
    if (month === currentMonth) projectedGoals = Object.fromEntries(goals.map((goal) => [
      goal.id, projectedGoals[goal.id] === null ? null :
        Math.max(0, projectedGoals[goal.id]! - incomingPocketTransfers(state, goal.pocket, month)),
    ]));
    const allocationBlocked = goals.some((goal) => projectedGoals[goal.id] === null);
    for (const goal of goals) {
      const balance = projectedGoals[goal.id];
      if (balance !== null && balance >= goal.target && !projectedCompletions.has(goal.id))
        projectedCompletions.set(goal.id, `${addMonths(month, -1)}-01`);
    }
    // Preserve goal instructions, but fund savings only from surplus after purchases.
    const funded = allocateGoals(historical ? 0 : totals.surplus + totals.plannedOneOffs - totals.goalExtras,
      goals.map((goal) => ({ ...goal, completedAt: goal.completedAt ?? projectedCompletions.get(goal.id) })), projectedGoals, month,
      savingsRate(state.settings));
    const allocation = { ...funded, goals: Object.fromEntries(goals.map((goal) => [goal.id, funded.goals[goal.id] ?? 0])) };
    const remaining = round(totals.surplus - sum(Object.values(allocation.goals)));
    const savings = allocationBlocked ? 0 : Math.min(allocation.savings, Math.max(0, remaining));
    const split = { ...emptyPockets(), Sparkonto: savings,
      Urlaub: allocationBlocked ? 0 : round(Math.min(allocation.vacation, Math.max(0, remaining - savings))) };
    for (const goal of goals) {
      const pocket = corePocket(goal.pocket);
      if (pocket) split[pocket] += allocation.goals[goal.id];
    }
    if (month >= currentMonth) {
      for (const [key, balance] of Object.entries(projectedPhysical)) {
        if (corePocket(key) || balance === null) continue;
        const rate = sum(goals.filter((goal) => pocketKey(goal.pocket) === key).map((goal) => allocation.goals[goal.id]));
        const settled = incomingPocketTransfers(state, key, month, [], monthEnd);
        const movements = sum(state.transactions.filter((row) => row.bank === "Revolut" &&
          pocketKey(row.pocket) === key && row.date > (month === currentMonth ? state.settings.asOf : from) &&
          row.date <= monthEnd).map((row) => row.amount));
        projectedPhysical[key] = round(balance + rate - Math.min(rate, settled) + movements);
      }
    }
    const end = { ...start };
    const rates = emptyPockets();
    const remainingMovement = month === currentMonth
      ? pocketMovements(state.transactions, state.settings.asOf, monthEnd) : movement;
    for (const pocket of pocketNames) {
      rates[pocket] = round(historical ? input.pocketIn[pocket] : split[pocket]);
      const settled = month >= currentMonth ? pocket === "Sparkonto"
        ? goals.some((goal) => corePocket(goal.pocket) === "Sparkonto")
          ? Math.max(revolutSavingsTransferAmount(state.transactions, month, monthEnd), incomingPocketTransfers(state, pocket, month, [], monthEnd))
          : revolutSavingsTransferAmount(state.transactions, month, monthEnd)
        : incomingPocketTransfers(state, pocket, month, [], monthEnd) : 0;
      end[pocket] = available ? round(start[pocket] + rates[pocket] - Math.min(rates[pocket], settled) + remainingMovement[pocket] - input.pocketOut[pocket] + (pocket === "Notgroschen" ? interest : 0)) : start[pocket];
      if (month < currentMonth && latestPocketSnapshot(state, pocket, monthEnd)) end[pocket] = actualPockets(state, monthEnd)[pocket];
      if (pocket === "Notgroschen" && month <= currentMonth && latestTRBalance(state, snapshotDate)) end[pocket] = latestTRBalance(state, snapshotDate)!.balance;
      if (month < currentMonth && observed[pocketKey(pocket)]?.amount !== null && observed[pocketKey(pocket)]?.amount !== undefined)
        end[pocket] = observed[pocketKey(pocket)].amount!;
    }
    for (const pocket of pocketNames) {
      if (projectedPhysical[pocketKey(pocket)] !== null) projectedPhysical[pocketKey(pocket)] = end[pocket];
    }
    projectedGoals = goalProjectionBalances(goals, projectedPhysical);
    if (available) previous = end;
    return { month, ...totals, start, rates, goalRates: allocation.goals, goalEnd: { ...projectedGoals }, physicalEnd: { ...projectedPhysical }, out: input.pocketOut, movement, end, interest, bikeTransfer: rates.Motorrad, available, allocationBlocked,
      remaining, roundUp: roundUpTotal(state.transactions, month),
      total: physicalProjectionTotal(Object.fromEntries(pocketNames.map((pocket) =>
        [pocket, projectedPhysical[pocketKey(pocket)] === null ? 0 : end[pocket]])), projectedPhysical),
      warning: !historical && (Object.values(end).some((value) => value < 0) || sum(Object.values(input.pocketIn)) > Math.max(0, totals.surplus)),
    };
  });
  const current = timeline.find((row) => row.month === currentMonth) ?? { ...totalsForMonth(currentMonth), month: currentMonth, bikeTransfer: 0, remaining: 0 };
  const allocationMonth = currentMonth;
  const nextTransfer = timeline.find((row) => row.month === allocationMonth)?.bikeTransfer ?? 0;
  const bikeBalance = motorcycle ? actualGoals[motorcycle.id] : actual.Motorrad;
  const countdown = { ...bikeCountdown(bikeBalance ?? 0, nextTransfer, motorcycle ? { ...state.settings, bikeTarget: motorcycle.target, bikePurchaseDate: motorcycle.date } : state.settings),
    known: bikeBalance !== null };
  if (!countdown.known) { countdown.onTrack = false; countdown.funded = false; }
  if (motorcycle?.funding) {
    const futureExtras = sum(Object.keys(motorcycle.funding.extras).filter((month) => month >= currentMonth)
      .map((month) => Math.max(0, goalExtraIncome(motorcycle, month) -
        (month === currentMonth ? incomingPocketTransfers(state, motorcycle.pocket, month) : 0))));
    countdown.required = state.settings.asOf > motorcycle.date ? 0 : round(Math.max(0, countdown.remaining - futureExtras) / countdown.months);
    countdown.onTrack = countdown.known && (countdown.funded || (!countdown.overdue && motorcycle.funding.monthly >= countdown.required));
  }
  const ninetyDays = [0, 1, 2].map((offset) => {
    const month = addMonths(currentMonth, offset);
    const existing = timeline.find((row) => row.month === month);
    if (existing) return existing;
    const totals = totalsForMonth(month);
    return { month, ...totals, bikeTransfer: 0, remaining: totals.surplus };
  });
  const categorySpending = new Map<string, number>();
  const budgetSpending = budgetSpendingByMonth(bookings, state.settings.asOf).get(currentMonth) ?? new Map<VariableBudgetId, number>();
  for (const transaction of bookings) {
    if (monthKey(transaction.date) !== currentMonth || transaction.date > state.settings.asOf) continue;
    const result = classify(transaction);
    if (outsideSpending(result)) continue;
    // A receipt split spreads one booking over several categories and budget lines.
    for (const part of categoryParts(transaction, result.category)) {
      const amount = personalAmount(transaction) * part.share;
      categorySpending.set(part.category, (categorySpending.get(part.category) ?? 0) - amount);
    }
  }
  const currentRow = timeline.find((row) => row.month === currentMonth);
  const fundingInstructions = [
    { id: "savings", name: "Sparkonto", pocket: "Sparkonto", amount: round((currentRow?.rates.Sparkonto ?? 0) -
      sum(goals.filter((goal) => corePocket(goal.pocket) === "Sparkonto").map((goal) => currentRow?.goalRates[goal.id] ?? 0))) },
    ...[...goals].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).map((goal) => ({ ...goal, amount: currentRow?.goalRates[goal.id] ?? 0 })),
    { id: "vacation", name: "Urlaub", pocket: "Urlaub", amount: round((currentRow?.rates.Urlaub ?? 0) -
      sum(goals.filter((goal) => corePocket(goal.pocket) === "Urlaub").map((goal) => currentRow?.goalRates[goal.id] ?? 0))) },
  ].filter((item) => item.amount > 0 || (item.id === "savings" && savingsTransferred > 0));
  const instructionGroups = new Map<string, typeof fundingInstructions>();
  for (const item of fundingInstructions) {
    const key = pocketKey(item.pocket);
    instructionGroups.set(key, [...(instructionGroups.get(key) ?? []), item]);
  }
  const monthlyFunding = [...instructionGroups.values()].map((items) => {
    const item = items[0];
    const amount = sum(items.map((entry) => entry.amount));
    const onlySavings = items.length === 1 && item.id === "savings";
    const transferred = onlySavings ? savingsTransferred
      : Math.max(item.id === "savings" ? savingsTransferred : 0, incomingPocketTransfers(state, item.pocket, currentMonth));
    return { ...item, name: items.map((entry) => entry.name).join(" + "), amount,
      ...(items.length > 1 ? { memberIds: items.map((entry) => entry.id), combined: true } : {}),
      transferred, done: onlySavings ? transferred > 0 : transferMatches(amount, transferred) };
  });
  return { plan: { ...plan, rows: plan.rows.map((row) => ({ ...row, actual: round(budgetSpending.get(row.id) ?? 0) })) }, goals, actualGoals, goalStatuses, physical,
    monthlyFunding,
    currentMonth, current, amex, plannedOneOffs, missingFixed: missingFixedCosts(state), timeline, actual,
    totalAssets: physicalAssetTotal(physical),
    countdown, nextTransfer, allocationMonth, ninetyDays,
    currentRoundUp: roundUpTotal(state.transactions.filter((t) => t.date <= state.settings.asOf), currentMonth),
    spending: [...categorySpending].map(([name, value]) => ({ name, value: round(value) })).sort((a, b) => b.value - a.value),
  };
}
export type Dashboard = ReturnType<typeof calculateDashboard>;
