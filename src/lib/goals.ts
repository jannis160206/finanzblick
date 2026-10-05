import type { AppState, SavingsGoal } from "@/lib/types";

export const SAVINGS_FLOOR = 180;
export const vacationSavingPaused = (month: string) => month >= "2026-10" && month < "2027-03";
const cents = (amount: number) => Math.round(Math.max(0, amount) * 100);

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
  const text = (name ?? "").normalize("NFKC").trim().toLocaleLowerCase("de-AT");
  if (/^(sparen|sparkonto)$/.test(text)) return "sparkonto";
  if (/^motorrad(?:konto|[- ]konto)?$/.test(text)) return "motorrad";
  if (/^urlaub(?: 2026)?$/.test(text)) return "urlaub";
  return text;
}

export function goalMatchesPocket(goal: SavingsGoal, pocket: string | null): boolean {
  const key = pocketKey(pocket);
  return !!key && (key === pocketKey(goal.pocket) || key === pocketKey(goal.name));
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
    ...(pocketBalance === 0 && !motorcycle.openingBalance
      ? { openingBalance: { date: state.settings.asOf, amount: 2445,
        ...(includedTransactionIds.length ? { includedTransactionIds } : {}) } } : {}),
  };
  return {
    ...state, bikeOnlyGoalApplied: true,
    settings: { ...state.settings, bikeTarget: updated.target, bikePurchaseDate: updated.date },
    savingsGoals: goals.map((goal) => goal.id === motorcycle.id ? updated : goal),
  };
}

export function goalBalance(state: AppState, goal: SavingsGoal, core: Record<string, number>, date = state.settings.asOf): number {
  const opening = goal.openingBalance;
  if (opening && date >= opening.date) {
    const snapshots = [
      ...(state.accountSnapshots ?? []).filter((item) => goalMatchesPocket(goal, item.name)),
      ...(state.pocketSnapshots ?? []).filter((item) => goalMatchesPocket(goal, item.pocket)),
    // Ignore the empty snapshot that prompted the opening, not a corrected bank balance.
    ].filter((item) => item.date >= opening.date && item.date <= date &&
      (item.date !== opening.date || item.balance !== 0))
      .sort((a, b) => b.date.localeCompare(a.date));
    const basis = snapshots[0] ? { date: snapshots[0].date, amount: snapshots[0].balance } : opening;
    const included = new Set(opening.includedTransactionIds);
    const movement = state.transactions.filter((row) => goalMatchesPocket(goal, row.pocket) && row.date <= date &&
      (row.date > basis.date || (!snapshots.length && row.date === basis.date && !included.has(row.id))))
      .reduce((total, row) => total + row.amount, 0);
    return Math.round((basis.amount + movement) * 100) / 100;
  }
  const key = pocketKey(goal.pocket);
  if (key === "motorrad") return core.Motorrad ?? 0;
  const snapshot = state.accountSnapshots?.filter((item) =>
    item.date <= date && goalMatchesPocket(goal, item.name),
  ).sort((a, b) => b.date.localeCompare(a.date))[0];
  const movement = state.transactions.filter((row) =>
    row.bank === "Revolut" && goalMatchesPocket(goal, row.pocket) && row.date <= date && (!snapshot || row.date > snapshot.date),
  ).reduce((total, row) => total + row.amount, 0);
  return Math.round(((snapshot?.balance ?? 0) + movement) * 100) / 100;
}

export function goalExtraIncome(goal: SavingsGoal, month: string): number {
  if (month > goal.date.slice(0, 7)) return 0;
  return goal.funding?.extras[month] ?? 0;
}

export function allocateGoals(surplus: number, goals: SavingsGoal[], balances: Record<string, number>, month: string) {
  let remaining = cents(surplus);
  const savings = Math.min(remaining, cents(SAVINGS_FLOOR));
  remaining -= savings;
  const funding: Record<string, number> = {};
  for (const goal of [...goals].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    // Completion is historical: withdrawing a purchased goal must not restart it.
    // Keep this month's original instruction so its imported transfer can be checked off.
    const complete = goal.completedAt && goal.completedAt.slice(0, 7) < month;
    const outsideBikeWindow = (pocketKey(goal.pocket) === "motorrad" && month < "2026-10") ||
      ((pocketKey(goal.pocket) === "motorrad" || goal.funding) && month > goal.date.slice(0, 7));
    const gap = complete || outsideBikeWindow ? 0 : cents(goal.target - (balances[goal.id] ?? 0));
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
