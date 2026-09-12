import {
  emptyMonth,
  emptyPockets,
  fixedCategories,
  pocketNames,
  type AppState,
  type Category,
  type Pocket,
  type PocketAmounts,
  type Settings,
  type Transaction,
} from "@/lib/types";
import { fixedRowCategory } from "@/lib/fixed";

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
  /eventim|magazin salzburg|salzburger verkehr|sky chefs|\blsg\b|roof burger|filomena|bravofly|urlaub|führerschein|fuhrerschein/i;
const merchantPatterns: [RegExp, string][] = [
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
  if (/^notgroschen(?:\s|$)/i.test(account)) return "Notgroschen";
  if (/^urlaub(?:\s|$)/i.test(account)) return "Urlaub";
  if (/^(sparkonto|sparen)$/i.test(account)) return "Sparkonto";
  if (/^motorrad(?:konto|[- ]konto)?$/i.test(account)) return "Motorrad";
  return null;
}
export function classify(
  transaction: Pick<
    Transaction,
    "description" | "amount" | "category" | "pocket" | "includeInPlan"
  > &
    Partial<Pick<Transaction, "bank" | "categoryOverride" | "sourceCategory">>,
) {
  const { description, amount } = transaction;
  const absolute = Math.abs(amount);
  const sourceCategory = transaction.sourceCategory ?? "";
  const isCardSettlement =
    /(?:amex|american express).*(?:abrechnung|sammel|ausgleich)/i.test(
      `${description} ${sourceCategory}`,
    );
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
  const isAmazon = !explicitInternal && /amazon|amz/i.test(description);
  const isInternal =
    /einzustecken|auszahlung bei pocket|interne? (?:überweisung|umbuchung)|transfer intern|gesendet von revolut|revolut\*|american express europe|zahlung\/überweisung erhalten/i.test(
      description,
    ) ||
    isCardSettlement ||
    isCashWithdrawal ||
    transaction.category === "Transfer intern" ||
    /transfer intern/i.test(transaction.sourceCategory ?? "");
  const detectedTransfer = isRoundUp || isAmazon || isInternal;
  let category: Category = transaction.category;
  if (isRoundUp || isAmazon) category = "Transfer";
  else if (isInternal) category = "Transfer intern";
  else if (/rufbereitschaft/i.test(description)) category = "Rufbereitschaft";
  else if (/gehalt|team\s*talent\s*solutions/i.test(description))
    category = absolute < 500 ? "Rufbereitschaft" : "Gehalt";
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
  else if (/bipa|hotspot|mensa|mensen|trafik/i.test(description))
    category = "Mittagessen";
  else if (/billa|\bspar\b|interspar|eurospar/i.test(description))
    category = absolute <= 10 ? "Mittagessen" : "Lebensmittel";
  else if (
    /\bdm\b|dm-drogerie|burger|foodora|pizzeria|sakura|gams|burgschenke|mc\s*donald'?s/i.test(
      description,
    )
  )
    category = "Ausgehen";
  else if (/\batm\b|bankomat/i.test(description) && absolute === 20)
    category = "Barber";
  if (transaction.categoryOverride) category = transaction.category;
  const isTransfer =
    detectedTransfer ||
    category === "Transfer" ||
    category === "Transfer intern";
  const pocket =
    isRoundUp || isAmazon ? "Sparkonto" : savingsPocket(transaction.pocket);
  const exclusion =
    excluded.test(`${description} ${transaction.sourceCategory ?? ""}`) ||
    savingsPocket(transaction.pocket) === "Urlaub";
  const fixedOrIncome = fixedCategories.includes(category);
  const includeInPlan =
    amount < 0 &&
    !isTransfer &&
    !exclusion &&
    !fixedOrIncome &&
    category !== "Prüfen" &&
    transaction.includeInPlan;
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
    reason: isTransfer
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

export function classifyStatementRows(
  rows: Transaction[],
  existing: Transaction[] = [],
): Transaction[] {
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
    const result = classify(
      recurring && !row.categoryOverride
        ? {
            ...row,
            sourceCategory: `${row.sourceCategory ?? ""} wiederkehrend`,
          }
        : row,
    );
    return {
      ...row,
      category: result.category,
      includeInPlan: result.includeInPlan,
    };
  });
}

export const planWeights = [0.15, 0.2, 0.3, 0.35] as const;
export function calculatePlan(transactions: Transaction[], asOf: string) {
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
  for (const transaction of transactions) {
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
    if (key === currentMonth) group.current += Math.abs(transaction.amount);
    else {
      group.values[months.indexOf(key)] += Math.abs(transaction.amount);
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
        planned: eligible ? round(historical + currentContribution) : 0,
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
    const rate =
      month < changeMonth ||
      (month === changeMonth &&
        day < Number(settings.rateChangeDate.slice(8, 10)))
        ? settings.oldRate
        : settings.newRate;
    effectiveRate += rate / days;
  }
  return round(((previousEnd * effectiveRate) / 12) * (1 - settings.taxRate));
}
export function splitSurplus(
  surplus: number,
  bikeBalance: number,
  settings: Settings,
  bikeOverride: number | null = null,
): PocketAmounts {
  const available = Math.max(0, surplus);
  const gap = Math.max(0, settings.bikeTarget - bikeBalance);
  const bike = round(
    Math.min(gap, available, bikeOverride ?? available * settings.bikeShare),
  );
  const rest = round(available - bike);
  if (gap <= bike) {
    const savings = round(rest * settings.afterBikeSavingsShare);
    return {
      Notgroschen: 0,
      Motorrad: bike,
      Sparkonto: savings,
      Urlaub: round(rest - savings),
    };
  }
  return { Notgroschen: 0, Motorrad: bike, Sparkonto: rest, Urlaub: 0 };
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
  const roundUpPairs = new Map<string, number>();
  for (const transaction of transactions) {
    if (!classify(transaction).isRoundUp) continue;
    const key = `${transaction.date}|${transaction.bank}|${Math.abs(transaction.amount)}`;
    roundUpPairs.set(key, (roundUpPairs.get(key) ?? 0) + 1);
  }
  for (const transaction of transactions) {
    if (
      transaction.date < fromExclusive ||
      (transaction.date === fromExclusive &&
        !(includeBaselineDay && transaction.afterBaseline)) ||
      transaction.date > toInclusive
    )
      continue;
    const classified = classify(transaction);
    if (!classified.pocket) continue;
    const pairKey = `${transaction.date}|${transaction.bank}|${transaction.amount}`;
    if (
      transaction.amount > 0 &&
      /um eur sparen .*einzustecken/i.test(transaction.description) &&
      (roundUpPairs.get(pairKey) ?? 0) > 0
    ) {
      roundUpPairs.set(pairKey, roundUpPairs.get(pairKey)! - 1);
      continue;
    }
    movements[classified.pocket] +=
      classified.isRoundUp || classified.isAmazon
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
  return state.pocketSnapshots
    ?.filter(
      (item) =>
        item.pocket === pocket &&
        item.date <= date &&
        item.date >= state.settings.baselineDate,
    )
    .sort((a, b) => b.date.localeCompare(a.date))[0];
}
function revolutMovement(
  state: AppState,
  pocket: Pocket,
  from: string,
  to: string,
  transfersOnly = false,
) {
  return sum(
    state.transactions
      .filter(
        (row) =>
          row.bank === "Revolut" &&
          savingsPocket(row.pocket) === pocket &&
          row.date > from &&
          row.date <= to &&
          (!transfersOnly || classify(row).isTransfer),
      )
      .map((row) => row.amount),
  );
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
            item.rowId === row.id || (category && item.category === category),
        ) &&
        !bookings.some(
          (item) =>
            (category && classify(item).category === category) ||
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
  plan: ReturnType<typeof calculatePlan>,
) {
  return (
    row.values[month] ??
    (row.kind === "variable" && row.planCategory
      ? (plan.byCategory.find((item) => item.category === row.planCategory)
          ?.total ?? 0)
      : 0)
  );
}
export function calculateMonthTotals(
  state: AppState,
  month: string,
  plan: ReturnType<typeof calculatePlan>,
) {
  const income = sum(
    state.financeRows
      .filter((row) => row.kind === "income")
      .map((row) => row.values[month] ?? 0),
  );
  const fixed = sum(
    state.financeRows
      .filter((row) => row.kind === "fixed")
      .map((row) => row.values[month] ?? 0),
  );
  const variableRows = state.financeRows.filter(
    (row) => row.kind === "variable",
  );
  const variablePlan =
    state.months[month]?.variableOverride ??
    (variableRows.length
      ? sum(variableRows.map((row) => financeRowValue(row, month, plan)))
      : plan.total);
  const actualSpending = sum(
    state.transactions
      .filter(
        (t) =>
          monthKey(t.date) === month &&
          t.date <= state.settings.asOf &&
          t.amount < 0 &&
          !classify(t).isTransfer,
      )
      .map((t) => -t.amount),
  );
  return {
    income,
    fixed,
    variablePlan,
    actualSpending,
    surplus: round(income - fixed - variablePlan),
  };
}
export function calculateDashboard(state: AppState) {
  const plan = calculatePlan(state.transactions, state.settings.asOf);
  const actual = actualPockets(state);
  const currentMonth = monthKey(state.settings.asOf);
  const baselineMonth = monthKey(state.settings.baselineDate);
  const historicalOpening = state.months["2026-01"]?.openingBalances;
  let previous = { ...(historicalOpening ?? state.settings.balances) };
  let bikeFunded = previous.Motorrad >= state.settings.bikeTarget;
  let trBalance = state.settings.balances.Notgroschen;
  const timeline = [...monthsForYear(2026), ...monthsForYear(2027)].map(
    (month) => {
      const totals = calculateMonthTotals(state, month, plan);
      const input = state.months[month] ?? emptyMonth();
      const historical = month < baselineMonth;
      const available = !historical || !!historicalOpening;
      const start = {
        ...(month === baselineMonth ? state.settings.balances : previous),
      };
      const from =
        month === baselineMonth
          ? state.settings.baselineDate
          : `${addMonths(month, -1)}-${daysInMonth(addMonths(month, -1))}`;
      const movement = !historical
        ? pocketMovements(
            state.transactions,
            from,
            `${month}-${daysInMonth(month)}`,
            month === baselineMonth,
          )
        : emptyPockets();
      const monthEnd = `${month}-${daysInMonth(month)}`;
      const snapshotDate =
        monthEnd < state.settings.asOf ? monthEnd : state.settings.asOf;
      const settled = emptyPockets();
      for (const pocket of pocketNames) {
        const snapshot = latestPocketSnapshot(state, pocket, snapshotDate);
        if (!snapshot) continue;
        if (month === currentMonth) {
          start[pocket] = actual[pocket];
          movement[pocket] = revolutMovement(
            state,
            pocket,
            state.settings.asOf,
            monthEnd,
          );
          settled[pocket] = Math.max(
            0,
            revolutMovement(
              state,
              pocket,
              `${addMonths(month, -1)}-${daysInMonth(addMonths(month, -1))}`,
              state.settings.asOf,
              true,
            ),
          );
        } else if (month > currentMonth) {
          movement[pocket] = revolutMovement(state, pocket, from, monthEnd);
        }
      }
      if (month === currentMonth && latestPocketSnapshot(state, "Motorrad"))
        bikeFunded =
          actual.Motorrad - settled.Motorrad >= state.settings.bikeTarget;
      const interest = available
        ? monthlyInterest(
            latestPocketSnapshot(state, "Notgroschen", snapshotDate)
              ? trBalance
              : start.Notgroschen,
            month,
            state.settings,
          )
        : 0;
      if (month >= baselineMonth) trBalance = round(trBalance + interest);
      const manualTotal = sum(Object.values(input.pocketIn));
      const bikeBeforeWithdrawal =
        start.Motorrad -
        settled.Motorrad +
        movement.Motorrad +
        input.pocketIn.Motorrad;
      if (bikeBeforeWithdrawal >= state.settings.bikeTarget) bikeFunded = true;
      const split =
        !historical && month >= monthKey(state.settings.allocationStart)
          ? splitSurplus(
              totals.surplus - manualTotal,
              bikeFunded ? state.settings.bikeTarget : bikeBeforeWithdrawal,
              state.settings,
              input.bikeOverride,
            )
          : emptyPockets();
      if (bikeBeforeWithdrawal + split.Motorrad >= state.settings.bikeTarget)
        bikeFunded = true;
      const end = { ...start };
      const rates = emptyPockets();
      for (const pocket of pocketNames) {
        rates[pocket] = round(split[pocket] + input.pocketIn[pocket]);
        end[pocket] = available
          ? round(
              start[pocket] +
                rates[pocket] -
                Math.min(rates[pocket], settled[pocket]) +
                movement[pocket] -
                input.pocketOut[pocket] +
                (pocket === "Notgroschen" ? interest : 0),
            )
          : start[pocket];
        if (
          month < currentMonth &&
          latestPocketSnapshot(state, pocket, monthEnd)
        )
          end[pocket] = actualPockets(state, monthEnd)[pocket];
      }
      if (available) previous = end;
      const bikeTransfer = rates.Motorrad;
      return {
        month,
        ...totals,
        start,
        rates,
        out: input.pocketOut,
        movement,
        end,
        interest,
        bikeTransfer,
        available,
        remaining: round(totals.surplus - bikeTransfer),
        roundUp: roundUpTotal(state.transactions, month),
        total: sum(Object.values(end)),
        warning:
          !historical &&
          (Object.values(end).some((value) => value < 0) ||
            manualTotal > Math.max(0, totals.surplus)),
      };
    },
  );
  const current = timeline.find((row) => row.month === currentMonth) ?? {
    ...calculateMonthTotals(state, currentMonth, plan),
    month: currentMonth,
    bikeTransfer: 0,
    remaining: 0,
  };
  const allocationMonth =
    currentMonth < monthKey(state.settings.allocationStart)
      ? monthKey(state.settings.allocationStart)
      : currentMonth;
  const nextTransfer =
    timeline.find((row) => row.month === allocationMonth)?.bikeTransfer ?? 0;
  const countdown = bikeCountdown(
    actual.Motorrad,
    nextTransfer,
    state.settings,
  );
  const ninetyDays = [0, 1, 2].map((offset) => {
    const month = addMonths(currentMonth, offset);
    const existing = timeline.find((row) => row.month === month);
    if (existing) return existing;
    const totals = calculateMonthTotals(state, month, plan);
    return { month, ...totals, bikeTransfer: 0, remaining: totals.surplus };
  });
  const categorySpending = new Map<string, number>();
  for (const transaction of state.transactions) {
    const result = classify(transaction);
    if (
      monthKey(transaction.date) !== currentMonth ||
      transaction.date > state.settings.asOf ||
      transaction.amount >= 0 ||
      result.isTransfer
    )
      continue;
    categorySpending.set(
      result.category,
      (categorySpending.get(result.category) ?? 0) - transaction.amount,
    );
  }
  return {
    plan,
    currentMonth,
    current,
    missingFixed: missingFixedCosts(state),
    timeline,
    actual,
    totalAssets: sum(Object.values(actual)),
    countdown,
    nextTransfer,
    allocationMonth,
    ninetyDays,
    currentRoundUp: roundUpTotal(
      state.transactions.filter((t) => t.date <= state.settings.asOf),
      currentMonth,
    ),
    spending: [...categorySpending]
      .map(([name, value]) => ({ name, value: round(value) }))
      .sort((a, b) => b.value - a.value),
  };
}
export type Dashboard = ReturnType<typeof calculateDashboard>;
