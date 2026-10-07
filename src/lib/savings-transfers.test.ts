import { describe, expect, it } from "vitest";
import { isRevolutMainAccount } from "./accounts";
import { revolutSavingsTransferAmount } from "./transfers";
import { calculateDashboard } from "./calc";
import { createEmptyAccountState } from "./account-state";
import { monthlyVariableBudget } from "./variable-budgets";
import { parseStatementCsv } from "./import/statements";
import type { Transaction } from "./types";

const month = "2026-10";
const asOf = "2026-10-07";
const debit = (patch: Partial<Transaction> = {}): Transaction => ({
  id: "main", date: "2026-10-06", bank: "Revolut", pocket: "Persönliches Konto",
  description: "Um EUR Sparen von EUR einzustecken", amount: -300,
  category: "Transfer intern", includeInPlan: false, ...patch,
});
const credit = (patch: Partial<Transaction> = {}): Transaction => ({
  ...debit(), id: "credit", pocket: "Sparen", amount: 300, ...patch,
});
function stateFor(rows: Transaction[] = []) {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.settings.baselineDate = "2026-09-11";
  state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: {
    [month]: monthlyVariableBudget(month).total + 301.4,
  } }];
  state.transactions = rows;
  return state;
}

describe("explicit Revolut main-account savings transfers", () => {
  it.each([null, "Hauptkonto", "Persönliches Konto", "Persönliches Konto (EUR)", "Personal account (EUR)", "EUR"])("recognizes the EUR main-account alias %s", (pocket) => {
    expect(isRevolutMainAccount(debit({ pocket }))).toBe(true);
    expect(revolutSavingsTransferAmount([debit({ pocket })], month, asOf)).toBe(300);
  });

  it.each([
    "Um EUR Sparen von EUR einzustecken", "Um EUR zu EUR Sparkonto einzustecken",
    "Überweisung an Sparkonto", "Transfer vom Hauptkonto zu Sparen", "Hauptkonto -> Sparkonto",
  ])("recognizes an explicitly named savings destination in %s", (description) => {
    expect(revolutSavingsTransferAmount([debit({ description })], month, asOf)).toBe(300);
  });

  it.each([
    { bank: "Raiffeisen" }, { pocket: "Urlaub 2026" }, { pocket: "Mittagessen" },
    { pocket: "Persönliches Konto (USD)" }, { amount: 300 },
    { date: "2026-09-30" }, { date: "2026-10-08" },
    { description: "Transfer an Urlaub" }, { description: "Transfer von Sparkonto zu Hauptkonto" },
    { description: "Auszahlung bei Pocket" }, { description: "Sparkonto", sourceCategory: "Round-up" },
    { description: "Aufrundung zu Sparkonto" }, { description: "BILLA", merchantAlias: "Transfer zu Sparkonto" },
    { description: "Überweisung an Sparkonto 2" }, { description: "Überweisung an Sparen Urlaub" },
  ])("does not confirm an unrelated, ambiguous, automatic or unbooked debit: %j", (patch) => {
    expect(revolutSavingsTransferAmount([debit(patch)], month, asOf)).toBe(0);
  });

  it("does not accept the generic savings credit shared by vacation transfers and round-ups", () => {
    const rows = [
      debit({ id: "vacation", date: "2026-10-01", pocket: "Urlaub 2026", description: "Auszahlung bei Pocket" }),
      credit({ date: "2026-10-01" }),
      credit({ id: "round-1", date: "2026-10-01", amount: 0.1 }),
      credit({ id: "round-2", date: "2026-10-01", amount: 0.1 }),
      credit({ id: "round-3", date: "2026-10-01", amount: 0.2 }),
    ];
    expect(revolutSavingsTransferAmount(rows, month, asOf)).toBe(0);
    const state = stateFor(rows);
    state.pocketSnapshots = [{ pocket: "Sparkonto", bank: "Revolut", date: "2026-10-05", balance: 1200 }];
    const original = JSON.stringify(state);
    const dashboard = calculateDashboard(state);
    expect(dashboard.monthlyFunding[0]).toMatchObject({ amount: 301.4, transferred: 0, done: false });
    expect(dashboard.timeline.find((row) => row.month === month)?.end.Sparkonto).toBeCloseTo(dashboard.actual.Sparkonto + 301.4, 2);
    expect(JSON.stringify(state)).toBe(original);
  });

  it("can verify an explicitly identified main-account credit without importing its debit twice", () => {
    const explicit = credit({ description: "Überweisung vom Revolut Hauptkonto an Sparkonto" });
    expect(revolutSavingsTransferAmount([explicit], month, asOf)).toBe(300);
    expect(revolutSavingsTransferAmount([debit(), explicit, credit()], month, asOf)).toBe(300);
    expect(revolutSavingsTransferAmount([
      debit(), debit({ id: "second" }), explicit, { ...explicit, id: "second-credit" },
    ], month, asOf)).toBe(600);
    expect(revolutSavingsTransferAmount([
      credit({ description: "Transfer von Persönliches Konto (USD)" }),
    ], month, asOf)).toBe(0);
  });

  it("supports original destination details, not a relabelled merchant alone", () => {
    expect(revolutSavingsTransferAmount([debit({ description: "Interne Überweisung", rawDetails: ["Zielkonto: Sparkonto"] })], month, asOf)).toBe(300);
    expect(revolutSavingsTransferAmount([debit({ description: "Interne Überweisung", rawDescription: "Überweisung an Sparkonto" })], month, asOf)).toBe(300);
  });

  it("pairs explicitly sourced statement legs across adjacent dates without counting the previous month's transfer again", () => {
    const explicit = credit({ description: "Überweisung vom Revolut Hauptkonto an Sparkonto", date: "2026-10-07" });
    expect(revolutSavingsTransferAmount([debit(), explicit], month, asOf)).toBe(300);
    expect(revolutSavingsTransferAmount([explicit, debit()], month, asOf)).toBe(300);
    expect(revolutSavingsTransferAmount([
      debit({ date: "2026-09-30" }), { ...explicit, date: "2026-10-01" },
    ], month, asOf)).toBe(0);
    expect(revolutSavingsTransferAmount([
      debit(), debit({ id: "second", date: "2026-10-07" }), explicit,
      { ...explicit, id: "other-credit", date: "2026-10-06" },
    ], month, asOf)).toBe(600);
  });

  it.each([100, 300, 800])("keeps the 301.40 recommendation but confirms and displays the actual %s transfer", (amount) => {
    const dashboard = calculateDashboard(stateFor([debit({ amount: -amount }), credit({ amount })]));
    expect(dashboard.monthlyFunding[0]).toMatchObject({ amount: 301.4, transferred: amount, done: true });
    expect(dashboard.timeline.find((row) => row.month === month)?.rates.Sparkonto).toBe(301.4);
    expect(dashboard.timeline.find((row) => row.month === month)?.end.Sparkonto).toBeCloseTo(dashboard.actual.Sparkonto + Math.max(0, 301.4 - amount), 2);
  });

  it("still shows a real transfer when there is no positive recommendation", () => {
    const state = stateFor([debit()]);
    state.financeRows = [];
    expect(calculateDashboard(state).monthlyFunding[0]).toMatchObject({ name: "Sparkonto", amount: 0, transferred: 300, done: true });
  });

  it("sums executed transfers in cents without adding the destination legs or unrelated savings credits", () => {
    const rows = [
      debit({ amount: -100.1 }), debit({ id: "second", amount: -200.2 }),
      credit({ amount: 100.1 }), credit({ id: "second-credit", amount: 200.2 }),
      credit({ id: "other", amount: 300 }), credit({ id: "round-up", amount: 0.4 }),
    ];
    expect(revolutSavingsTransferAmount(rows, month, asOf)).toBe(300.3);
  });

  it("recognizes both legs of a parsed Revolut statement exactly once", () => {
    const csv = "Revolut\nPersönliches Konto (EUR)\nDatum;Beschreibung;Geld ein-/ausgezahlt\n06.10.2026;Um EUR Sparen von EUR einzustecken;-300,00\nSparen (EUR)\nDatum;Beschreibung;Geld ein-/ausgezahlt\n06.10.2026;Um EUR Sparen von EUR einzustecken;300,00";
    const parsed = parseStatementCsv(csv);
    expect(parsed.rows).toHaveLength(2);
    expect(revolutSavingsTransferAmount(parsed.rows, month, asOf)).toBe(300);
  });
});
