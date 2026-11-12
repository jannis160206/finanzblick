import { describe, expect, it } from "vitest";
import {
  actualPockets,
  bikeCountdown,
  calculateDashboard,
  calculatePlan,
  classify,
  monthlyInterest,
  splitSurplus,
} from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { type Transaction } from "@/lib/types";

const transaction = (
  description: string,
  amount = -20,
  date = "2026-09-01",
): Transaction => ({
  id: `${description}-${date}-${amount}`,
  date,
  description,
  amount,
  bank: "Bank",
  pocket: null,
  category: "Sonstiges",
  includeInPlan: true,
});

describe("merchant classification", () => {
  it("routes round-ups strictly below two euros to savings", () => {
    expect(classify(transaction("Auszahlung bei Pocket", -1.99))).toMatchObject(
      {
        pocket: "Sparkonto",
        isRoundUp: true,
        includeInPlan: false,
        isTransfer: true,
      },
    );
    expect(classify(transaction("Auszahlung bei Pocket", -2)).isRoundUp).toBe(
      false,
    );
  });
  it.each(["BIPA", "Hotspot", "Mensa"])("classifies %s as lunch", (name) =>
    expect(classify({ ...transaction(name), time: "12:00:00" }).category).toBe("Mittagessen"),
  );
  it.each(["BILLA", "SPAR", "INTERSPAR"])(
    "handles the inclusive ten-euro threshold for %s",
    (name) => {
      expect(classify({ ...transaction(name, -10), time: "12:00:00" }).category).toBe("Mittagessen");
      expect(classify(transaction(name, -10.01)).category).toBe("Lebensmittel");
    },
  );
  it.each([["dm", "Drogerie"], ["Burger", "Restaurants"], ["Foodora", "Lieferdienste"], ["Pizzeria", "Restaurants"], ["Sakura", "Restaurants"], ["Gams", "Cafés & Snacks"]])(
    "classifies %s by spending purpose",
    (name, category) => expect(classify(transaction(name)).category).toBe(category),
  );
  it("keeps Amazon and AMZ as extra expenses without synthetic savings movements", () => {
    for (const name of ["Amazon", "AMZ Marketplace"])
      expect(classify(transaction(name))).toMatchObject({
        pocket: null,
        isTransfer: false,
        includeInPlan: false,
      });
  });
  it("only maps exactly twenty-euro ATM withdrawals to barber", () => {
    expect(classify(transaction("ATM", -20)).category).toBe("Körperpflege");
    expect(classify(transaction("ATM", -20.01)).category).toBe("Prüfen");
  });
  it.each([
    "Eventim",
    "Magazin Salzburg",
    "Salzburger Verkehr",
    "Sky Chefs",
    "Roof Burger",
    "Filomena",
    "Urlaub",
    "Führerschein",
  ])("excludes %s from the plan", (name) =>
    expect(classify(transaction(name)).includeInPlan).toBe(false),
  );
});

describe("weighted plan", () => {
  it("uses four completed months and adds the weighted current month", () => {
    const rows = ["05", "06", "07", "08", "09"].map((month) =>
      transaction("Mensa", -100, `2026-${month}-${month === "05" ? "04" : month === "08" ? "03" : "01"}`),
    );
    const result = calculatePlan(rows, "2026-09-11");
    expect(result.months).toEqual(["2026-05", "2026-06", "2026-07", "2026-08"]);
    expect(result.total).toBe(136.67);
  });
  it("requires two distinct historical months, not two transactions", () => {
    expect(
      calculatePlan(
        [
          transaction("Mensa", -10, "2026-08-01"),
          transaction("Mensa", -20, "2026-08-02"),
        ],
        "2026-09-11",
      ).total,
    ).toBe(0);
  });
  it("ignores future transactions and handles year rollover", () => {
    const result = calculatePlan(
      [transaction("Mensa", -100, "2026-09-12")],
      "2026-09-11",
    );
    expect(result.total).toBe(0);
    expect(calculatePlan([], "2027-01-01").months).toEqual([
      "2026-09",
      "2026-10",
      "2026-11",
      "2026-12",
    ]);
  });
});

describe("savings and interest", () => {
  const settings = createSeed().settings;
  it("never allocates a negative surplus", () =>
    expect(splitSurplus(-100, 0, settings)).toEqual({
      Notgroschen: 0,
      Urlaub: 0,
      Sparkonto: 0,
      Motorrad: 0,
    }));
  it("protects 180 euros before funding the target", () =>
    expect(splitSurplus(1000, 0, { ...settings, asOf: "2026-10-01" })).toMatchObject({
      Motorrad: 820,
      Sparkonto: 180,
      Urlaub: 0,
    }));
  it("caps the goal and redirects overflow to savings only during the vacation pause", () => {
    expect(splitSurplus(1000, settings.bikeTarget - 100, { ...settings, asOf: "2026-10-01" })).toMatchObject({
      Motorrad: 100,
      Sparkonto: 900,
      Urlaub: 0,
    });
    expect(splitSurplus(1000, settings.bikeTarget, settings)).toMatchObject({
      Motorrad: 0,
      Sparkonto: 180,
      Urlaub: 820,
    });
  });
  it("starts net interest in October and compounds monthly", () => {
    expect(monthlyInterest(4434.13, "2026-09", settings)).toBe(0);
    expect(monthlyInterest(4434.13, "2026-10", settings)).toBe(6.7);
    const timeline = calculateDashboard(createSeed()).timeline;
    const october = timeline.find((row) => row.month === "2026-10")!;
    const november = timeline.find((row) => row.month === "2026-11")!;
    expect(october.end.Notgroschen).toBe(4440.83);
    expect(november.interest).toBe(6.71);
  });
  it("uses actual calendar days for a rate change", () => {
    expect(
      monthlyInterest(12000, "2026-09", {
        ...settings,
        interestStart: "2026-09-01",
      }),
    ).toBe(17.16);
  });
  it("bounds the countdown divisor at one", () => {
    expect(bikeCountdown(0, 1500, settings)).toMatchObject({
      months: 6,
      required: 900,
      onTrack: true,
    });
    expect(
      bikeCountdown(0, 0, { ...settings, bikePurchaseDate: "2026-08-01" }),
    ).toMatchObject({ months: 1, overdue: true });
  });
  it("does not count transactions already included in the baseline twice", () => {
    const state = createSeed();
    state.transactions = [
      { ...transaction("Transfer intern", -50, "2026-09-01"), pocket: "Sparkonto" },
      { ...transaction("Transfer intern", -20, "2026-09-12"), pocket: "Sparkonto" },
    ];
    expect(actualPockets(state).Sparkonto).toBe(1782.59);
    state.settings.asOf = "2026-09-12";
    expect(actualPockets(state).Sparkonto).toBe(1762.59);
  });
  it("computes the ninety-day strip from the shared monthly engine", () => {
    const state = createSeed();
    state.financeRows[0].values = { "2026-10": 3000 };
    state.financeRows[2].values = { "2026-10": 1000 };
    const october = calculateDashboard(state).ninetyDays[1];
    expect(october).toMatchObject({
      income: 3000,
      fixed: 1000,
      surplus: 1088.5,
      bikeTransfer: 908.5,
      remaining: 180,
    });
  });
  it("preserves debit direction for ordinary pocket transfers", () => {
    const state = createSeed();
    state.settings.asOf = "2026-09-12";
    state.transactions = [
      {
        ...transaction("Entnahme", -100, "2026-09-12"),
        pocket: "Sparkonto",
        category: "Transfer",
      },
    ];
    expect(actualPockets(state).Sparkonto).toBe(1682.59);
  });
  it("counts a round-up only once when the bank supplies its matching credit", () => {
    const state = createSeed();
    state.settings.asOf = "2026-09-12";
    state.transactions = [
      transaction("Auszahlung bei Pocket", -0.5, "2026-09-12"),
      {
        ...transaction("Um EUR Sparen von EUR einzustecken", 0.5, "2026-09-12"),
        pocket: "Sparkonto",
        category: "Transfer",
      },
    ];
    expect(actualPockets(state).Sparkonto).toBe(1783.09);
  });
  it("counts newly entered baseline-day bookings but not imported baseline history", () => {
    const state = createSeed();
    state.transactions = [
      transaction("Auszahlung bei Pocket", -0.5, "2026-09-11"),
      {
        ...transaction("Auszahlung bei Pocket", -0.75, "2026-09-11"),
        afterBaseline: true,
      },
    ];
    expect(actualPockets(state).Sparkonto).toBe(1783.34);
    expect(
      calculateDashboard(state).timeline.find((row) => row.month === "2026-09")!
        .movement.Sparkonto,
    ).toBe(0.75);
    expect(
      calculateDashboard(state).timeline.find((row) => row.month === "2026-10")!
        .movement.Sparkonto,
    ).toBe(0);
  });
  it("does not restart bike saving after a funded purchase withdrawal", () => {
    const state = createSeed();
    state.settings.balances.Motorrad = 8500;
    state.financeRows[0].values = { "2026-10": 1911.5, "2026-11": 2011 };
    state.months["2026-10"] = {
      variableOverride: null,
      bikeOverride: null,
      pocketIn: { Notgroschen: 0, Urlaub: 0, Sparkonto: 0, Motorrad: 0 },
      pocketOut: { Notgroschen: 0, Urlaub: 0, Sparkonto: 0, Motorrad: 8500 },
    };
    expect(
      calculateDashboard(state).timeline.find((row) => row.month === "2026-11")!
        .rates,
    ).toMatchObject({ Motorrad: 0, Sparkonto: 1000, Urlaub: 0 });
  });
});
