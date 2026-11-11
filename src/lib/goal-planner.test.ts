import { describe, expect, it } from "vitest";
import { calculateDashboard, monthsForYear } from "./calc";
import { accountKeep, allocateGoals, goalExtraIncome, goalPocketConflicts, GOAL_SURPLUS, pocketKey, SAVINGS_FLOOR, vacationSavingPaused } from "./goals";
import { forgoneInterest, goalPlanningContext, planGoal, sourceAllowed, usableAmount, withGoalPlan, withGoalSettings, type PlanInput } from "./goal-planner";
import { createSeed } from "./seed";
import { appStateSchema, emptyPockets, type SavingsGoal } from "./types";
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
  it("allocates goals without a plan exactly like before (savings rate 0: only the floor)", () => {
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
      expect(allocateGoals(surplus, goals, balances, month, 0)).toEqual(legacyAllocate(surplus, goals, balances, month));
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

  it("keeps the reserve of each month's free surplus on the Girokonto when planning as fast as possible", () => {
    const fast = planGoal(base({ goalMonth: undefined, need: 1700, reserve: 0.15 }));
    expect(amounts(fast.rows)).toEqual([425, 425, 425, 425]);
    expect(fast.reached).toBe("2027-02");
    const odd = planGoal(base({ goalMonth: undefined, need: 1000, reserve: 0.15, capacity: { ...base().capacity, "2026-11": 820 } }));
    expect(amounts(odd.rows)[0]).toBe(697);
    expect(planGoal(base({ goalMonth: undefined, need: 6000, reserve: 0.2 })).continuation).toEqual({ monthly: 400, from: "2027-05", to: "2028-01" });
    expect(amounts(planGoal(base({ goalMonth: undefined, need: 1700, reserve: 0.9 })).rows)).toEqual([250, 250, 250, 250, 250, 250]);
    // With a due date the plan may use the whole free surplus.
    expect(amounts(planGoal(base({ need: 3000, reserve: 0.15 })).rows)).toEqual([500, 500, 500, 500, 500, 500]);
  });
});

describe("Trade Republic (Notgroschen) used last", () => {
  it("covers only what surplus and other pockets leave open, in the goal month", () => {
    const capacity = Object.fromEntries(months("2026-11", 6).map((month) => [month, 100]));
    const result = planGoal(base({ need: 1500, capacity, accounts: [{ id: "Notgroschen", available: 4000, late: true }, { id: "Sparkonto", available: 200 }] }));
    expect(amounts(result.rows)).toEqual([100, 100, 100, 100, 100, 100]);
    expect(result.rows.filter((row) => row.account !== GOAL_SURPLUS)).toEqual([
      { month: "2026-11", account: "Sparkonto", amount: 200 },
      { month: "2027-04", account: "Notgroschen", amount: 700 },
    ]);
    expect(result).toMatchObject({ planned: 1500, missing: 0, reached: "2027-04" });
  });

  it("is not touched while the surplus is enough and respects its available amount", () => {
    expect(planGoal(base({ accounts: [{ id: "Notgroschen", available: 4000, late: true }] })).rows.some((row) => row.account === "Notgroschen")).toBe(false);
    const capacity = Object.fromEntries(months("2026-11", 6).map((month) => [month, 100]));
    const short = planGoal(base({ need: 1500, capacity, accounts: [{ id: "Notgroschen", available: 300.9, late: true }] }));
    expect(short.rows.find((row) => row.account === "Notgroschen")).toEqual({ month: "2027-04", account: "Notgroschen", amount: 300 });
    expect(short.missing).toBe(600);
  });

  it("reaches an as-soon-as-possible goal earlier, with the transfer in the month it is reached", () => {
    const without = planGoal(base({ goalMonth: undefined, need: 2000 }));
    expect(without.reached).toBe("2027-02");
    const withTr = planGoal(base({ goalMonth: undefined, need: 2000, accounts: [{ id: "Notgroschen", available: 1200, late: true }] }));
    expect(withTr.reached).toBe("2026-12");
    expect(withTr.rows).toEqual([
      { month: "2026-11", account: GOAL_SURPLUS, amount: 500 },
      { month: "2026-12", account: GOAL_SURPLUS, amount: 500 },
      { month: "2026-12", account: "Notgroschen", amount: 1000 },
    ]);
  });

  it("keeps a transfer the user moved to another month", () => {
    const capacity = Object.fromEntries(months("2026-11", 6).map((month) => [month, 100]));
    const result = planGoal(base({ need: 1500, capacity, accounts: [{ id: "Notgroschen", available: 4000, late: true }],
      locked: [{ month: "2027-01", account: "Notgroschen", amount: 900 }] }));
    expect(result.rows.filter((row) => row.account === "Notgroschen")).toEqual([{ month: "2027-01", account: "Notgroschen", amount: 900, locked: true }]);
    expect(amounts(result.rows)).toEqual([100, 100, 100, 100, 100, 100]);
  });

  it("estimates the interest an earlier transfer gives up", () => {
    expect(forgoneInterest(1000, 0.0225, "2027-01", "2027-04")).toBe(4.08);
    expect(forgoneInterest(1000, 0.0225, "2027-04", "2027-04")).toBe(0);
    expect(forgoneInterest(1000, undefined, "2027-01", "2027-04")).toBe(0);
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

describe("planning context", () => {
  const all = [...monthsForYear(2026), ...monthsForYear(2027)];
  function contextState() {
    const state = createSeed();
    state.settings = { ...state.settings, baselineDate: "2026-11-01", asOf: "2026-11-05", emergencyTarget: 6000,
      balances: { ...emptyPockets(), Sparkonto: 2000, Notgroschen: 8000, Urlaub: 900, Motorrad: 500 } };
    state.financeRows = [
      { id: "income-salary", label: "Gehalt", kind: "income", values: Object.fromEntries(all.map((month) => [month, 2000])) },
      { id: "income-side", label: "Nebenjob", kind: "income", values: Object.fromEntries(all.map((month) => [month, monthlyVariableBudget(month).total])) },
    ];
    state.transactions = [];
    state.months = {};
    state.savingsGoals = [];
    return state;
  }

  it("offers only the Sparkonto and the Notgroschen once, minus what is kept there", () => {
    const state = contextState();
    const context = goalPlanningContext(state, calculateDashboard(state), state.settings.asOf);
    expect(context.sources.map((source) => source.id)).toEqual([GOAL_SURPLUS, "Sparkonto", "Notgroschen"]);
    const [, sparkonto, notgroschen] = context.sources;
    expect(sparkonto).toMatchObject({ label: "Sparkonto", available: 2000, keep: 0, balance: 2000 });
    expect(sparkonto.late).toBeUndefined();
    expect(notgroschen).toMatchObject({ label: "Notgroschen", available: 8000, keep: 6000, late: true });
    expect(usableAmount(notgroschen)).toBe(2000);
    expect(usableAmount(notgroschen, 8500)).toBe(0);
    expect(context.forecast).toEqual({});

    state.settings.accountKeep = { Sparkonto: 500, Notgroschen: 1000 };
    state.trBalances = [{ date: "2026-11-01", balance: 9000 }];
    const kept = goalPlanningContext(state, calculateDashboard(state), state.settings.asOf);
    expect(kept.sources[1].keep).toBe(500);
    expect(kept.sources[2]).toMatchObject({ label: "Trade Republic · Notgroschen", bank: "Trade Republic", available: 9000, keep: 1000, late: true });
    expect(kept.sources[2].rate).toBeGreaterThan(0);
  });

  it("adds the salary forecast to the free surplus and takes the savings rate of it too", () => {
    const state = contextState();
    state.payslips = Array.from({ length: 10 }, (_, index) => ({
      year: 2026 as const, month: index + 1, employer: "Musterbetrieb GmbH", monthlyPayroll: true, baseSalary: 2800,
      regularGross: 2800, regularSv: 500, regularTax: 300, specialGross: 0, netPay: 2000,
    }));
    const context = goalPlanningContext(state, calculateDashboard(state), state.settings.asOf);
    const special = context.forecast["2026-12"];
    expect(special).toBeGreaterThan(1500);
    expect(context.capacity["2026-12"]).toBe(Math.floor(2000 + special - Math.round((2000 + special) * 0.1)));
    // The Successbonus comes with the December payslip: January is almost double too.
    const bonus = context.forecast["2027-01"];
    expect(bonus).toBeGreaterThan(1500);
    expect(context.capacity["2027-01"]).toBe(Math.floor(2000 + bonus - Math.round((2000 + bonus) * 0.1)));
    expect(context.capacity["2027-02"]).toBe(1800);
    state.settings.savingsRate = 0.3;
    const saving = goalPlanningContext(state, calculateDashboard(state), state.settings.asOf);
    expect(saving.capacity["2027-02"]).toBe(1400);
    state.settings.successBonusPercent = 0;
    expect(goalPlanningContext(state, calculateDashboard(state), state.settings.asOf).forecast["2027-01"]).toBeUndefined();
  });

  it("allows every pocket except the goal's own and stores the dialog's settings within their limits", () => {
    const pocket = { id: "Sparkonto", label: "Sparkonto", kind: "pocket" as const, available: 100 };
    expect(sourceAllowed(pocket, "Kamera")).toBe(true);
    expect(sourceAllowed(pocket, "Sparen")).toBe(false);
    expect(sourceAllowed({ id: GOAL_SURPLUS, label: "Girokonto", kind: "surplus", available: 0 }, "Giro")).toBe(true);
    const settings = createSeed().settings;
    expect(withGoalSettings(settings, undefined)).toBe(settings);
    expect(withGoalSettings({ ...settings, accountKeep: { Sparkonto: 100 } }, { asapReserve: 0.9, savingsRate: 0.2, accountKeep: { Notgroschen: 3000, Giro: 50 } }))
      .toMatchObject({ asapReserve: 0.5, savingsRate: 0.2, accountKeep: { Sparkonto: 100, Notgroschen: 3000 } });
    expect(appStateSchema.shape.settings.safeParse({ ...settings, accountKeep: { Girokonto: 10 } }).success).toBe(false);
    expect(appStateSchema.shape.settings.safeParse({ ...settings, savingsRate: 0.6 }).success).toBe(false);
    expect(appStateSchema.shape.settings.safeParse({ ...settings, asapReserve: 0.15, savingsRate: 0.1, accountKeep: { Notgroschen: 6000 } }).success).toBe(true);
    expect(accountKeep(settings, "Notgroschen")).toBe(settings.emergencyTarget);
    expect(accountKeep({ ...settings, accountKeep: { notgroschen: 0 } }, "Notgroschen")).toBe(0);
    expect(accountKeep(settings, "Sparen")).toBe(0);
  });
});