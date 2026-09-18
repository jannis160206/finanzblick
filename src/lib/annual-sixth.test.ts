import { describe, expect, it } from "vitest";
import { calculateAnnualSixth } from "@/lib/annual-sixth";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { createSeed } from "@/lib/seed";
import { annualSixthSchema, appStateSchema, type AnnualSixth } from "@/lib/types";

const entry: AnnualSixth = {
  year: 2026, month: 9, employer: "Testbetrieb", regularGross: 27000, specialGross: 3000,
  plannedSpecialGross: 3500, monthlyPayroll: true,
};

describe("Austrian annual sixth orientation", () => {
  it("annualizes only ongoing gross pay and compares gross special payments", () => {
    expect(calculateAnnualSixth(entry)).toMatchObject({
      source: "estimated", sixth: 6000, remaining: 3000, overhang: 0,
      plannedRemaining: 0, plannedOverhang: 500,
    });
    expect(calculateAnnualSixth({ ...entry, specialGross: 7000 }).sixth).toBe(6000);
    expect(calculateAnnualSixth({ ...entry, specialGross: 7000 }).overhang).toBe(1000);
  });

  it("uses the reported payroll sixth instead of guessing for a partial-year employment", () => {
    expect(calculateAnnualSixth({ ...entry, monthlyPayroll: false, reportedSixth: 2500 })).toMatchObject({
      source: "reported", sixth: 2500, remaining: 0, overhang: 500,
    });
    expect(calculateAnnualSixth({ ...entry, reportedSixth: 0 }).sixth).toBe(0);
    expect(() => calculateAnnualSixth({ ...entry, monthlyPayroll: false })).toThrow();
    expect(() => calculateAnnualSixth({ ...entry, regularGross: 0 })).toThrow("vor dem ersten laufenden Bezug");
    expect(calculateAnnualSixth({ ...entry, regularGross: 0, reportedSixth: 6000 }).sixth).toBe(6000);
  });

  it("counts calendar months before a mid-year hire and matches the published WKO example", () => {
    expect(calculateAnnualSixth({ ...entry, regularGross: 9000 }).sixth).toBe(2000);
    expect(calculateAnnualSixth({ ...entry, month: 11, regularGross: 27800, specialGross: 5300 })).toMatchObject({
      sixth: 5054.55, overhang: 245.45,
    });
    expect(calculateAnnualSixth({ ...entry, month: 12, regularGross: 30600, specialGross: 5300 })).toMatchObject({
      sixth: 5100, controlSixth: 5100, overhang: 200,
    });
  });

  it("uses verified annual thresholds without turning the gross ceiling into a net tax estimate", () => {
    expect(calculateAnnualSixth({ ...entry, reportedSixth: 2615 })).toMatchObject({ freeLimit: 2615, withinFreeLimit: true });
    expect(calculateAnnualSixth({ ...entry, reportedSixth: 2615.01 }).withinFreeLimit).toBe(false);
    expect(calculateAnnualSixth({ ...entry, year: 2027, reportedSixth: 2675 })).toMatchObject({ freeLimit: 2675, withinFreeLimit: true });
    expect(calculateAnnualSixth(entry).taxNote).toContain("620");
    expect(calculateAnnualSixth(entry)).not.toHaveProperty("tax");
  });

  it("handles exact exhaustion, zero values, cents and the year-end control calculation", () => {
    expect(calculateAnnualSixth({ ...entry, specialGross: 6000, plannedSpecialGross: 0 })).toMatchObject({
      remaining: 0, overhang: 0, plannedRemaining: 0, plannedOverhang: 0,
    });
    expect(calculateAnnualSixth({ ...entry, regularGross: 0, specialGross: 0, plannedSpecialGross: 0 })).toMatchObject({
      sixth: 0, remaining: 0, overhang: 0,
    });
    expect(calculateAnnualSixth({ ...entry, month: 3, regularGross: 10000.01 }).sixth).toBe(6666.67);
    expect(calculateAnnualSixth(entry).controlSixth).toBeUndefined();
    expect(calculateAnnualSixth({ ...entry, month: 12, regularGross: 36000, reportedSixth: 6500 })).toMatchObject({
      sixth: 6500, controlSixth: 6000,
    });
  });

  it.each([
    { month: 0 }, { month: 13 }, { month: 1.5 }, { year: 2025 },
    { regularGross: -1 }, { specialGross: -1 }, { plannedSpecialGross: -1 },
    { regularGross: NaN }, { regularGross: Infinity }, { reportedSixth: -1 }, { regularGross: 1.001 },
  ])("rejects invalid payroll inputs %j", (invalid) => {
    expect(annualSixthSchema.safeParse({ ...entry, ...invalid }).success).toBe(false);
  });

  it("persists optional annual inputs and explicit category intent through JSON and Excel", async () => {
    const initial = createSeed();
    expect(appStateSchema.parse(initial).annualSixth).toBeUndefined();
    const state = { ...initial, annualSixth: [entry], transactions: [
      { id: "manual-amazon", date: "2026-09-10", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
        description: "Amazon", rawDescription: "AMAZON Originaltext", rawDetails: ["Original-Zusatz"],
        category: "Lebensmittel" as const, amount: -50, includeInPlan: true,
        manualCategory: true, categoryOverride: true, reviewed: true },
    ] };
    for (const restored of [
      appStateSchema.parse(JSON.parse(JSON.stringify(state))),
      (await parseWorkbook(await exportWorkbook(state))).state,
    ]) {
      expect(restored.annualSixth).toEqual([entry]);
      expect(restored.transactions).toEqual(state.transactions);
      expect(calculateAnnualSixth(restored.annualSixth![0])).toEqual(calculateAnnualSixth(entry));
    }
    expect(appStateSchema.safeParse({ ...state, annualSixth: [entry, entry] }).success).toBe(false);
  });
});
