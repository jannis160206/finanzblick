import { describe, expect, it } from "vitest";
import { applyBudgetCorrections, budgetCorrections, correctionDelta, groupCorrections, salaryRows } from "./budget-corrections";
import { salaryForecast, type SalaryForecast, type SalaryForecastMonth } from "./salary-forecast";
import { createSeed } from "./seed";
import type { AppState, FinanceRow } from "./types";

const value = (amount: number, reason = "Test") => ({ amount, reason });
const month = (key: string, parts: Partial<Record<"salary" | "onCall" | "overtime" | "holidayWork" | "special", number>> = {}): SalaryForecastMonth => {
  const salary = value(parts.salary ?? 2500, "laufendes Netto");
  const onCall = value(parts.onCall ?? 0, "Ø 12 Monate");
  const overtime = value(parts.overtime ?? 0, "Ø 12 Monate");
  const holidayWork = value(parts.holidayWork ?? 0, "Ø 12 Monate");
  const special = value(parts.special ?? 0, parts.special ? "wie Dez. 2025" : "keine Sonderzahlung im Modell");
  return { month: key, salary, onCall, overtime, holidayWork, special, total: salary.amount + onCall.amount + overtime.amount + holidayWork.amount + special.amount };
};
const forecast = (months: SalaryForecastMonth[], paid: string[] = []): SalaryForecast => ({
  history: paid.map((key) => ({ month: key, source: "payslip", salary: 2500, onCall: 0, overtime: 0, holidayWork: 0, special: 0,
    known: { onCall: true, overtime: true, holidayWork: true } })),
  actualThrough: paid.at(-1), months,
});

function state(rows: FinanceRow[]): AppState {
  const result = createSeed();
  result.settings = { ...result.settings, asOf: "2026-11-10", baselineDate: "2026-11-01" };
  result.financeRows = rows;
  return result;
}
const income = (id: string, label: string, values: Record<string, number> = {}): FinanceRow => ({ id, label, kind: "income", values });

describe("budget corrections", () => {
  it("finds the income rows like the payslip import, plus overtime and other income", () => {
    const rows = salaryRows([
      income("a", "Nettogehalt"), income("b", "Rufbereitschaft"), income("c", "Feiertagsarbeit"), income("d", "Sonderzahlungen"),
      income("e", "Überstunden"), income("f", "Weitere Einnahmen"), income("g", "Sonstiges"), { id: "x", label: "Gehalt", kind: "fixed", values: {} },
    ]);
    expect(rows.salary?.id).toBe("a");
    expect(rows.onCall?.id).toBe("b");
    expect(rows.holidayWork?.id).toBe("c");
    expect(rows.special?.id).toBe("d");
    expect(rows.overtime?.id).toBe("e");
    expect(rows.other.map((row) => row.id)).toEqual(["f", "g"]);
  });

  it("proposes forecast values for future months, creates missing rows and leaves equal values alone", () => {
    const current = state([
      income("income-salary", "Gehalt", { "2026-12": 2500, "2027-01": 2400 }),
      income("income-oncall", "Rufbereitschaft", { "2026-12": 150 }),
      income("income-other", "Weitere Einnahmen"),
    ]);
    const items = budgetCorrections(current, forecast([
      month("2026-12", { onCall: 214, overtime: 71, special: 2300 }), month("2027-01", { onCall: 214, overtime: 71 }),
    ]));
    expect(items.map((item) => [item.rowId, item.month, item.from, item.to, item.create ?? false])).toEqual([
      ["income-salary", "2027-01", 2400, 2500, false],
      ["income-oncall", "2026-12", 150, 214, false],
      ["income-oncall", "2027-01", 0, 214, false],
      ["income-overtime", "2026-12", 0, 71, true],
      ["income-overtime", "2027-01", 0, 71, true],
      ["income-special-payments", "2026-12", 0, 2300, true],
    ]);
    expect(items.find((item) => item.rowId === "income-overtime")).toMatchObject({ label: "Überstunden", kind: "overtime", reason: "Ø 12 Monate" });
    expect(groupCorrections(items).map((group) => [group.label, group.items.length, group.create])).toEqual([
      ["Gehalt", 1, false], ["Rufbereitschaft", 2, false], ["Überstunden", 2, true], ["Sonderzahlungen", 1, true],
    ]);
    expect(correctionDelta(items)).toEqual({ "2026-12": 64 + 71 + 2300, "2027-01": 100 + 214 + 71 });
  });

  it("puts on-call pay into the salary row when there is no on-call row, like the payslip import", () => {
    const items = budgetCorrections(state([income("income-salary", "Gehalt")]), forecast([month("2026-12", { onCall: 214 })]));
    expect(items).toEqual([expect.objectContaining({ rowId: "income-salary", to: 2714, reason: expect.stringMatching(/^laufendes Netto · inkl\. Rufbereitschaft 214,00\s€$/) })]);
  });

  it("proposes to clear a special payment that also stands in other income (±10 %)", () => {
    const current = state([
      income("income-salary", "Gehalt", { "2026-12": 2500, "2027-01": 2500, "2027-07": 2500 }),
      income("income-special", "Sonderzahlungen", { "2026-11": 2400 }),
      income("income-other", "Sonstiges", { "2026-11": 2300, "2026-12": 2250, "2027-01": 300, "2027-07": 1800 }),
    ]);
    const items = budgetCorrections(current, forecast([month("2026-12", { special: 2400 }), month("2027-01"), month("2027-07", { special: 2400 })], ["2026-11"]));
    const duplicates = items.filter((item) => item.kind === "duplicate");
    expect(duplicates.map((item) => [item.month, item.from, item.to])).toEqual([["2026-11", 2300, 0], ["2026-12", 2250, 0]]);
    expect(duplicates[0]).toMatchObject({ rowId: "income-other", label: "Sonstiges", reason: expect.stringMatching(/^doppelt zur Sonderzahlung 2\.400,00\s€$/) });
  });

  it("keeps overtime that a payslip wrote into a paid month", () => {
    const current = state([income("income-salary", "Gehalt", { "2026-11": 2600 }), income("income-overtime", "Überstunden", { "2026-11": 71, "2026-12": 71 })]);
    const items = budgetCorrections(current, forecast([month("2026-12", { overtime: 71 })], ["2026-11"]));
    expect(items.filter((item) => item.rowId === "income-overtime")).toEqual([]);
  });

  it("applies only the confirmed items, creates rows and skips values changed in the meantime", () => {
    const current = state([income("income-salary", "Gehalt", { "2026-12": 2400 }), income("income-other", "Weitere Einnahmen"),
      { id: "rent", label: "Miete", kind: "fixed", values: {} }]);
    const items = budgetCorrections(current, forecast([month("2026-12", { overtime: 71, special: 2300 }), month("2027-01")]));
    const chosen = items.filter((item) => item.month === "2026-12");
    const { state: next, applied } = applyBudgetCorrections(current, chosen);
    expect(applied).toBe(3);
    expect(next.financeRows.map((row) => row.id)).toEqual(["income-salary", "income-other", "income-overtime", "income-special-payments", "rent"]);
    expect(next.financeRows[0].values).toEqual({ "2026-12": 2500 });
    expect(next.financeRows[3]).toMatchObject({ label: "Sonderzahlungen", kind: "income", values: { "2026-12": 2300 } });
    const changed = { ...current, financeRows: current.financeRows.map((row) => row.id === "income-salary" ? { ...row, values: { "2026-12": 2450 } } : row) };
    expect(applyBudgetCorrections(changed, items.filter((item) => item.rowId === "income-salary")).applied).toBe(1);
    expect(applyBudgetCorrections(current, []).state).toBe(current);
  });

  it("uses the salary forecast of the state by default", () => {
    const current = state([income("income-salary", "Gehalt")]);
    current.payslips = [{ year: 2026, month: 10, employer: "Musterbetrieb GmbH", monthlyPayroll: true, regularGross: 3000, specialGross: 0, netPay: 2100 }];
    expect(budgetCorrections(current)).toEqual(budgetCorrections(current, salaryForecast(current)));
    expect(budgetCorrections(current)[0]).toMatchObject({ rowId: "income-salary", month: "2026-12", from: 0, to: 2100 });
  });
});
