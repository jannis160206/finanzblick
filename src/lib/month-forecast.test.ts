import { describe, expect, it } from "vitest";
import { calculateDashboard } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { monthEndForecast } from "./month-forecast";

let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"], bank = "Raiffeisen"): Transaction => ({
  id: `m${++counter}`, date, bank, pocket: bank === "Amex" ? "Amex" : "Girokonto", description, amount, category, includeInPlan: true,
});
const salaryHistory = ["06", "07", "08"].map((month) => row(`2026-${month}-25`, "Arbeitgeber GmbH Gehalt", 2400, "Gehalt"));

function stateWith(today: string, transactions: Transaction[], extra: Partial<AppState> = {}): AppState {
  const seed = createSeed();
  return appStateSchema.parse({
    ...seed, settings: { ...seed.settings, asOf: today, baselineDate: "2026-09-01" }, transactions,
    financeRows: seed.financeRows.map((item) => item.id === "income-salary" ? { ...item, values: { ...item.values, "2026-09": 2400, "2026-10": 2400 } } : item),
    merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [], ignoredStatementKeys: [], pocketSnapshots: [],
    accountSnapshots: [{ bank: "Raiffeisen", name: "Girokonto", date: today, balance: 1500 }],
    reviewQueue: [], holidayRanges: [], ...extra,
  });
}
const forecast = (state: AppState) => monthEndForecast(state, calculateDashboard(state), state.settings.asOf);
const ok = (state: AppState) => {
  const result = forecast(state);
  if (result.status !== "ok") throw new Error("expected a forecast");
  return result;
};

describe("month-end forecast", () => {
  it("refuses to invent a balance when no giro balance is known", () => {
    const state = stateWith("2026-09-10", salaryHistory, { accountSnapshots: [] });
    expect(forecast(state)).toEqual({ status: "unknown", month: "2026-09", monthEnd: "2026-09-30" });
  });

  it("adds up start, income and outflows consistently and walks every remaining day", () => {
    const result = ok(stateWith("2026-09-10", salaryHistory));
    expect(result.daysLeft).toBe(21);
    expect(result.points).toHaveLength(21);
    expect(result.points.at(-1)).toMatchObject({ date: "2026-09-30", balance: result.endBalance, committed: result.endCommitted });
    const flows = result.income - result.fixed - result.contracts - result.amex - result.transfers - result.planned;
    expect(result.endCommitted).toBeCloseTo(result.start + flows, 1);
    expect(result.endBalance).toBeCloseTo(result.endCommitted - result.spending, 1);
    expect(result.free).toBeCloseTo(result.lowestCommitted.balance - result.buffer, 2);
    expect(result.reserve).toBeCloseTo(result.endCommitted - result.lowestCommitted.balance, 2);
    expect(result.perDay).toBeCloseTo(Math.max(0, result.free) / 21, 2);
    expect(result.source).toEqual({ kind: "snapshot", date: "2026-09-10" });
  });

  it("expects the salary only while it has not arrived this month", () => {
    const pending = ok(stateWith("2026-09-10", salaryHistory));
    expect(pending.events.filter((event) => event.kind === "salary").map((event) => event.date)).toEqual(["2026-09-25"]);
    expect(pending.income).toBeGreaterThan(0);
    const paid = ok(stateWith("2026-09-28", [...salaryHistory, row("2026-09-25", "Arbeitgeber GmbH Gehalt", 2400, "Gehalt")]));
    expect(paid.events.some((event) => event.kind === "salary")).toBe(false);
    expect(paid.daysLeft).toBe(3);
  });

  it("charges each recurring payment once and skips ignored, fixed-cost and Amex contracts", () => {
    const flix = ["05", "06", "07", "08"].map((month) => row(`2026-${month}-15`, "Streamflix Abo", -12.99, "Abonnements"));
    const card = ["05", "06", "07", "08"].map((month) => row(`2026-${month}-18`, "Musicbox Premium", -9.99, "Abonnements", "Amex"));
    const gym = ["05", "06", "07", "08"].map((month) => row(`2026-${month}-20`, "Fitbox Studio", -29.9, "Sport & Fitness"));
    const state = stateWith("2026-09-10", [...salaryHistory, ...flix, ...card, ...gym], {
      contracts: [
        { id: "fitbox", status: "ignored", updatedAt: 1 },
        { id: "manual:kfz", manual: true, status: "confirmed", name: "Kfz-Versicherung", amount: 380, interval: "yearly", nextDate: "2026-09-28", category: "Versicherungen", updatedAt: 1 },
      ],
    });
    const result = ok(state);
    const contractEvents = result.events.filter((event) => event.kind === "subscription");
    expect(contractEvents.map((event) => [event.label, event.date, event.amount])).toEqual([
      ["Streamflix Abo", "2026-09-15", -12.99],
      ["Kfz-Versicherung", "2026-09-28", -380],
    ]);
    expect(result.contracts).toBeCloseTo(392.99, 2);
  });

  it("stops charging a contract after its cancellation date", () => {
    const flix = ["05", "06", "07", "08"].map((month) => row(`2026-${month}-15`, "Streamflix Abo", -12.99, "Abonnements"));
    const state = stateWith("2026-09-10", [...salaryHistory, ...flix], {
      contracts: [{ id: "streamflix", status: "cancelled", cancelledAt: "2026-09-01", updatedAt: 1 }],
    });
    expect(ok(state).events.some((event) => event.label === "Streamflix Abo")).toBe(false);
  });

  it("covers a single remaining day at month end", () => {
    const result = ok(stateWith("2026-09-30", salaryHistory));
    expect(result.daysLeft).toBe(1);
    expect(result.points.map((point) => point.date)).toEqual(["2026-09-30"]);
  });

  it("keeps the buffer and reports an overdrawn month as negative", () => {
    const buffered = ok(stateWith("2026-09-10", salaryHistory, {
      assistantMemory: [{ id: "a1", text: "Puffer 300 €", key: "buffer", value: 300, at: 1 }],
    }));
    expect(buffered.buffer).toBe(300);
    expect(buffered.free).toBeCloseTo(buffered.lowestCommitted.balance - 300, 2);
    const negative = ok(stateWith("2026-09-26", salaryHistory, {
      accountSnapshots: [{ bank: "Raiffeisen", name: "Girokonto", date: "2026-09-26", balance: -250 }],
    }));
    expect(negative.free).toBeLessThan(0);
    expect(negative.tone).toBe("negative");
    expect(negative.perDay).toBe(0);
  });
});
