import { isRevolutMainAccount } from "@/lib/accounts";
import { pocketNames, type AppState, type Pocket, type PocketOpeningBalance, type SavingsGoal } from "@/lib/types";

export const SAVINGS_FLOOR = 180;
export const vacationSavingPaused = (month: string) => month >= "2026-10" && month < "2027-03";
const cents = (amount: number) => Math.round(Math.max(0, amount) * 100);
export const everydayPocketNames = ["Mittagessen", "Lebensmittel", "Entertainment & Haushalt", "Tanken"] as const;

export function savingsGoals(state: AppState): SavingsGoal[] {
  // Undefined migrates the old goal; [] deliberately means no open goals.
  return state.savingsGoals ?? [{
    id: "motorcycle",
    name: "Motorrad",
    pocket: "Motorrad",
    target: state.settings.bikeTarget,
    date: state.settings.bikePurchaseDate,
  }];
}

export function pocketKey(name: string | null): string {
  const text = (name ?? "").normalize("NFKC").trim().replace(/\s+/g, " ")
    .replace(/\s*\(EUR\)$/i, "").trim().toLocaleLowerCase("de-AT");
  if (/^(sparen|sparkonto)$/.test(text)) return "sparkonto";
  if (/^motorrad(?:konto|[- ]konto)?$/.test(text)) return "motorrad";
  if (/^urlaub(?: 2026)?$/.test(text)) return "urlaub";
  return text;
}

export function corePocket(name: string): Pocket | undefined {
  return pocketNames.find((pocket) => pocketKey(pocket) === pocketKey(name));
}

export function goalMatchesPocket(goal: SavingsGoal, pocket: string | null): boolean {
  const key = pocketKey(pocket);
  return !!key && key === pocketKey(goal.pocket);
}

export type { PocketOpeningBalance } from "@/lib/types";
export type PhysicalBalance = {
  amount: number | null;
  status: "known" | "unknown" | "conflict";
  source?: "core" | "snapshot" | "opening";
};

export function coreBalanceKnown(state: AppState, pocket: Pocket): boolean {
  return !state.settings.unknownBalances?.includes(pocket);
}

function pocketOpenings(state: AppState): PocketOpeningBalance[] {
  return [
    ...(state.pocketOpeningBalances ?? []),
    ...savingsGoals(state).flatMap((goal) => goal.openingBalance ? [{
      pocket: goal.pocket,
      ...goal.openingBalance,
      // The historical motorcycle setup used an empty imported pocket as its trigger.
      ...(pocketKey(goal.pocket) === "motorrad" ? { ignoreEmptySnapshot: true } : {}),
    }] : []),
  ];
}

export function preserveGoalOpeningBalances(state: AppState): AppState {
  const existing = state.pocketOpeningBalances ?? [];
  const identity = (item: PocketOpeningBalance) => JSON.stringify([
    pocketKey(item.pocket), item.date, item.amount, item.includedTransactionIds ?? [], !!item.ignoreEmptySnapshot,
  ]);
  const known = new Set(existing.map(identity));
  const additions = pocketOpenings(state).filter((item) => {
    const key = identity(item);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  return additions.length ? { ...state, pocketOpeningBalances: [...existing, ...additions] } : state;
}

export function goalPocketConflicts(goals: SavingsGoal[]): Set<string> {
  const counts = new Map<string, number>();
  for (const goal of goals) {
    const key = pocketKey(goal.pocket);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

export function physicalPocketBalance(
  state: AppState, name: string, core: Record<string, number>, date = state.settings.asOf,
): PhysicalBalance {
  const key = pocketKey(name);
  const pocket = corePocket(name);
  const openings = pocketOpenings(state).filter((item) => pocketKey(item.pocket) === key && item.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date));
  const opening = openings[0];
  const snapshots = [
    ...(state.accountSnapshots ?? []).filter((item) => item.bank === "Revolut" && pocketKey(item.name) === key && pocket !== "Notgroschen"),
    ...(state.pocketSnapshots ?? []).filter((item) => item.bank === "Revolut" && pocketKey(item.pocket) === key && pocket !== "Notgroschen"),
    ...(pocket === "Notgroschen" ? state.trBalances ?? [] : []),
  ].filter((item) => item.date <= date && (!pocket || item.date >= state.settings.baselineDate) &&
    (!opening || item.date >= opening.date) &&
    !(opening?.ignoreEmptySnapshot && item.date === opening.date && item.balance === 0))
    .sort((a, b) => b.date.localeCompare(a.date));
  const snapshot = snapshots[0];
  if (snapshot) {
    if (snapshots.some((item) => item.date === snapshot.date && item.balance !== snapshot.balance))
      return { status: "conflict", amount: null };
    const movement = pocket === "Notgroschen" ? 0 : state.transactions.filter((row) =>
      row.bank === "Revolut" && pocketKey(row.pocket) === key && row.date > snapshot.date && row.date <= date,
    ).reduce((total, row) => total + row.amount, 0);
    return { status: "known", source: "snapshot", amount: Math.round((snapshot.balance + movement) * 100) / 100 };
  }
  // Core amounts already include their own baseline movements. An earmark is not additive.
  if (pocket && coreBalanceKnown(state, pocket) && Number.isFinite(core[pocket]) && date >= state.settings.baselineDate &&
    !(opening?.ignoreEmptySnapshot && state.settings.balances[pocket] === 0)) {
    return { status: "known", source: "core", amount: core[pocket] };
  }
  if (opening) {
    if (openings.some((item) => item.date === opening.date && item.amount !== opening.amount))
      return { status: "conflict", amount: null };
    const included = new Set(openings.filter((item) => item.date === opening.date && item.amount === opening.amount)
      .flatMap((item) => item.includedTransactionIds ?? []));
    const movement = state.transactions.filter((row) => row.bank === "Revolut" &&
      pocketKey(row.pocket) === key && row.date <= date &&
      (row.date > opening.date || (row.date === opening.date && !included.has(row.id))),
    ).reduce((total, row) => total + row.amount, 0);
    return { status: "known", source: "opening", amount: Math.round((opening.amount + movement) * 100) / 100 };
  }
  return { status: "unknown", amount: null };
}

export function physicalPocketBalances(state: AppState, core: Record<string, number>, date = state.settings.asOf) {
  const names = new Set<string>([
    ...pocketNames,
    ...pocketOpenings(state).filter((item) => item.date <= date).map((item) => item.pocket),
    ...(state.accountSnapshots ?? []).filter((item) => item.bank === "Revolut" && item.date <= date).map((item) => item.name),
    ...(state.pocketSnapshots ?? []).filter((item) => item.bank === "Revolut" && item.date <= date).map((item) => item.pocket),
    ...state.transactions.filter((item) => item.bank === "Revolut" && item.pocket && item.date <= date).map((item) => item.pocket!),
    ...savingsGoals(state).map((goal) => goal.pocket),
  ]);
  return Object.fromEntries([...names].filter((name) =>
    !isRevolutMainAccount({ bank: "Revolut", pocket: name }) &&
    !/^(?:persönliches konto|personal account)\b/i.test(name) && !/\((?!EUR\))\w{3}\)$/i.test(name),
  ).map((name) => [pocketKey(name), physicalPocketBalance(state, name, core, date)]));
}

export function bankPocketBalance(state: AppState, pocket: Pocket, core: Record<string, number>): number | null {
  const basis = physicalPocketBalance(state, pocket, core);
  if (basis.status === "conflict") return null;
  if (basis.source === "snapshot") return basis.amount;
  return coreBalanceKnown(state, pocket) ? core[pocket] ?? null : null;
}

export function physicalAssetTotal(balances: Record<string, PhysicalBalance>): number {
  return Math.round(Object.values(balances).reduce((total, balance) => total + (balance.amount ?? 0), 0) * 100) / 100;
}

export function goalProjectionBalances(goals: SavingsGoal[], physical: Record<string, number | null>): Record<string, number | null> {
  const conflicts = goalPocketConflicts(goals);
  return Object.fromEntries(goals.map((goal) => [
    goal.id, conflicts.has(pocketKey(goal.pocket)) ? null : physical[pocketKey(goal.pocket)] ?? null,
  ]));
}

export function physicalProjectionTotal(core: Record<string, number>, physical: Record<string, number | null>): number {
  return Math.round((
    Object.entries(core).reduce((total, [name, amount]) =>
      total + (physical[pocketKey(name)] === null ? 0 : amount), 0) +
    Object.entries(physical).filter(([key]) => !corePocket(key)).reduce((total, [, amount]) => total + (amount ?? 0), 0)
  ) * 100) / 100;
}

export function goalBalanceStatus(state: AppState, goal: SavingsGoal, core: Record<string, number>, date = state.settings.asOf): PhysicalBalance {
  if (goalPocketConflicts(savingsGoals(state)).has(pocketKey(goal.pocket))) return { status: "conflict", amount: null };
  return physicalPocketBalance(state, goal.pocket, core, date);
}

export function initializeMotorcycleGoal(state: AppState, pocketBalance: number): AppState {
  if (state.bikeOnlyGoalApplied) return state;
  const goals = savingsGoals(state);
  const motorcycle = goals.find((goal) => pocketKey(goal.pocket) === "motorrad" ||
    pocketKey(goal.name) === "motorrad" || goal.id === "motorcycle");
  if (!motorcycle) return { ...state, bikeOnlyGoalApplied: true };
  const includedTransactionIds = state.transactions.filter((row) => row.date === state.settings.asOf &&
    goalMatchesPocket(motorcycle, row.pocket)).map((row) => row.id);
  const updated: SavingsGoal = {
    ...motorcycle, name: "Motorrad", pocket: "Motorrad", target: 5400, date: "2027-04-01",
    funding: { monthly: 0, extras: { "2026-12": 800, "2027-01": 2576 } },
    ...(pocketBalance === 0 && coreBalanceKnown(state, "Motorrad") && !motorcycle.openingBalance
      ? { openingBalance: { date: state.settings.asOf, amount: 2445,
        ...(includedTransactionIds.length ? { includedTransactionIds } : {}) } } : {}),
  };
  return {
    ...state, bikeOnlyGoalApplied: true,
    settings: { ...state.settings, bikeTarget: updated.target, bikePurchaseDate: updated.date },
    savingsGoals: goals.map((goal) => goal.id === motorcycle.id ? updated : goal),
  };
}

export function goalBalance(state: AppState, goal: SavingsGoal, core: Record<string, number>, date = state.settings.asOf): number | null {
  return goalBalanceStatus(state, goal, core, date).amount;
}

export function goalExtraIncome(goal: SavingsGoal, month: string): number {
  if (month > goal.date.slice(0, 7)) return 0;
  return goal.funding?.extras[month] ?? 0;
}

export function allocateGoals(surplus: number, goals: SavingsGoal[], balances: Record<string, number | null>, month: string) {
  let remaining = cents(surplus);
  const savings = Math.min(remaining, cents(SAVINGS_FLOOR));
  remaining -= savings;
  const funding: Record<string, number> = {};
  const conflicts = goalPocketConflicts(goals);
  for (const goal of [...goals].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    if (conflicts.has(pocketKey(goal.pocket))) {
      funding[goal.id] = 0;
      continue;
    }
    // Completion is historical: withdrawing a purchased goal must not restart it.
    // Keep this month's original instruction so its imported transfer can be checked off.
    const complete = goal.completedAt && goal.completedAt.slice(0, 7) < month;
    const outsideBikeWindow = (pocketKey(goal.pocket) === "motorrad" && month < "2026-10") ||
      ((pocketKey(goal.pocket) === "motorrad" || goal.funding) && month > goal.date.slice(0, 7));
    const balance = balances[goal.id];
    const gap = complete || outsideBikeWindow ? 0 : balance == null
      ? goal.funding ? Infinity : 0
      : cents(goal.target - balance);
    const amount = Math.min(remaining, gap, goal.funding ? cents(goal.funding.monthly) : Infinity);
    // Earmarked extras are additional income, not another claim on normal salary.
    funding[goal.id] = amount / 100 + (outsideBikeWindow ? 0 : goalExtraIncome(goal, month));
    remaining -= amount;
  }
  const pauseVacation = vacationSavingPaused(month);
  return { savings: (savings + (pauseVacation ? remaining : 0)) / 100,
    goals: funding, vacation: pauseVacation ? 0 : remaining / 100 };
}

export function transferMatches(planned: number, incoming: number): boolean {
  if (planned <= 0 || incoming <= 0) return false;
  return Math.abs(Math.round((incoming - planned) * 100)) <= Math.max(500, Math.round(planned * 3));
}
