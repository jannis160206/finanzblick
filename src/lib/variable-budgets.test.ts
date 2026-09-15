import { describe, expect, it } from "vitest";
import { lunchBudget } from "@/lib/holidays-at-kaernten";
import { applyVariableBudgets, monthlyVariableBudget, variableBudgetLines } from "@/lib/variable-budgets";
import { synchronizePlan, refreshPlanning } from "@/lib/planning";
import { calculateDashboard, calculatePlan, financeRowValue } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, emptyMonth, type FinanceRow } from "@/lib/types";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { commitStatementImport } from "@/lib/import/review";

describe("Carinthian lunch budgets", () => {
  it("October 2026 excludes Monday 26 October; Saturday 10 October is never a workday", () => {
    expect(lunchBudget("2026-10")).toEqual({ homeOfficeDays: 8, officeDays: 13, total: 111.5 });
    expect(lunchBudget("2026-10", [{ from: "2026-10-10", to: "2026-10-11" }, { from: "2026-10-26", to: "2026-10-26" }]).total).toBe(111.5);
  });
  it("a Wednesday public holiday removes 5.50, not a home-office rate", () => {
    // January 2027 has 21 weekdays: 9 Mon/Fri and 12 Tue/Wed/Thu.
    // New Year is Friday (-5), Epiphany Wednesday (-5.50).
    expect(lunchBudget("2027-01").total).toBe(9 * 5 + 12 * 5.5 - 5 - 5.5);
    expect(lunchBudget("2027-01")).toMatchObject({ homeOfficeDays: 8, officeDays: 11 });
  });
  it("also excludes Kärnten 10 October when it is a weekday", () => {
    expect(lunchBudget("2025-10")).toEqual({ homeOfficeDays: 8, officeDays: 14, total: 117 });
  });
  it("removes saved holiday workdays once and preserves the configured rates", () => {
    expect(lunchBudget("2026-10", [{ from: "2026-10-05", to: "2026-10-09" }])).toEqual({ homeOfficeDays: 6, officeDays: 10, total: 85 });
    expect(lunchBudget("2026-10", [{ from: "2026-10-05", to: "2026-10-09" }, { from: "2026-10-07", to: "2026-10-12" }])).toEqual({ homeOfficeDays: 5, officeDays: 10, total: 80 });
    expect(lunchBudget("2026-10", [{ from: "2026-10-01", to: "2026-10-25" }])).toEqual({ homeOfficeDays: 1, officeDays: 3, total: 21.5 });
  });
  it("handles a vacation across the year boundary in each affected month", () => {
    const ranges = [{ from: "2026-12-28", to: "2027-01-08" }];
    expect(lunchBudget("2026-12", ranges).total).toBe(lunchBudget("2026-12").total - 21.5);
    expect(lunchBudget("2027-01", ranges).total).toBe(lunchBudget("2027-01").total - 21);
  });
});

describe("strict variable budgets", () => {
  it.each([2026, 2027])("uses only the gift calendar in %s, without spreading Christmas", (year) => {
    const actual = Array.from({ length: 12 }, (_, index) => monthlyVariableBudget(`${year}-${String(index + 1).padStart(2, "0")}`).rows.find((row) => row.id === "gifts")!.total);
    expect(actual).toEqual([50, 50, 0, 50, 100, 0, 50, 50, 0, 0, 100, 1000]);
  });
  it("discards extra variable rows and future overrides without changing bank facts, historical values, income or contracts", () => {
    const state = createSeed();
    state.financeRows.push({ id: "food", kind: "variable", label: "Lebensmittel", planCategory: "Lebensmittel", values: { "2026-08": 432, "2026-09": 600 }, overrides: { "2026-08": 432, "2026-09": 900, "2027-12": 1000 } });
    for (const label of ["AMEX", "Amex-Rate", "Amex Rückzahlung", "Klarna", "Sonstiges", "Gesundheit", "Drogerie", "Shopping", "Wohnen & Haushalt"])
      state.financeRows.push({ id: label, kind: "variable", label, values: { "2026-09": 600 } });
    state.financeRows.push({ id: "duplicate-food", kind: "variable", label: "Lebensmittel & Haushalt", planCategory: "Lebensmittel", values: {} });
    state.months["2026-08"] = { ...emptyMonth(), variableOverride: 555 };
    state.months["2026-09"] = { ...emptyMonth(), variableOverride: 9999 };
    const fixed = state.financeRows.filter((row) => row.kind !== "variable");
    const result = synchronizePlan(state);
    const variables = result.financeRows.filter((row) => row.kind === "variable");
    expect(variables.map((row) => row.label)).toEqual(variableBudgetLines.map((row) => row.label));
    expect(variables.map((row) => row.values["2026-10"])).toEqual([250, 111.5, 180, 20, 250, 0, 100]);
    expect(variables[0]).toMatchObject({ id: "food", values: { "2026-08": 432 }, overrides: { "2026-08": 432 } });
    expect(result.months["2026-08"].variableOverride).toBe(555);
    expect(result.months["2026-09"].variableOverride).toBeNull();
    expect(result.financeRows.filter((row) => row.kind !== "variable")).toEqual(fixed);
    expect(result.transactions).toBe(state.transactions);
    expect(synchronizePlan(result)).toEqual(result);
  });
  it("never uses four-month averages even with an unsynchronized state or missing grid value", () => {
    const state = createSeed();
    state.transactions = ["05", "06", "07", "08"].map((month) => ({ id: month, date: `2026-${month}-05`, description: "BILLA", amount: -600, category: "Lebensmittel", categoryOverride: true, includeInPlan: true, bank: "Revolut", pocket: null }));
    state.months["2026-10"] = { ...emptyMonth(), variableOverride: 6000 };
    const average = calculatePlan(state.transactions, state.settings.asOf);
    expect(average.total).toBe(600);
    expect(calculateDashboard(state).timeline.find((row) => row.month === "2026-10")?.variablePlan).toBe(911.5);
    const row: FinanceRow = { id: "food", label: "Lebensmittel", planCategory: "Lebensmittel", kind: "variable", values: { "2026-11": 6000 } };
    expect(financeRowValue(row, "2026-10", average)).toBe(250);
    expect(financeRowValue(row, "2026-11", average)).toBe(250);
    expect(financeRowValue(row, "2026-08", average)).toBe(0);
  });
  it("keeps budgets stable across bank import, JSON load and Excel, but recomputes lunch for saved vacation dates", async () => {
    let state = synchronizePlan(createSeed());
    state.holidayRanges = [{ from: "2026-10-05", to: "2026-10-09" }];
    state = refreshPlanning(appStateSchema.parse(JSON.parse(JSON.stringify(state))), "2026-09-15");
    const imported = commitStatementImport(state, [{ id: "dm", date: "2026-09-13", description: "dm", bank: "Revolut", pocket: null, category: "Drogerie", amount: -600, includeInPlan: true }]).state;
    const loaded = refreshPlanning((await parseWorkbook(await exportWorkbook(imported))).state, "2026-09-15");
    expect(loaded.financeRows.filter((row) => row.kind === "variable")).toEqual(state.financeRows.filter((row) => row.kind === "variable"));
    expect(calculateDashboard(loaded).timeline.find((row) => row.month === "2026-10")?.variablePlan).toBe(885);
    expect(applyVariableBudgets(loaded).holidayRanges).toEqual(state.holidayRanges);
  });
  it("restores only affected lunch budgets after vacation deletion, including after reload", () => {
    const baseline = synchronizePlan(createSeed());
    const vacation = synchronizePlan({ ...baseline, holidayRanges: [{ from: "2026-10-05", to: "2026-10-09" }] });
    const otherRows = (state: typeof baseline) => state.financeRows.filter((row) => row.planCategory !== "Mittagessen");
    expect(otherRows(vacation)).toEqual(otherRows(baseline));
    expect(vacation.financeRows.find((row) => row.planCategory === "Mittagessen")?.values["2026-10"]).toBe(85);
    const restored = refreshPlanning(appStateSchema.parse(JSON.parse(JSON.stringify({ ...vacation, holidayRanges: [] }))), "2026-09-15");
    expect(restored.financeRows).toEqual(baseline.financeRows);
    expect(calculateDashboard(restored).timeline.find((row) => row.month === "2026-10")?.variablePlan).toBe(911.5);
    expect(restored.transactions).toEqual(baseline.transactions);
  });
});
