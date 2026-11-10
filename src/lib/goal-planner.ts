import { addMonths, type Dashboard } from "@/lib/calc";
import { accountsWithRules, servesPurpose } from "@/lib/assistant/funds";
import { monthBasis, planningHorizon } from "@/lib/assistant/plan";
import { corePocket, GOAL_SURPLUS, goalBalanceStatus, pocketKey } from "@/lib/goals";
import { monthEndForecast } from "@/lib/month-forecast";
import { emptyMonth, pocketNames, type AccountRule, type AppState, type GoalPlanRow, type MonthInput, type Pocket, type SavingsGoal } from "@/lib/types";

export { GOAL_SURPLUS };

/** Where money for a goal can come from: the monthly surplus or the balance of another pocket. */
export type PlanSource = {
  id: string;
  label: string;
  kind: "surplus" | "pocket";
  /** Surplus: total over the planning months; pocket: what can be moved once. */
  available: number;
  perMonth?: number;
  /** Bank behind the account, for its logo (e.g. "Trade Republic"). */
  bank?: string;
  /** Blocked by its account rule but may be included for one goal as a deliberate exception. */
  exception?: boolean;
  /** Interest rate p.a. the balance earns (Trade Republic). */
  rate?: number;
  /** Suggested minimum to keep on the account when it is used as an exception. */
  keep?: number;
  balance?: number;
  use: AccountRule["use"];
  purposes: string[];
  detail?: string;
};

export type PlanningContext = {
  months: string[];
  /** Free surplus per month after fixed costs, budgets, planned purchases, other goals and the savings floor. */
  capacity: Record<string, number>;
  /** Free surplus per month assumed after the planning horizon. */
  continuation: number;
  sources: PlanSource[];
  /** Current balance of the goal's pocket; null when it is not known. */
  balance: number | null;
};

export type PlanInput = {
  need: number;
  months: string[];
  /** Month the goal is due; undefined plans as fast as possible. */
  goalMonth?: string;
  capacity: Record<string, number>;
  continuation: number;
  /** Selected pockets in order of preference; `late` ones are used last and as late as possible (interest keeps running). */
  accounts: { id: string; available: number; late?: boolean }[];
  surplus: boolean;
  locked: GoalPlanRow[];
  excludedMonths: string[];
};

export type PlanResult = {
  rows: GoalPlanRow[];
  planned: number;
  missing: number;
  reached?: string;
  /** Regular rate for the months after the planning horizon. */
  continuation?: { monthly: number; from: string; to: string };
};

const cents = (value: number) => Math.round(value * 100);
const euroFloor = (value: number) => Math.max(0, Math.floor(value)) * 100;
const monthDiff = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
const byMonth = (a: GoalPlanRow, b: GoalPlanRow) =>
  a.month.localeCompare(b.month) || Number(b.account === GOAL_SURPLUS) - Number(a.account === GOAL_SURPLUS) || a.account.localeCompare(b.account);

/**
 * Distributes what is still missing over the months and accounts. With a due month the surplus rate is kept as even as
 * possible (months with less room get less, the rest is spread evenly); pockets only fill a remaining gap, as one
 * transfer in the first month. As fast as possible uses the selected pockets first and then the full surplus.
 * Late accounts (Trade Republic) only cover what is still missing after that, in the last month needed.
 * Locked rows stay as they are and are never topped up.
 */
export function planGoal(input: PlanInput): PlanResult {
  const excluded = new Set(input.excludedMonths);
  const last = input.months.at(-1);
  const months = input.months.filter((month) => !excluded.has(month) && (!input.goalMonth || month <= input.goalMonth));
  const locked = input.locked.filter((row) => input.months.includes(row.month) && !excluded.has(row.month) && row.amount >= 0)
    .map((row) => ({ ...row, locked: true }));
  const total = cents(input.need);
  let need = total - locked.reduce((sum, row) => sum + cents(row.amount), 0);
  const lockedSurplus = new Set(locked.filter((row) => row.account === GOAL_SURPLUS).map((row) => row.month));
  const lockedAccounts = new Set(locked.filter((row) => row.account !== GOAL_SURPLUS).map((row) => row.account));
  const surplusCap = (month: string) => input.surplus && !lockedSurplus.has(month) ? euroFloor(input.capacity[month] ?? 0) : 0;
  const accounts = input.accounts.filter((account) => !lockedAccounts.has(account.id))
    .map((account) => ({ id: account.id, cap: euroFloor(account.available), late: !!account.late }));
  const early = accounts.filter((account) => !account.late);
  const late = accounts.filter((account) => account.late);
  const lateRoom = () => late.reduce((sum, account) => sum + account.cap, 0);
  const rows: GoalPlanRow[] = [...locked];
  const add = (month: string, account: string, amount: number) => {
    if (amount > 0) rows.push({ month, account, amount: amount / 100 });
  };
  const first = months[0];
  const fromAccounts = () => {
    if (!first) return;
    for (const account of early) {
      const take = Math.min(account.cap, need);
      add(first, account.id, take);
      need -= take;
    }
  };
  const fromLate = (month: string | undefined) => {
    if (!month) return;
    for (const account of late) {
      const take = Math.min(account.cap, need);
      add(month, account.id, take);
      account.cap -= take;
      need -= take;
    }
  };
  const continuationCap = input.surplus ? euroFloor(input.continuation) : 0;
  let continuation: PlanResult["continuation"];

  if (need > 0 && !input.goalMonth) {
    fromAccounts();
    for (const month of months) {
      const take = Math.min(surplusCap(month), need);
      add(month, GOAL_SURPLUS, take);
      need -= take;
      if (need > 0 && need <= lateRoom()) { fromLate(month); break; }
    }
    if (need > 0) fromLate(months.at(-1));
    if (need > 0 && continuationCap > 0 && last) {
      const count = Math.ceil(need / continuationCap);
      continuation = { monthly: continuationCap / 100, from: addMonths(last, 1), to: addMonths(last, count) };
      need = 0;
    }
  } else if (need > 0 && input.goalMonth) {
    const after = last && input.goalMonth > last ? monthDiff(last, input.goalMonth) : 0;
    const slots = [
      ...months.map((month) => ({ month: month as string | null, cap: surplusCap(month), amount: 0 })),
      ...Array.from({ length: after }, () => ({ month: null as string | null, cap: continuationCap, amount: 0 })),
    ];
    const room = slots.reduce((sum, slot) => sum + slot.cap, 0);
    if (room >= need) {
      const reach = (level: number) => slots.reduce((sum, slot) => sum + Math.min(slot.cap, level * 100), 0);
      let low = 1;
      let high = Math.max(1, Math.ceil(Math.max(...slots.map((slot) => slot.cap)) / 100));
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (reach(middle) >= need) high = middle; else low = middle + 1;
      }
      for (const slot of slots) slot.amount = Math.min(slot.cap, (low - 1) * 100);
      let deficit = need - slots.reduce((sum, slot) => sum + slot.amount, 0);
      for (const slot of slots) {
        if (deficit <= 0) break;
        const extra = Math.min(100, slot.cap - slot.amount, deficit);
        slot.amount += extra;
        deficit -= extra;
      }
      need = 0;
    } else {
      for (const slot of slots) slot.amount = slot.cap;
      need -= room;
    }
    for (const slot of slots) if (slot.month) add(slot.month, GOAL_SURPLUS, slot.amount);
    const later = slots.filter((slot) => !slot.month);
    if (later.length && last && later.some((slot) => slot.amount > 0)) {
      continuation = { monthly: Math.max(...later.map((slot) => slot.amount)) / 100, from: addMonths(last, 1), to: input.goalMonth };
    }
    if (need > 0) fromAccounts();
    if (need > 0) fromLate(months.at(-1));
  }

  rows.sort(byMonth);
  const laterTotal = continuation ? cents(continuation.monthly) * (monthDiff(continuation.from, continuation.to) + 1) : 0;
  const plannedCents = rows.reduce((sum, row) => sum + cents(row.amount), 0) + laterTotal;
  let reached: string | undefined;
  let running = 0;
  for (const month of [...new Set(rows.map((row) => row.month))].sort()) {
    running += rows.filter((row) => row.month === month).reduce((sum, row) => sum + cents(row.amount), 0);
    if (running >= total) { reached = month; break; }
  }
  if (!reached && continuation && running < total) {
    const rate = cents(continuation.monthly);
    reached = rate > 0 ? addMonths(continuation.from, Math.max(0, Math.ceil((total - running) / rate) - 1)) : undefined;
  }
  return {
    rows,
    planned: plannedCents / 100,
    missing: Math.max(0, total - plannedCents) / 100,
    ...(reached ? { reached } : {}),
    ...(continuation ? { continuation } : {}),
  };
}

const futureTransfers = (goal: SavingsGoal | undefined, from: string) => {
  const result = new Map<Pocket, number>();
  for (const row of goal?.funding?.plan ?? []) {
    const pocket = row.account === GOAL_SURPLUS ? undefined : corePocket(row.account);
    if (pocket && row.month >= from) result.set(pocket, (result.get(pocket) ?? 0) + row.amount);
  }
  return result;
};

/** Monthly room, sources and the goal's balance, as the dialog needs them; an existing goal's own rates count as free. */
export function goalPlanningContext(state: AppState, dashboard: Dashboard, today: string, goal?: SavingsGoal): PlanningContext {
  const current = dashboard.currentMonth;
  const horizon = planningHorizon(dashboard);
  const months: string[] = [];
  for (let month = current; month <= horizon && months.length < 36; month = addMonths(month, 1)) months.push(month);
  const existing = goal ? dashboard.goals.find((item) => item.id === goal.id) : undefined;
  const forecast = monthEndForecast(state, dashboard, today);
  const capacity: Record<string, number> = {};
  for (const month of months) {
    const basis = monthBasis(state, dashboard, month);
    const own = existing && basis ? Math.max(0, (basis.goalRates[existing.id] ?? 0) - (basis.goalExtras[existing.id] ?? 0)) : 0;
    let free = basis ? basis.free + own : 0;
    if (month === current && forecast.status === "ok") free = Math.min(free, forecast.free + own);
    capacity[month] = Math.max(0, Math.floor(free));
  }
  const reserved = new Map<string, number>();
  for (const [month, input] of Object.entries(state.months)) {
    if (month < current) continue;
    for (const pocket of pocketNames) reserved.set(pocket, (reserved.get(pocket) ?? 0) + (input.pocketOut[pocket] ?? 0));
  }
  const own = futureTransfers(existing, current);
  const total = months.reduce((sum, month) => sum + capacity[month], 0);
  const sources: PlanSource[] = [{
    id: GOAL_SURPLUS, label: "Girokonto", kind: "surplus", available: total,
    perMonth: months.length ? Math.floor(total / months.length) : 0, use: "any", purposes: [],
  }];
  for (const account of accountsWithRules(state, dashboard, today)) {
    const pocket = corePocket(account.name);
    if (!pocket || sources.some((source) => source.id === pocket)) continue;
    const available = Math.max(0, Math.floor(account.available - (reserved.get(pocket) ?? 0) + (own.get(pocket) ?? 0)));
    // The Notgroschen is the Trade Republic account once its balance comes from there.
    const tradeRepublic = pocket === "Notgroschen" && !!state.trBalances?.length;
    sources.push({
      id: pocket, label: tradeRepublic ? "Trade Republic · Notgroschen" : pocket, kind: "pocket", available, balance: account.balance,
      use: account.use, purposes: account.purposes,
      ...(account.detail ? { detail: account.detail } : {}),
      ...(tradeRepublic ? { bank: "Trade Republic", exception: true, rate: interestRate(state, today), keep: state.settings.emergencyTarget } : {}),
    });
  }
  const balance = existing ? goalBalanceStatus(state, existing, dashboard.actual).amount : null;
  return { months, capacity, continuation: capacity[horizon] ?? 0, sources, balance };
}

const interestRate = (state: AppState, today: string) =>
  state.settings.interestRates?.filter((entry) => entry.date <= today).sort((a, b) => b.date.localeCompare(a.date))[0]?.rate
    ?? (today < state.settings.rateChangeDate ? state.settings.oldRate : state.settings.newRate);

/** Interest the money would still earn on the account between the transfer month and the goal month (after 27,5 % KESt). */
export function forgoneInterest(amount: number, rate: number | undefined, transferMonth: string, goalMonth: string) {
  if (!rate || amount <= 0 || transferMonth >= goalMonth) return 0;
  return Math.round(amount * rate * monthDiff(transferMonth, goalMonth) / 12 * (1 - 0.275) * 100) / 100;
}

/** Whether the user's account rules allow using the source for this goal. */
export function sourceAllowed(source: PlanSource, goalName: string, goalPocket: string) {
  if (source.kind === "pocket" && pocketKey(source.id) === pocketKey(goalPocket)) return false;
  return source.use === "any" || (source.use === "only" && servesPurpose(source.purposes, goalName));
}

/**
 * Books a goal's plan into the state: transfers from pockets become extras for the goal and withdrawals in the month
 * plan (like the assistant's start payments); the previous plan's transfers are taken back first.
 */
export function withGoalPlan(state: AppState, goal: SavingsGoal, previous?: SavingsGoal): { goal: SavingsGoal; months: AppState["months"] } {
  const transfers = (item?: SavingsGoal) => {
    const result = new Map<string, Map<Pocket, number>>();
    for (const row of item?.funding?.plan ?? []) {
      const pocket = row.account === GOAL_SURPLUS ? undefined : corePocket(row.account);
      if (!pocket || row.amount <= 0) continue;
      const month = result.get(row.month) ?? new Map<Pocket, number>();
      month.set(pocket, (month.get(pocket) ?? 0) + cents(row.amount));
      result.set(row.month, month);
    }
    return result;
  };
  const before = transfers(previous);
  const after = transfers(goal);
  if (!before.size && !after.size) return { goal, months: state.months };
  const total = (map: Map<Pocket, number> | undefined) => [...map?.values() ?? []].reduce((sum, value) => sum + value, 0);
  const extras = { ...goal.funding?.extras ?? {} };
  const months = { ...state.months };
  for (const month of new Set([...before.keys(), ...after.keys()])) {
    const amount = cents(extras[month] ?? 0) - total(before.get(month)) + total(after.get(month));
    if (amount > 0) extras[month] = amount / 100; else delete extras[month];
    const input: MonthInput = months[month] ?? emptyMonth();
    const pocketOut = { ...input.pocketOut };
    for (const pocket of pocketNames) {
      const change = (after.get(month)?.get(pocket) ?? 0) - (before.get(month)?.get(pocket) ?? 0);
      if (change) pocketOut[pocket] = Math.max(0, cents(pocketOut[pocket]) + change) / 100;
    }
    months[month] = { ...input, pocketOut };
  }
  return { goal: { ...goal, ...(goal.funding ? { funding: { ...goal.funding, extras } } : {}) }, months };
}
