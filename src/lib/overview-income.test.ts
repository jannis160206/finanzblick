import { describe, expect, it } from "vitest";
import { actualBookings, calculateDashboard } from "./calc";
import { createSeed } from "./seed";
import { reconcilePayrollSources } from "./payroll";
import { exportWorkbook, parseWorkbook } from "./excel";
import { appStateSchema, type Transaction } from "./types";
import { commitStatementImport, prepareStatementImport } from "./import/review";
import { statementFingerprint } from "./import/identity";
import type { StatementResult } from "./import/statements";

const salary: Transaction = {
  id: "xlsx-150", date: "2026-08-27", bank: "Raiffeisen", pocket: null,
  description: "TTS TeamTalentSolutions GmbH – Gehalt 8/2026", sourceCategory: "Gehalt",
  category: "Gehalt", amount: 2576.43, includeInPlan: false,
};
const onCall: Transaction = { ...salary, id: "xlsx-49", date: "2026-09-07", amount: 241.83,
  category: "Rufbereitschaft", sourceCategory: "Rufbereitschaft" };
const statement = (row: Transaction, reference = `bank-${row.id}`): Transaction => ({
  ...row, id: reference, pocket: "Raiffeisen Giro", bankReference: reference,
  description: "Auftraggeber: TTS TeamTalentSolutions GmbH Verwendungszweck: Gehalt 8/2026",
});
function stateFor() {
  const state = createSeed();
  state.settings.asOf = "2026-09-15";
  state.transactions = [salary, onCall];
  state.financeRows = [
    { id: "salary", label: "Nettogehalt", kind: "income", values: { "2026-09": 2576.43 } },
    { id: "on-call", label: "Rufbereitschaft", kind: "income", values: { "2026-09": 241.83 } },
  ];
  return state;
}

describe("overview salary accounting", () => {
  it("counts the workbook and bank receipts once, without adding on-call pay to the salary tile", () => {
    const state = stateFor();
    state.fixedReceipts = [salary, onCall].map((row) => {
      const booking = statement(row);
      return { key: statementFingerprint(booking), date: booking.date, amount: booking.amount, category: booking.category, booking };
    });
    const original = JSON.stringify(state);
    expect(actualBookings(state)).toHaveLength(2);
    expect(calculateDashboard(state).current).toMatchObject({
      income: 2818.26, received: 2818.26, salaryPlan: 2576.43, salaryReceived: 2576.43,
    });
    expect(JSON.stringify(state)).toBe(original);
  });

  it("excludes August salary, future September payroll, bonuses, 13th salary, on-call and other employers", () => {
    const state = stateFor();
    state.transactions.push(
      { ...salary, id: "august", date: "2026-07-28", description: "TTS TeamTalentSolutions Gehalt 7/2026" },
      { ...salary, id: "october", date: "2026-09-28", description: "TTS TeamTalentSolutions Gehalt 9/2026" },
      ...["Bonus", "13. Gehalt", "Rufbereitschaft"].map((label) => ({ ...salary, id: label, date: "2026-09-10", description: `TTS TeamTalentSolutions ${label}`, sourceCategory: label, amount: 900 })),
      { ...salary, id: "other", date: "2026-09-10", description: "Anderer Arbeitgeber Gehalt", amount: 1800 },
    );
    // September payroll on the 28th belongs to October even after it arrives.
    state.settings.asOf = "2026-09-30";
    const dashboard = calculateDashboard(state);
    expect(dashboard.current).toMatchObject({ salaryPlan: 2576.43, salaryReceived: 2576.43 });
    expect(dashboard.timeline.find((row) => row.month === "2026-10")?.salaryReceived).toBe(2576.43);
    expect(calculateDashboard({ ...state, settings: { ...state.settings, asOf: "2026-08-26" } }).current.salaryReceived).toBe(2576.43);
  });

  it("preserves distinct installments, dates, periods, banks and unmatched legacy rows", () => {
    const first = statement(salary, "first-reference");
    const second = statement(salary, "second-reference");
    expect(reconcilePayrollSources([salary, first, second])).toEqual([first, second]);
    const extra = { ...salary, id: "xlsx-151" };
    expect(reconcilePayrollSources([salary, extra, first])).toEqual([extra, first]);
    for (const change of [{ date: "2026-08-28" }, { bank: "Other bank" }, { amount: 2576.44 }, { description: "TTS TeamTalentSolutions Gehalt 7/2026" }])
      expect(reconcilePayrollSources([salary, { ...first, ...change }])).toHaveLength(2);
    expect(reconcilePayrollSources([salary, onCall])).toEqual([salary, onCall]);
  });

  it("does not double salary after import, reimport, JSON or Excel restoration", async () => {
    let state = stateFor();
    const source: StatementResult = { rows: [statement(salary), statement(onCall)], source: "Raiffeisen", file: "salary.csv", skipped: 0, issues: [] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = prepareStatementImport([source], state);
      expect(prepared.review).toEqual([]);
      state = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
      expect(actualBookings(state)).toHaveLength(2);
      expect(calculateDashboard(state).current.salaryReceived).toBe(2576.43);
    }
    const json = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    const restored = (await parseWorkbook(await exportWorkbook(json))).state;
    expect(calculateDashboard(restored).current).toMatchObject({ received: 2818.26, salaryPlan: 2576.43, salaryReceived: 2576.43 });
    expect(restored.transactions).toEqual(state.transactions);
  });
});
