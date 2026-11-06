import { describe, expect, it } from "vitest";
import { buildSplits, categoryParts, validSplits } from "./splits";
import { calculateDashboard } from "./calc";
import { summarizeMonth } from "./insights";
import { createEmptyAccountState } from "./account-state";
import { transactionSchema, type Transaction } from "./types";

const booking = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: "t1", date: "2026-09-10", bank: "Raiffeisen", pocket: null, description: "BILLA DANKT 1234",
  amount: -54.3, category: "Lebensmittel", includeInPlan: true, ...overrides,
});

describe("buildSplits", () => {
  it("scales receipt totals to the booking and keeps the sum exact", () => {
    const plan = buildSplits([
      { category: "Lebensmittel", amount: 40.01 },
      { category: "Drogerie", amount: 10.02 },
      { category: "Haustiere", amount: 4.27 },
    ], -54.3);
    expect(plan.splits.map((part) => part.category)).toEqual(["Lebensmittel", "Drogerie", "Haustiere"]);
    expect(plan.splits.reduce((sum, part) => sum + Math.round(part.amount * 100), 0)).toBe(-5430);
    expect(plan.difference).toBe(0);
  });

  it("reports a difference and still sums to the booking", () => {
    const plan = buildSplits([{ category: "Lebensmittel", amount: 10 }, { category: "Drogerie", amount: 10 }], -20.01);
    expect(plan.difference).toBe(0.01);
    expect(plan.splits.map((part) => part.amount)).toEqual([-10.01, -10]);
  });

  it("folds negative category leftovers into the largest category", () => {
    const plan = buildSplits([
      { category: "Lebensmittel", amount: 12 }, { category: "Drogerie", amount: 3 }, { category: "Wohnen & Haushalt", amount: -1 },
    ], -14);
    expect(plan.splits).toEqual([{ category: "Lebensmittel", amount: -11 }, { category: "Drogerie", amount: -3 }]);
  });

  it("splits by thirds with largest remainder", () => {
    const plan = buildSplits([
      { category: "Lebensmittel", amount: 1 }, { category: "Drogerie", amount: 1 }, { category: "Haustiere", amount: 1 },
    ], -10);
    expect(plan.splits.map((part) => part.amount)).toEqual([-3.34, -3.33, -3.33]);
  });
});

describe("categoryParts", () => {
  it("uses valid splits and falls back otherwise", () => {
    const split = booking({ splits: [{ category: "Lebensmittel", amount: -40 }, { category: "Drogerie", amount: -14.3 }] });
    expect(categoryParts(split, "Lebensmittel")).toEqual([
      { category: "Lebensmittel", amount: -40, share: 40 / 54.3 },
      { category: "Drogerie", amount: -14.3, share: 14.3 / 54.3 },
    ]);
    const broken = booking({ splits: [{ category: "Lebensmittel", amount: -40 }, { category: "Drogerie", amount: -14 }] });
    expect(validSplits(broken)).toBe(false);
    expect(categoryParts(broken, "Lebensmittel")).toEqual([{ category: "Lebensmittel", amount: -54.3, share: 1 }]);
    const wrongSign = booking({ splits: [{ category: "Lebensmittel", amount: -60 }, { category: "Drogerie", amount: 5.7 }] });
    expect(validSplits(wrongSign)).toBe(false);
  });

  it("validates the schema bounds", () => {
    expect(transactionSchema.safeParse(booking({ splits: [{ category: "Lebensmittel", amount: -54.3 }] })).success).toBe(false);
    expect(transactionSchema.safeParse(booking({ splits: [{ category: "Lebensmittel", amount: -40 }, { category: "Drogerie", amount: -14.3, note: "Zahnpasta" }] })).success).toBe(true);
  });
});

describe("splits in totals", () => {
  const state = () => {
    const base = createEmptyAccountState();
    return {
      ...base,
      settings: { ...base.settings, asOf: "2026-09-20" },
      transactions: [booking({ splits: [{ category: "Lebensmittel", amount: -40 }, { category: "Drogerie", amount: -14.3 }] })],
    };
  };

  it("dashboard category spending uses the parts", () => {
    const spending = calculateDashboard(state()).spending;
    expect(spending).toEqual(expect.arrayContaining([{ name: "Lebensmittel", value: 40 }, { name: "Drogerie", value: 14.3 }]));
  });

  it("monthly summary uses the parts", () => {
    const summary = summarizeMonth(state(), "2026-09");
    expect(summary.spending).toBe(54.3);
    expect(summary.topCategories).toEqual([{ category: "Lebensmittel", amount: 40 }, { category: "Drogerie", amount: 14.3 }]);
  });
});
