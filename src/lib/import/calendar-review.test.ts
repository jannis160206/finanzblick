import { describe, expect, it } from "vitest";
import { calculateDashboard, classify, classifyStatementRows } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type Transaction } from "@/lib/types";
import { parseStatementCsv } from "./statements";
import { parseAmexText } from "./amex-pdf";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "./review";

const booking = (id: string, description = "Unbekannter Händler"): Transaction => ({ id, bank: "Revolut", pocket: "Persönliches Konto", date: "2026-09-14", description, amount: -20, category: "Prüfen", includeInPlan: false });

describe("bank clocks and lunch", () => {
  it.each([
    ["Raiffeisen", "14.09.2026;Mensa;14.09.2026;-8,00;EUR;14.09.2026 12:15:00:000"],
    ["Revolut", "Revolut\nDatum;Beschreibung;Geld ein-/ausgezahlt\n2026-09-14 12:15:00;Mensa;-8,00"],
    ["Amex", "Date,Description,Card Member,Amount,Time\n14/09/2026,Mensa,Jannis,8.00,12:15:00"],
  ])("extracts %s time and applies the shared lunch rule", (bank, csv) => {
    const result = parseStatementCsv(csv);
    expect(result.rows[0]).toMatchObject({ bank, time: "12:15:00", category: "Mittagessen" });
    for (const date of ["2026-04-06", "2026-10-10", "2026-10-26", "2027-03-29", "2027-10-26"])
      expect(classify({ ...result.rows[0], date }).category).not.toBe("Mittagessen");
    expect(classify({ ...result.rows[0], time: "14:00:01" }).category).not.toBe("Mittagessen");
  });
  it("keeps Amex PDF clocks, including a separate time line", () => {
    for (const line of ["14.09 15.09 Mensa 12:15 8,00", "14.09 15.09 Mensa 8,00\nUhrzeit 12:15"]) {
      const result = parseAmexText([`American Express\n30.09.2026\nUmsatz vom Buchung am Betrag in EUR\n${line}`]);
      expect(result.rows[0]).toMatchObject({ date: "2026-09-14", time: "12:15:00", category: "Mittagessen" });
      expect(result.issues).toEqual([]);
    }
  });
  it("does not invent time for any bank, or let learned lunch rules bypass the calendar", () => {
    for (const bank of ["Raiffeisen", "Revolut", "Amex"]) {
      const row = { ...booking(bank, "Mensa"), bank, category: "Mittagessen" as const, categoryOverride: true };
      expect(classify(row).category).not.toBe("Mittagessen");
      expect(classify({ ...row, date: "2026-09-12", time: "12:15:00" }).category).not.toBe("Mittagessen");
    }
  });
});

describe("Amex settlement is not another expense", () => {
  it.each(["Amex", "American Express", "Amex Rückzahlung", "AMEX Abrechnung", "American Express Europe"])("treats %s as an internal settlement on Giro and Revolut", (description) => {
    for (const bank of ["Raiffeisen", "Revolut"])
      expect(classify({ ...booking(bank, description), bank, category: "Shopping", categoryOverride: true })).toMatchObject({ category: "Transfer intern", isTransfer: true, includeInPlan: false });
  });
  it("counts the purchase once, deduplicates repeated PDF files and excludes later settlement", () => {
    let state = createSeed(); state.settings.asOf = "2026-09-14";
    const pdf = () => parseAmexText(["American Express\n30.09.2026\nUmsatz vom Buchung am Betrag in EUR\n14.09 14.09 Pizzeria 20,00"]);
    for (let i = 0; i < 2; i++) {
      const prepared = prepareStatementImport([pdf()], state);
      state = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
    }
    expect(state.transactions).toHaveLength(1);
    state = commitStatementImport(state, classifyStatementRows([{ ...booking("settlement", "Amex Rückzahlung"), bank: "Raiffeisen" }])).state;
    expect(state.transactions).toHaveLength(2);
    expect(calculateDashboard(state).current.actualSpending).toBe(20);
  });
  it("keeps actual Amex membership fees as expenses", () => {
    expect(classify({ ...booking("fee", "Monatsgebühr"), bank: "Amex" })).toMatchObject({ category: "AMEX Monatsgebühr", isTransfer: false });
  });
});

describe("review the existing ledger", () => {
  it("queues only unsure rows, persists later review and updates all twins in place", () => {
    const state = createSeed(); state.settings.asOf = "2026-09-14";
    state.transactions = [booking("one"), { ...booking("two"), date: "2026-09-11", amount: -30 }, { ...booking("known", "Amazon"), category: "Shopping" }];
    const queued = appStateSchema.parse(JSON.parse(JSON.stringify(queueLedgerReview(state))));
    expect(queued.reviewQueue).toHaveLength(2);
    expect(queueLedgerReview(queued).reviewQueue).toHaveLength(2);
    const result = commitStatementImport(queued, [{ ...queued.transactions[0], category: "Gesundheit", categoryOverride: true }]).state;
    expect(result.transactions).toHaveLength(3);
    expect(result.transactions.slice(0, 2).map((row) => row.category)).toEqual(["Gesundheit", "Gesundheit"]);
    expect(result.reviewQueue).toEqual([]);
    expect(result.fixedReceipts).toBeUndefined();
    expect(result.transactions.map(({ id, date, description, amount, bank, pocket }) => ({ id, date, description, amount, bank, pocket }))).toEqual(state.transactions.map(({ id, date, description, amount, bank, pocket }) => ({ id, date, description, amount, bank, pocket })));
  });
});
