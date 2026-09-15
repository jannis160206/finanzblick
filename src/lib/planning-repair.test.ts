import { describe, expect, it } from "vitest";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { repairKnownPlanningOverrides } from "@/lib/legacy-source";
import { refreshPlanning } from "@/lib/planning";
import { createSeed } from "@/lib/seed";
import { type FinanceRow } from "@/lib/types";

function staleState() {
  const state = createSeed();
  state.settings.asOf = "2026-09-12";
  state.transactions = ["05", "06", "07", "08"].map((month) => ({
    id: month,
    date: `2026-${month}-03`,
    description: "Anderer Einkauf",
    bank: "Raiffeisen",
    pocket: null,
    amount: -100,
    category: "Sonstiges",
    includeInPlan: true,
  }));
  state.financeRows.push({
    id: "auto-Sonstiges",
    label: "Sonstiges",
    kind: "variable",
    planCategory: "Sonstiges",
    values: { "2026-08": 80, "2026-09": 2027.75, "2026-10": 123 },
    overrides: { "2026-09": 2027.75, "2026-10": 123 },
  });
  return state;
}
const other = (state: ReturnType<typeof staleState>) =>
  state.financeRows.find((row) => row.id === "auto-Sonstiges")!;

describe("known September focus override repair", () => {
  it("clears only the confirmed stale September value and preserves every other input", () => {
    const state = staleState();
    const repaired = repairKnownPlanningOverrides(state);
    expect(other(repaired).overrides).toEqual({
      "2026-09": null,
      "2026-10": 123,
    });
    expect(other(repaired).values).toEqual({
      "2026-08": 80,
      "2026-09": 100,
      "2026-10": 123,
    });
    expect(repaired.transactions).toBe(state.transactions);
    expect(repaired.settings).toBe(state.settings);
    expect(repaired.months).toBe(state.months);
    expect(
      repaired.financeRows.filter((row) => row.id !== "auto-Sonstiges"),
    ).toEqual(state.financeRows.filter((row) => row.id !== "auto-Sonstiges"));
    expect(other(state).overrides?.["2026-09"]).toBe(2027.75);
    expect(repairKnownPlanningOverrides(repaired)).toBe(repaired);
  });
  it("does not clear other amounts, mismatched values, other categories or manually created rows", () => {
    for (const patch of [
      { id: "manual-Sonstiges" },
      { kind: "fixed" },
      { planCategory: "Shopping" },
      { overrides: { "2026-09": 2000 } },
      { values: { "2026-09": 900 } },
      { overrides: { "2026-10": 2027.75 } },
    ] as Partial<FinanceRow>[]) {
      const state = staleState();
      state.financeRows = [{ ...other(state), ...patch }];
      expect(repairKnownPlanningOverrides(state).financeRows).toEqual(
        state.financeRows,
      );
    }
  });
  it("removes obsolete Sonstiges even with deliberate overrides and through Excel", async () => {
    const repaired = refreshPlanning(staleState(), "2026-09-12");
    expect(other(repaired)).toBeUndefined();
    repaired.financeRows.push(other(staleState()));
    const edited = refreshPlanning(repaired, "2026-09-12");
    expect(other(edited)).toBeUndefined();
    const restored = (await parseWorkbook(await exportWorkbook(edited))).state;
    expect(restored.planningRepairs).toEqual(edited.planningRepairs);
    expect(
      other(refreshPlanning(restored, "2026-09-12")),
    ).toBeUndefined();
  });
  it("never resurrects a removed variable category on a later refresh", () => {
    const checked = refreshPlanning(createSeed(), "2026-09-12");
    checked.financeRows.push(other(staleState()));
    expect(
      other(refreshPlanning(checked, "2026-09-12")),
    ).toBeUndefined();
  });
  it("repairs historical September using September's plan rather than the later month's plan", () => {
    const state = staleState();
    state.transactions.push({
      id: "sep",
      date: "2026-09-03",
      description: "Anderer Einkauf",
      bank: "Raiffeisen",
      pocket: null,
      amount: -200,
      category: "Sonstiges",
      includeInPlan: true,
    });
    const refreshed = repairKnownPlanningOverrides({ ...state, settings: { ...state.settings, asOf: "2026-10-12" } });
    expect(other(refreshed).values["2026-09"]).toBe(300);
    expect(other(refreshed).overrides?.["2026-10"]).toBe(123);
  });
});
