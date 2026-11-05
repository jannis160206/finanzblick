import { addMonths, calculateMonthTotals, round, sum, type Dashboard } from "@/lib/calc";
import { allocateGoals, bankPocketBalance, corePocket, goalExtraIncome, pocketKey, SAVINGS_FLOOR, savingsGoals } from "@/lib/goals";
import { plannedOccurrences } from "@/lib/planned-one-offs";
import { plannedOneOffSchema, savingsGoalSchema, type AppState, type AssistantDraft, type AssistantOperation, type PlannedOneOff, type Pocket, type SavingsGoal } from "@/lib/types";
import { lastDay } from "./intent";

export type MonthBasis = {
  month: string;
  surplus: number;
  allocationInput: number;
  goalRates: Record<string, number>;
  goalExtras: Record<string, number>;
  // What is left after fixed costs, budgets, planned purchases, goal rates and the savings buffer.
  free: number;
};

const monthDiff = (from: string, to: string) => {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + tm - fm;
};
const monthEnd = (month: string) => `${month}-${String(lastDay(month)).padStart(2, "0")}`;

export function planningHorizon(dashboard: Dashboard): string {
  return dashboard.timeline.at(-1)?.month ?? dashboard.currentMonth;
}

export function monthBasis(state: AppState, dashboard: Dashboard, month: string): MonthBasis | undefined {
  if (month < dashboard.currentMonth || month > planningHorizon(dashboard)) return undefined;
  const goals = dashboard.goals;
  const row = dashboard.timeline.find((item) => item.month === month);
  const totals = row ?? calculateMonthTotals(state, month, { currentMonth: dashboard.currentMonth });
  const goalRates = row?.goalRates ?? {};
  const goalExtras = Object.fromEntries(goals.map((goal) => [goal.id, goalExtraIncome(goal, month)]));
  const remaining = round(totals.surplus - sum(Object.values(goalRates)));
  return {
    month, surplus: totals.surplus, allocationInput: round(totals.surplus + totals.plannedOneOffs - totals.goalExtras),
    goalRates, goalExtras, free: round(remaining - SAVINGS_FLOOR),
  };
}

function goalBalancesBefore(dashboard: Dashboard, month: string): Record<string, number | null> {
  const previous = dashboard.timeline.find((row) => row.month === addMonths(month, -1));
  if (month === dashboard.currentMonth || !previous) return { ...dashboard.actualGoals };
  return { ...previous.goalEnd };
}

export type GoalConflict = { goalId: string; name: string; date: string; loss: number; late: boolean };
export type GoalPlan = {
  ok: boolean;
  error?: string;
  name: string;
  target: number;
  start: number;
  date: string;
  months: number;
  monthly: number;
  // Monthly amount the user named, if it is not enough for the chosen date.
  offered?: number;
  reachableWithOffered?: string;
  // Extra start payments, e.g. 2 × 60 € from the Sparkonto.
  extra?: { amount: number; months: number; total: number; from?: string };
  planned: number;
  fundedInPlan: number;
  checkedUntil: string;
  firstMonth: string;
  // Months where the plan cannot pay the full rate.
  shortMonths: string[];
  conflicts: GoalConflict[];
  warnings: string[];
};

export function goalNameError(state: AppState, name: string): string | undefined {
  const key = pocketKey(name);
  if (["sparkonto", "urlaub", "notgroschen", "giro"].includes(key)) return "Bitte einen eigenen Zielnamen verwenden, nicht Sparkonto, Urlaub, Notgroschen oder Giro.";
  if (savingsGoals(state).some((goal) => pocketKey(goal.name) === key || pocketKey(goal.pocket) === key)) return `Ein Sparziel „${name}“ gibt es schon.`;
  if (savingsGoals(state).length >= 50) return "Es sind bereits 50 Sparziele angelegt.";
  return undefined;
}

export function planSavingsGoal(state: AppState, dashboard: Dashboard, draft: AssistantDraft): GoalPlan {
  const name = draft.name ?? "Sparziel";
  const target = draft.amount ?? 0;
  const start = draft.startCapital ?? 0;
  const current = dashboard.currentMonth;
  const base: GoalPlan = { ok: false, name, target, start, date: draft.date ?? monthEnd(current), months: 0, monthly: 0,
    planned: 0, fundedInPlan: 0, checkedUntil: current, firstMonth: current, shortMonths: [], conflicts: [], warnings: [] };
  const nameError = goalNameError(state, name);
  if (nameError) return { ...base, error: nameError };
  const gap = round(target - start);
  if (gap <= 0) return { ...base, error: "Das Startkapital deckt das Ziel schon. Ein Sparziel ist dafür nicht nötig." };
  let date = draft.date;
  let months: number;
  let monthly: number;
  let offered: number | undefined;
  let reachableWithOffered: string | undefined;
  const extra = draft.extra;
  const extraIn = (count: number) => extra ? round(extra.amount * Math.min(extra.months, count)) : 0;
  // Months needed when the rate runs every month and the extras only in the first months.
  const monthsFor = (rate: number) => {
    for (let count = 1; count <= 600; count++) if (round(rate * count + extraIn(count)) + 0.005 >= gap) return count;
    return 601;
  };
  if (date) {
    if (date < state.settings.asOf) return { ...base, error: "Das Zieldatum liegt in der Vergangenheit." };
    months = monthDiff(current, date.slice(0, 7)) + 1;
    monthly = Math.max(0, Math.ceil((gap - extraIn(months)) / months));
    if (draft.monthly && draft.monthly < monthly) {
      offered = draft.monthly;
      reachableWithOffered = monthEnd(addMonths(current, monthsFor(draft.monthly) - 1));
    }
  } else {
    monthly = Math.ceil(draft.monthly ?? 0);
    if (monthly <= 0) return { ...base, error: "Mir fehlt das Zieldatum oder die Monatsrate." };
    months = monthsFor(monthly);
    if (months > 600) return { ...base, error: "Mit dieser Rate würde das Ziel über 50 Jahre dauern." };
    date = monthEnd(addMonths(current, months - 1));
  }
  if (extra && addMonths(current, Math.min(extra.months, months) - 1) > "2027-12")
    return { ...base, error: "Extra-Beträge kann ich nur bis Dezember 2027 einplanen." };
  const goal = buildSavingsGoal(state, { ...draft, date, monthly }, monthly, "preview", current);
  const simulation = simulateGoal(state, dashboard, goal);
  const warnings: string[] = [];
  const planned = round(gap);
  const covered = round(simulation.funded);
  if (simulation.checkedUntil < date.slice(0, 7)) warnings.push(`Der Monatsplan reicht nur bis ${simulation.checkedUntil.slice(5)}/${simulation.checkedUntil.slice(0, 4)}. Spätere Monate sind nicht geprüft.`);
  const needs = new Map<string, number>();
  if (start > 0 && draft.fromAccount && corePocket(draft.fromAccount)) needs.set(corePocket(draft.fromAccount)!, start);
  const extraMonths = extra ? Math.min(extra.months, months) : 0;
  if (extra?.from && extra.from !== "Giro") needs.set(extra.from, round((needs.get(extra.from) ?? 0) + extraIn(months)));
  for (const [pocket, need] of needs) {
    const balance = bankPocketBalance(state, pocket as Pocket, dashboard.actual);
    if (balance !== null && balance < need) warnings.push(`Auf dem ${pocket} liegen nur ${balance.toFixed(2)} €, gebraucht werden ${need.toFixed(2)} €.`);
  }
  if (extra?.from === "Giro") warnings.push("Die Extra-Beträge vom Giro kommen aus deinem Guthaben, nicht aus dem laufenden Überschuss.");
  return { ...base, ok: true, date, months, monthly, offered, reachableWithOffered, planned,
    ...(extra ? { extra: { amount: extra.amount, months: extraMonths, total: extraIn(months), ...(extra.from ? { from: extra.from } : {}) } } : {}),
    fundedInPlan: covered, checkedUntil: simulation.checkedUntil, firstMonth: current, shortMonths: simulation.shortMonths,
    conflicts: simulation.conflicts, warnings };
}

function simulateGoal(state: AppState, dashboard: Dashboard, goal: SavingsGoal) {
  const existing = dashboard.goals;
  const lastMonth = goal.date.slice(0, 7);
  const horizon = planningHorizon(dashboard);
  const losses = new Map<string, number>();
  const shortMonths: string[] = [];
  let funded = 0;
  let balance = goal.openingBalance?.amount ?? 0;
  let checkedUntil = dashboard.currentMonth;
  for (let month = dashboard.currentMonth; month <= lastMonth && month <= horizon; month = addMonths(month, 1)) {
    const basis = monthBasis(state, dashboard, month);
    if (!basis) break;
    checkedUntil = month;
    const balances = { ...goalBalancesBefore(dashboard, month), [goal.id]: balance };
    const after = allocateGoals(basis.allocationInput, [...existing, goal], balances, month).goals;
    const rate = after[goal.id] ?? 0;
    if (rate + 0.5 < (goal.funding?.monthly ?? 0) && balance + rate + 0.5 < goal.target) shortMonths.push(month);
    funded += rate;
    balance += rate;
    for (const item of existing) {
      const loss = round((basis.goalRates[item.id] ?? 0) - (after[item.id] ?? 0));
      if (loss > 0.005 && month <= item.date.slice(0, 7)) losses.set(item.id, round((losses.get(item.id) ?? 0) + loss));
    }
  }
  const conflicts = [...losses].map(([goalId, loss]) => {
    const item = existing.find((entry) => entry.id === goalId)!;
    const end = dashboard.timeline.find((row) => row.month === item.date.slice(0, 7))?.goalEnd[item.id];
    return { goalId, name: item.name, date: item.date, loss, late: end === null || end === undefined || end - loss < item.target };
  });
  return { funded: round(funded), conflicts, checkedUntil, shortMonths };
}

export function buildSavingsGoal(state: AppState, draft: AssistantDraft, monthly: number, id: string = crypto.randomUUID(), extrasFrom?: string): SavingsGoal {
  const name = (draft.name ?? "Sparziel").trim().slice(0, 80);
  // Extras are only embedded for previews; a real goal gets them through the goal_extras operation (with pocket withdrawal).
  const extras = draft.extra && extrasFrom ? Object.fromEntries(Array.from({ length: draft.extra.months }, (_, index) => addMonths(extrasFrom, index))
    .filter((month) => month <= (draft.date ?? "").slice(0, 7) && month <= "2027-12").map((month) => [month, draft.extra!.amount])) : {};
  return savingsGoalSchema.parse({
    id, name, pocket: name, target: draft.amount, date: draft.date,
    // A documented start keeps the balance known, so the plan can keep funding all goals.
    openingBalance: { date: state.settings.asOf, amount: draft.startCapital ?? 0 },
    funding: { monthly, extras },
  });
}

// The operation that books a new goal's start extras, limited to the months before its date.
export function goalExtraOperation(goal: SavingsGoal, draft: AssistantDraft, firstMonth: string): AssistantOperation | undefined {
  if (!draft.extra) return undefined;
  const months = Math.min(draft.extra.months, monthDiff(firstMonth, goal.date.slice(0, 7)) + 1);
  if (months < 1) return undefined;
  return { op: "goal_extras", goalId: goal.id, start: firstMonth, months, amount: draft.extra.amount, ...(draft.extra.from ? { from: draft.extra.from } : {}) };
}

export function buildPlannedOneOff(draft: AssistantDraft, id: string = crypto.randomUUID()): PlannedOneOff {
  const installments = draft.installments ?? 1;
  const total = draft.amount ?? 0;
  const rate = installments > 1 ? Math.floor(total * 100 / installments) / 100 : total;
  return plannedOneOffSchema.parse({
    id, name: (draft.name ?? "Geplante Ausgabe").slice(0, 100), date: draft.date, amount: rate,
    pocket: draft.fromAccount === "Sparkonto" ? "Sparkonto" : "Giro", installments,
    ...(installments > 1 && Math.round(rate * installments * 100) !== Math.round(total * 100) ? { total } : {}),
    ...(draft.shared ? { sharedWithRaphael: true } : {}),
  });
}

export type Light = "green" | "yellow" | "red" | "unknown";
export type AffordabilityMonth = { month: string; cost: number; free: number; after: number; pausable: number };
export type Affordability = {
  light: Light;
  months: AffordabilityMonth[];
  // Tightest month: smallest money left after the purchase.
  tightest?: AffordabilityMonth;
  shortfall: number;
  pause: { goalId: string; name: string; month: string; amount: number }[];
  alternatives: { kind: "installments" | "later" | "reserve"; installments?: number; month?: string; rate?: number; balance?: number }[];
  error?: string;
};

function costMonths(draft: AssistantDraft) {
  const item = buildPlannedOneOff({ ...draft, name: draft.name ?? "Prüfung" }, "check");
  const months = new Map<string, number>();
  for (const occurrence of plannedOccurrences([item]))
    months.set(occurrence.date.slice(0, 7), round((months.get(occurrence.date.slice(0, 7)) ?? 0) + occurrence.ownAmount));
  return months;
}

function evaluate(state: AppState, dashboard: Dashboard, draft: AssistantDraft, buffer = 0) {
  const rows: AffordabilityMonth[] = [];
  for (const [month, cost] of costMonths(draft)) {
    const basis = monthBasis(state, dashboard, month);
    if (!basis) return undefined;
    const pausable = round(sum(dashboard.goals.map((goal) =>
      Math.max(0, (basis.goalRates[goal.id] ?? 0) - (basis.goalExtras[goal.id] ?? 0)))));
    const free = round(basis.free - buffer);
    rows.push({ month, cost, free, after: round(free - cost), pausable });
  }
  return rows;
}

// buffer: money the user wants to keep untouched every month (remembered by the assistant).
export function checkAffordability(state: AppState, dashboard: Dashboard, draft: AssistantDraft, buffer = 0): Affordability {
  const empty: Affordability = { light: "unknown", months: [], shortfall: 0, pause: [], alternatives: [] };
  if (!draft.amount || !draft.date) return { ...empty, error: "Betrag oder Monat fehlt." };
  if (draft.date.slice(0, 7) < dashboard.currentMonth) return { ...empty, error: "Der Monat liegt in der Vergangenheit." };
  const rows = evaluate(state, dashboard, draft, buffer);
  const horizon = planningHorizon(dashboard);
  if (!rows) return { ...empty, error: `Der Monatsplan reicht nur bis ${horizon.slice(5)}/${horizon.slice(0, 4)}.` };
  const tightest = [...rows].sort((a, b) => a.after - b.after)[0];
  if (rows.every((row) => row.after >= 0)) return { ...empty, light: "green", months: rows, tightest };
  const failing = rows.filter((row) => row.after < 0);
  const shortfall = round(Math.max(...failing.map((row) => -row.after)));
  const coverable = failing.every((row) => row.pausable + row.after >= 0);
  const pause: Affordability["pause"] = [];
  if (coverable) for (const row of failing) {
    let need = -row.after;
    const basis = monthBasis(state, dashboard, row.month)!;
    // Pause the goal with the latest deadline first; it has the most time to catch up.
    for (const goal of [...dashboard.goals].sort((a, b) => b.date.localeCompare(a.date))) {
      const rate = round(Math.max(0, (basis.goalRates[goal.id] ?? 0) - (basis.goalExtras[goal.id] ?? 0)));
      if (need <= 0 || rate <= 0) continue;
      const amount = round(Math.min(rate, need));
      pause.push({ goalId: goal.id, name: goal.name, month: row.month, amount });
      need = round(need - amount);
    }
  }
  const alternatives: Affordability["alternatives"] = [];
  const total = draft.amount;
  for (let count = Math.max(2, (draft.installments ?? 1) + 1); count <= 12; count++) {
    const option = evaluate(state, dashboard, { ...draft, installments: count }, buffer);
    if (option && option.every((row) => row.after >= 0)) {
      alternatives.push({ kind: "installments", installments: count, rate: Math.floor(total * 100 / count) / 100 });
      break;
    }
  }
  for (let offset = 1; offset <= 12; offset++) {
    const month = addMonths(draft.date.slice(0, 7), offset);
    if (month > horizon) break;
    const option = evaluate(state, dashboard, { ...draft, date: `${month}-01` }, buffer);
    if (option && option.every((row) => row.after >= 0)) { alternatives.push({ kind: "later", month }); break; }
  }
  const reserve = bankPocketBalance(state, "Sparkonto", dashboard.actual);
  if (reserve !== null && reserve >= shortfall) alternatives.push({ kind: "reserve", balance: reserve });
  return { light: coverable ? "yellow" : "red", months: rows, tightest, shortfall, pause, alternatives };
}
