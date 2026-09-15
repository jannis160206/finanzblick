import type { AppState, SavingsGoal } from "@/lib/types";

export const SAVINGS_FLOOR = 180;
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

export function goalBalance(state: AppState, goal: SavingsGoal, core: Record<string, number>, date = state.settings.asOf): number {
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

export function allocateGoals(surplus: number, goals: SavingsGoal[], balances: Record<string, number>, month: string) {
  let remaining = cents(surplus);
  const savings = Math.min(remaining, cents(SAVINGS_FLOOR));
  remaining -= savings;
  const funding: Record<string, number> = {};
  for (const goal of [...goals].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    // Completion is historical: withdrawing a purchased goal must not restart it.
    // Keep this month's original instruction so its imported transfer can be checked off.
    const complete = goal.completedAt && goal.completedAt.slice(0, 7) < month;
    const outsideBikeWindow = pocketKey(goal.pocket) === "motorrad" &&
      (month < "2026-10" || month > goal.date.slice(0, 7));
    const gap = complete || outsideBikeWindow ? 0 : cents(goal.target - (balances[goal.id] ?? 0));
    const amount = Math.min(remaining, gap);
    funding[goal.id] = amount / 100;
    remaining -= amount;
  }
  return { savings: savings / 100, goals: funding, vacation: remaining / 100 };
}

export function transferMatches(planned: number, incoming: number): boolean {
  if (planned <= 0 || incoming <= 0) return false;
  return Math.abs(Math.round((incoming - planned) * 100)) <= Math.max(500, Math.round(planned * 3));
}
