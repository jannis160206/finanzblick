import { describe, expect, it } from "vitest";
import { calculateDashboard, monthsForYear } from "./calc";
import { allocateGoals, goalExtraIncome, goalPocketConflicts, GOAL_SURPLUS, pocketKey, SAVINGS_FLOOR, vacationSavingPaused } from "./goals";
import { planGoal, withGoalPlan, type PlanInput } from "./goal-planner";
import { createSeed } from "./seed";
import { emptyPockets, type SavingsGoal } from "./types";
import { monthlyVariableBudget } from "./variable-budgets";

// The allocation before goal plans existed, kept verbatim as the reference for goals without a plan.
function legacyAllocate(surplus: number, goals: SavingsGoal[], balances: Record<string, number | null>, month: string) {
  const cents = (amount: number) => Math.round(Math.max(0, amount) * 100);
  let remaining = cents(surplus);
  const savings = Math.min(remaining, cents(SAVINGS_FLOOR));
  remaining -= savings;
  const funding: Record<string, number> = {};
  const conflicts = goalPocketConflicts(goals);
  for (const goal of [...goals].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    if (conflicts.has(pocketKey(goal.pocket))) { funding[goal.id] = 0; continue; }
    const complete = goal.completedAt && goal.completedAt.slice(0, 7) < month;
    const outsideBikeWindow = (pocketKey(goal.pocket) === "motorrad" && month < "2026-10") ||
      ((pocketKey(goal.pocket) === "motorrad" || goal.funding) && month > goal.date.slice(0, 7));
    const balance = balances[goal.id];
    const gap = complete || outsideBikeWindow ? 0 : balance == null ? goal.funding ? Infinity : 0 : cents(goal.target - balance);
    const amount = goal.funding?.paused?.includes(month) ? 0 : Math.min(remaining, gap, goal.funding ? cents(goal.funding.monthly) : Infinity);
    funding[goal.id] = amount / 100 + (outsideBikeWindow ? 0 : goalExtraIncome(goal, month));
    remaining -= amount;
  }
  const pauseVacation = vacationSavingPaused(month);
  return { savings: (savings + (pauseVacation ? remaining : 0)) / 100, goals: funding, vacation: pauseVacation ? 0 : remaining / 100 };
}

function random(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1_103_515_245 + 12_345) % 2_147_483_648;
    return value / 2_147_483_648;
  };
}

const months = (from: string, count: number) => Array.from({ length: count }, (_, index) => {
  const date = new Date(`${from}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + index);
  return date.toISOString().slice(0, 7);
});

describe("allocation with and without goal plans", () => {
  it("allocates goals without a plan exactly like before", () => {
    const next = random(7);
    const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)];
    for (let round = 0; round < 400; round++) {
      const goals: SavingsGoal[] = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, index) => {
        const id = pick(["Motorrad", "Kamera", "Auto", "Reise", "Kamera"]) + (next() < 0.8 ? String(index) : "");
        const funded = next() < 0.5;
        return {
          id: `${id}-${index}`, name: id, pocket: id, target: Math.round(next() * 9000) + 100,
          date: pick(["2026-10-01", "2026-12-31", "2027-03-01", "2027-08-15"]),
          ...(next() < 0.2 ? { completedAt: pick(["2026-09-10", "2026-11-02"]) } : {}),
          ...(funded ? { funding: { monthly: Math.round(next() * 600), extras: (next() < 0.3 ? { "2026-11": 250 } : {}) as Record<string, number>, ...(next() < 0.2 ? { paused: ["2026-11"] } : {}) } } : {}),
        };
      });
      const balances = Object.fromEntries(goals.map((goal) => [goal.id, next() < 0.15 ? null : Math.round(next() * 5000)]));
      const surplus = Math.round((next() * 3000 - 300) * 100) / 100;
      const month = pick(["2026-09", "2026-10", "2026-11", "2027-03", "2027-06"]);
      expect(allocateGoals(surplus, goals, balances, month)).toEqual(legacyAllocate(surplus, goals, balances, month));
    }
  });

  it("uses the planned surplus rate inside the plan window and the monthly rate outside", () => {
    const goal: SavingsGoal = {
      id: "kamera", name: "Kamera", pocket: "Kamera", target: 2000, date: "2027-06-30",
      funding: {
        monthly: 50, extras: { "2026-11": 300 },
        plan: [{ month: "2026-11", account: GOAL_SURPLUS, amount: 120 }, { month: "2026-11", account: "Sparkonto", amount: 300 }, { month: "2026-12", account: GOAL_SURPLUS, amount: 0 }],
        window: { from: "2026-11", to: "2027-01" },
      },
    };
    expect(allocateGoals(1000, [goal], { kamera: 0 }, "2026-11").goals.kamera).toBe(420);
    expect(allocateGoals(1000, [goal], { kamera: 0 }, "2026-12").goals.kamera).toBe(0);
    expect(allocateGoals(1000, [goal], { kamera: 0 }, "2027-01").goals.kamera).toBe(0);
    expect(allocateGoals(1000, [goal], { kamera: 0 }, "2027-02").goals.kamera).toBe(50);
    expect(allocateGoals(250, [goal], { kamera: 0 }, "2026-11").goals.kamera).toBe(370);
  });
});

const base = (patch: Partial<PlanInput> = {}): PlanInput => ({
  need: 1200, months: months("2026-11", 6), goalMonth: "2027-04", capacity: Object.fromEntries(months("2026-11", 6).map((month) => [month, 500])),
  continuation: 500, accounts: [], surplus: true, locked: [], excludedMonths: [], ...patch,
});
const amounts = (rows: { month: string; account: string; amount: number }[], account = GOAL_SURPLUS) =>
  rows.filter((row) => row.account === account).map((row) => row.amount);

describe("goal planner", () => {
  it("spreads the amount evenly over the months until the due date", () => {
    const result = planGoal(base());
    expect(amounts(result.rows)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(result).toMatchObject({ planned: 1200, missing: 0, reached: "2027-04" });
  });

  it("moves the amount into months with more room and keeps cents exact", () => {
    const capacity = { "2026-11": 100, "2026-12": 500, "2027-01": 500, "2027-02": 500 };
    const result = planGoal(base({ need: 1200.5, months: months("2026-11", 4), goalMonth: "2027-02", capacity }));
    expect(amounts(result.rows)).toEqual([100, 367, 367, 366.5]);
    expect(result.planned).toBe(1200.5);
  });

  it("takes a remaining gap from the selected pockets in the first month and reports what is missing", () => {
    const capacity = Object.fromEntries(months("2026-11", 3).map((month) => [month, 200]));
    const covered = planGoal(base({ need: 1000, months: months("2026-11", 3), goalMonth: "2027-01", capacity, accounts: [{ id: "Sparkonto", available: 900 }] }));
    expect(amounts(covered.rows)).toEqual([200, 200, 200]);
    expect(covered.rows.find((row) => row.account === "Sparkonto")).toEqual({ month: "2026-11", account: "Sparkonto", amount: 400 });
    const short = planGoal(base({ need: 1000, months: months("2026-11", 3), goalMonth: "2027-01", capacity, accounts: [{ id: "Sparkonto", available: 150.8 }] }));
    expect(short.missing).toBe(250);
    expect(short.reached).toBeUndefined();
  });

  it("keeps locked rows, skips excluded months and never tops up a locked slot", () => {
    const result = planGoal(base({
      locked: [{ month: "2026-12", account: GOAL_SURPLUS, amount: 50 }, { month: "2026-11", account: "Sparkonto", amount: 300 }],
      excludedMonths: ["2027-02"], accounts: [{ id: "Sparkonto", available: 5000 }],
    }));
    expect(result.rows.filter((row) => row.month === "2027-02")).toEqual([]);
    expect(result.rows.find((row) => row.month === "2026-12")).toEqual({ month: "2026-12", account: GOAL_SURPLUS, amount: 50, locked: true });
    expect(result.rows.filter((row) => row.account === "Sparkonto")).toEqual([{ month: "2026-11", account: "Sparkonto", amount: 300, locked: true }]);
    expect(amounts(result.rows)).toEqual([213, 50, 213, 212, 212]);
    expect(result.planned).toBe(1200);
    const zero = planGoal(base({ locked: [{ month: "2026-11", account: GOAL_SURPLUS, amount: 0 }] }));
    expect(zero.rows[0]).toEqual({ month: "2026-11", account: GOAL_SURPLUS, amount: 0, locked: true });
    expect(amounts(zero.rows)).toEqual([0, 240, 240, 240, 240, 240]);
  });

  it("plans as fast as possible: pockets first, then the full surplus, and computes the month", () => {
    const result = planGoal(base({ goalMonth: undefined, need: 1700, accounts: [{ id: "Sparkonto", available: 400 }] }));
    expect(result.rows[0]).toEqual({ month: "2026-11", account: GOAL_SURPLUS, amount: 500 });
    expect(result.rows.find((row) => row.account === "Sparkonto")?.amount).toBe(400);
    expect(amounts(result.rows)).toEqual([500, 500, 300]);
    expect(result.reached).toBe("2027-01");
  });

  it("continues with a monthly rate after the planning horizon", () => {
    const later = planGoal(base({ need: 4200, goalMonth: "2027-08" }));
    expect(amounts(later.rows)).toEqual([420, 420, 420, 420, 420, 420]);
    expect(later.continuation).toEqual({ monthly: 420, from: "2027-05", to: "2027-08" });
    expect(later.reached).toBe("2027-08");
    const fast = planGoal(base({ need: 4200, goalMonth: undefined }));
    expect(fast.continuation).toEqual({ monthly: 500, from: "2027-05", to: "2027-07" });
    expect(fast.reached).toBe("2027-07");
  });
});

describe("goal plans in the month plan", () => {
  function stateWithPlan() {
    const state = createSeed();
    state.settings = { ...state.settings, baselineDate: "2026-11-01", asOf: "2026-11-05", balances: { ...emptyPockets(), Sparkonto: 2000 } };
    state.financeRows = [{ id: "income", label: "Gehalt", kind: "income", values: Object.fromEntries([...monthsForYear(2026), ...monthsForYear(2027)].map((month) => [month, 1000 + monthlyVariableBudget(month).total])) }];
    state.transactions = [];
    state.months = {};
    const goal: SavingsGoal = {
      id: "kamera", name: "Kamera", pocket: "Kamera", target: 1500, date: "2027-02-28", openingBalance: { date: "2026-11-01", amount: 0 },
      funding: {
        monthly: 0, extras: {}, auto: true, window: { from: "2026-11", to: "2027-02" },
        plan: [
          { month: "2026-11", account: GOAL_SURPLUS, amount: 150 }, { month: "2026-11", account: "Sparkonto", amount: 600, locked: true },
          ...months("2026-12", 3).map((month) => ({ month, account: GOAL_SURPLUS, amount: 250 })),
        ],
      },
    };
    const booked = withGoalPlan(state, goal);
    state.months = booked.months;
    state.savingsGoals = [booked.goal];
    return { state, goal: booked.goal };
  }

  it("books pocket transfers as extras and withdrawals and replaces them when re-planned", () => {
    const { state, goal } = stateWithPlan();
    expect(goal.funding?.extras).toEqual({ "2026-11": 600 });
    expect(state.months["2026-11"].pocketOut.Sparkonto).toBe(600);
    const replanned = withGoalPlan(state, { ...goal, funding: { ...goal.funding!, plan: goal.funding!.plan!.map((row) => row.account === "Sparkonto" ? { ...row, month: "2026-12", amount: 200 } : row) } }, goal);
    expect(replanned.goal.funding?.extras).toEqual({ "2026-12": 200 });
    expect(replanned.months["2026-11"].pocketOut.Sparkonto).toBe(0);
    expect(replanned.months["2026-12"].pocketOut.Sparkonto).toBe(200);
    const removed = withGoalPlan({ ...state, months: replanned.months }, { ...replanned.goal, funding: { ...replanned.goal.funding!, plan: [] } }, replanned.goal);
    expect(removed.months["2026-12"].pocketOut.Sparkonto).toBe(0);
    expect(removed.goal.funding?.extras).toEqual({});
  });

  it("funds the goal with the planned rates and moves the transfer out of the Sparkonto", () => {
    const { state } = stateWithPlan();
    const dashboard = calculateDashboard(state);
    const november = dashboard.timeline.find((row) => row.month === "2026-11")!;
    const december = dashboard.timeline.find((row) => row.month === "2026-12")!;
    expect(november.goalRates.kamera).toBe(750);
    expect(december.goalRates.kamera).toBe(250);
    expect(november.end.Sparkonto).toBeCloseTo(2000 + november.rates.Sparkonto - 600, 2);
    expect(dashboard.timeline.find((row) => row.month === "2027-02")!.goalEnd.kamera).toBeCloseTo(1500, 2);
  });
});
