import { describe, expect, it, vi } from "vitest";
import { actualBookings, addMonths, calculateDashboard, classify, monthsForYear, sum } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { earlySpecialSalary, isTTSPayroll } from "@/lib/payroll";
import { personalAmount } from "@/lib/shared-holiday";
import { queueLedgerReview, repairMerchantBookings, splitFixedBookings } from "@/lib/import/review";
import * as merchants from "@/lib/import/merchant-description";
import * as rules from "@/lib/import/merchant-rules";
import type { AppState, Transaction } from "@/lib/types";

const booking = (id: string, overrides: Partial<Transaction> = {}): Transaction => ({
  id, date: "2026-09-05", description: `Händler ${id}`, amount: -25,
  bank: "Revolut", pocket: null, category: "Freizeit", categoryOverride: true, includeInPlan: true, ...overrides,
});
const fixture = (transactions: Transaction[]): AppState => {
  const state = createSeed();
  return { ...state, transactions, financeRows: [], fixedReceipts: [], reviewQueue: [],
    settings: { ...state.settings, asOf: "2026-09-16" } };
};

// Independent pre-optimization rules, including the 25th special-payment case.
function originalMonth(row: Transaction) {
  const month = row.date.slice(0, 7);
  const day = Number(row.date.slice(8, 10));
  const nextMonth = addMonths(month, 1);
  return row.amount > 0 && classify(row).category === "Gehalt" &&
    ((day >= 26 && day <= 30) || earlySpecialSalary(row, nextMonth)) ? nextMonth : month;
}
function referenceActuals(state: AppState, month: string) {
  const bookings = actualBookings(state).filter((row) => originalMonth(row) === month && row.date <= state.settings.asOf);
  const income = ["Einkommen", "Gehalt", "Rufbereitschaft"];
  return {
    actualSpending: sum(bookings.filter((row) => !income.includes(classify(row).category) && !classify(row).isTransfer).map((row) => -personalAmount(row))),
    received: sum(bookings.filter((row) => income.includes(classify(row).category) && !classify(row).isTransfer).map(personalAmount)),
    salaryReceived: sum(bookings.filter((row) => row.amount > 0 && isTTSPayroll(row) && classify(row).category === "Gehalt" && !classify(row).isTransfer).map((row) => row.amount)),
  };
}

describe("performance regressions without timing-dependent limits", () => {
  it("keeps all 24 months identical to the original accounting, including edits and advancing the date", () => {
    const salary = (id: string, date: string, description: string, amount = 2500) =>
      booking(id, { date, description, amount, category: "Gehalt", categoryOverride: false });
    const state = fixture([
      ...[...monthsForYear(2026), ...monthsForYear(2027)].map((month, i) => booking(`spend-${i}`, { date: `${month}-05`, amount: -31.17 })),
      salary("march", "2026-02-25", "TTS TeamTalentSolutions Gehalt 2/2026"),
      salary("august", "2026-07-30", "TTS TeamTalentSolutions Gehalt 7/2026"),
      salary("september", "2026-08-27", "TTS TeamTalentSolutions Gehalt 8/2026"),
      salary("october", "2026-09-26", "TTS TeamTalentSolutions Gehalt 9/2026"),
      salary("on-call", "2026-09-07", "TTS TeamTalentSolutions Gehalt 8/2026", 750),
      salary("bonus", "2026-09-10", "TTS TeamTalentSolutions Bonus", 500),
      booking("refund", { amount: 5.99 }),
      booking("shared", { amount: -101.01, sharedWithRaphael: true }),
      booking("repayment", { amount: 50, date: "2026-09-10", description: "Raphael Piber", category: "Sonstiges" }),
      booking("transfer", { category: "Transfer intern", pocket: "Motorrad" }),
    ]);
    state.holidayRanges = [{ from: "2026-07-01", to: "2026-07-10" }];
    for (const date of ["2026-09-16", "2026-10-01"]) {
      state.settings.asOf = date;
      const before = JSON.stringify(state);
      for (const month of calculateDashboard(state).timeline)
        expect(month).toMatchObject(referenceActuals(state, month.month));
      expect(JSON.stringify(state)).toBe(before);
    }
    state.transactions[0] = { ...state.transactions[0], sharedWithRaphael: true };
    expect(calculateDashboard(state).timeline[0]).toMatchObject(referenceActuals(state, "2026-01"));
  });

  it("does not reclassify every incoming booking for each forecast month", () => {
    const count = 200;
    const state = fixture(Array.from({ length: count }, (_, i) => booking(`income-${i}`, {
      date: "2026-08-27", amount: 100, category: "Einkommen",
    })));
    const recover = vi.spyOn(merchants, "recoverMerchant");
    try {
      calculateDashboard(state);
      // The former repeated monthly scans caused well over 90 recoveries per row.
      expect(recover.mock.calls.length).toBeLessThan(count * 12);
    } finally { recover.mockRestore(); }
  });

  it("normalizes each stored merchant rule once per queue rebuild, not once per booking", () => {
    const rows = Array.from({ length: 80 }, (_, i) => booking(`merchant-${i}`));
    const state = fixture(rows);
    state.merchantRules = rows.map((row) => ({ key: rules.merchantRuleKey(row), category: row.category }));
    const normalize = vi.spyOn(rules, "storedMerchantKey");
    try {
      expect(queueLedgerReview(state).reviewQueue).toEqual([]);
      expect(normalize).toHaveBeenCalledTimes(rows.length);
    } finally { normalize.mockRestore(); }
    const changed = { ...state, merchantRules: state.merchantRules.map((rule, i) => i === 0 ? { ...rule, category: "Shopping" as const } : rule) };
    expect(queueLedgerReview(changed).reviewQueue).toMatchObject([
      { id: rows[0].id, message: "Widersprüchliche Händlerregel: Zuordnung prüfen." },
    ]);
  });

  it("builds the learned-rule lookup only once while repairing many original POS descriptions", () => {
    const rows = Array.from({ length: 30 }, (_, i) => booking(`pos-${i}`, {
      description: `POS BILLA Filiale ${i} Terminal 123`, category: "Prüfen", categoryOverride: false,
    }));
    const state = fixture(rows);
    const before = JSON.stringify(state);
    const createApplier = vi.spyOn(rules, "createMerchantRuleApplier");
    try {
      const repaired = repairMerchantBookings(state);
      expect(createApplier).toHaveBeenCalledTimes(1);
      expect(repaired.transactions.every((row) => row.category === "Lebensmittel")).toBe(true);
      expect(repaired.transactions.map((row) => row.rawDescription)).toEqual(rows.map((row) => row.description));
      expect(JSON.stringify(state)).toBe(before);
    } finally { createApplier.mockRestore(); }
  });

  it("does not scan the ledger for an empty import when accepting an existing assignment", () => {
    const state = fixture([]);
    Object.defineProperty(state, "transactions", { get: () => { throw new Error("Unnecessary ledger scan"); } });
    expect(splitFixedBookings(state, [])).toEqual({ rows: [], receipts: [], changes: [], duplicates: 0 });
  });
});
