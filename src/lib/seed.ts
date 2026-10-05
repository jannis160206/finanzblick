import { type AppState } from "@/lib/types";

export function createSeed(): AppState {
  return {
    version: 1,
    settings: {
      asOf: "2026-09-11",
      baselineDate: "2026-09-11",
      balances: {
        Sparkonto: 1782.59,
        Urlaub: 1312.06,
        Notgroschen: 4434.13,
        Motorrad: 0,
      },
      emergencyTarget: 6000,
      vacationTarget: 5500,
      savingsTarget: 10000,
      bikeTarget: 5400,
      bikePurchaseDate: "2027-04-01",
      allocationStart: "2026-10-01",
      bikeShare: 0.9,
      afterBikeSavingsShare: 0.6,
      oldRate: 0.0225,
      newRate: 0.025,
      rateChangeDate: "2026-09-17",
      taxRate: 0.275,
      interestStart: "2026-10-01",
    },
    transactions: [],
    financeRows: [
      { id: "income-salary", label: "Gehalt", kind: "income", values: {} },
      {
        id: "income-other",
        label: "Weitere Einnahmen",
        kind: "income",
        values: {},
      },
      { id: "fixed-rent", label: "Wohnen", kind: "fixed", values: {} },
      {
        id: "fixed-insurance",
        label: "Versicherungen",
        kind: "fixed",
        values: {},
      },
      {
        id: "fixed-subscriptions",
        label: "Verträge & Abos",
        kind: "fixed",
        values: {},
      },
    ],
    months: {},
  };
}
