import { createEmptyAccountState } from "../../src/lib/account-state";
import { monthsForYear } from "../../src/lib/calc";
import {
  appStateSchema,
  type AppState,
  type Transaction,
} from "../../src/lib/types";

export function pocketFixture(): AppState {
  const state = createEmptyAccountState();
  state.settings = {
    ...state.settings,
    asOf: "2026-10-08",
    baselineDate: "2026-10-01",
    balances: { Notgroschen: 1000, Urlaub: 100, Sparkonto: 200, Motorrad: 0 },
    bikeTarget: 5400,
    bikePurchaseDate: "2027-04-01",
  };
  state.financeRows = [
    {
      id: "salary",
      label: "Gehalt",
      kind: "income",
      values: Object.fromEntries(
        [...monthsForYear(2026), ...monthsForYear(2027)].map((month) => [
          month,
          3000,
        ]),
      ),
    },
  ];
  state.savingsGoals = [
    {
      id: "motorcycle",
      name: "Motorrad",
      pocket: "Motorrad",
      target: 5400,
      date: "2027-04-01",
      openingBalance: { date: "2026-10-01", amount: 2445 },
      funding: { monthly: 0, extras: { "2026-12": 800, "2027-01": 2576 } },
    },
  ];
  state.trBalances = [
    { date: "2026-10-02", balance: 5000 },
    { date: "2026-10-09", balance: 6200 },
  ];
  state.pocketSnapshots = [
    { pocket: "Sparkonto", bank: "Revolut", date: "2026-10-03", balance: 250 },
    { pocket: "Sparkonto", bank: "Revolut", date: "2026-10-09", balance: 900 },
  ];
  state.accountSnapshots = [
    { bank: "Revolut", name: "Notgroschen", date: "2026-10-05", balance: 10 },
    { bank: "Revolut", name: "Mittagessen", date: "2026-10-02", balance: 10 },
    { bank: "Revolut", name: "Mittagessen", date: "2026-10-04", balance: 20 },
    { bank: "Revolut", name: "Mittagessen", date: "2026-10-09", balance: 800 },
    { bank: "Revolut", name: "Lebensmittel", date: "2026-10-03", balance: 30 },
    {
      bank: "Revolut",
      name: "Entertainment & Haushalt",
      date: "2026-10-04",
      balance: 0,
    },
  ];
  const roundUp = (id: string, date: string, amount: number): Transaction => ({
    id,
    date,
    amount,
    bank: "Revolut",
    pocket: null,
    description: "Auszahlung bei Pocket",
    category: "Transfer intern",
    includeInPlan: false,
    reviewed: true,
  });
  state.transactions = [
    roundUp("round-september", "2026-09-12", -0.35),
    roundUp("round-october", "2026-10-02", -0.5),
    roundUp("round-future", "2026-10-09", -0.9),
    {
      ...roundUp("round-credit", "2026-10-02", 0.5),
      pocket: "Sparkonto",
      description: "Von EUR Giro",
    },
    {
      ...roundUp("savings-transfer", "2026-10-04", 10),
      pocket: "Sparkonto",
      description: "Von EUR Giro",
    },
  ];
  return appStateSchema.parse(state);
}
