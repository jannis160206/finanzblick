import { describe, expect, it } from "vitest";
import { actualBookings, calculateDashboard, classify } from "@/lib/calc";
import { reconcileLeasingSources as reconcileSources } from "@/lib/leasing";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type Transaction } from "@/lib/types";
import { statementFingerprint } from "@/lib/import/identity";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "@/lib/import/review";
import type { StatementResult } from "@/lib/import/statements";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { personalAmount } from "@/lib/shared-holiday";
import { normalizeAccount } from "@/lib/accounts";

const reconcileLeasingSources = (rows: Transaction[]) => reconcileSources(rows, (row) => classify(row).category);

const legacy: Transaction = {
  id: "xlsx-107", date: "2026-09-01", bank: "Raiffeisen", pocket: null,
  description: "Porsche Bank – Leasing KL123AB", amount: -289.52,
  category: "Leasing", sourceCategory: "Leasing", includeInPlan: false,
};
const bankBooking = (reference = "leasing-reference"): Transaction => ({
  ...legacy, id: reference, pocket: "Raiffeisen Giro", bankReference: reference,
  description: "Zahlungsempfänger: Porsche Bank Aktiengesellschaft Verwendungszweck: 123456789 KL123AB 289,52 Mandat: 987654321",
});
function fixture(withReceipt = true) {
  const state = createSeed();
  state.settings.asOf = "2026-09-16";
  state.transactions = [legacy];
  state.financeRows = [{ id: "lease-plan", kind: "fixed", label: "Leasing / Autokredit", values: { "2026-09": 289.52, "2026-10": 289.52 } }];
  const booking = bankBooking();
  state.fixedReceipts = withReceipt ? [{
    key: statementFingerprint(booking), rowId: "lease-plan", date: booking.date,
    amount: booking.amount, category: booking.category, booking,
  }] : [];
  return state;
}

describe("Leasing source reconciliation", () => {
  it("counts the September workbook debit and matching statement receipt once in the overview", () => {
    const state = fixture();
    const before = JSON.stringify(state);
    const dashboard = calculateDashboard(state);
    expect(dashboard.current).toMatchObject({ fixed: 289.52, actualSpending: 289.52 });
    expect(dashboard.spending).toEqual([{ name: "Leasing", value: 289.52 }]);
    expect(dashboard.timeline.find((row) => row.month === "2026-09")?.actualSpending).toBe(289.52);
    expect(actualBookings(state)).toHaveLength(1);
    expect(actualBookings(state)[0].bankReference).toBe("leasing-reference");
    expect(JSON.stringify(state)).toBe(before);
  });

  it("also reconciles a detailed transaction, regardless of source order, and restores the legacy fallback", () => {
    const bank = bankBooking();
    expect(reconcileLeasingSources([legacy, bank])).toEqual([bank]);
    expect(reconcileLeasingSources([bank, legacy])).toEqual([bank]);
    expect(reconcileLeasingSources([legacy])).toEqual([legacy]);
    const state = fixture(false);
    state.transactions.push(bank);
    expect(calculateDashboard(state).current.actualSpending).toBe(289.52);
    state.transactions = [legacy];
    expect(calculateDashboard(state).current.actualSpending).toBe(289.52);
  });

  it.each<Partial<Transaction>>([
    { date: "2026-09-02" },
    { date: "2026-10-01" },
    { amount: -289.53 },
    { amount: 289.52 },
    { bank: "Revolut" },
    { description: "Porsche Bank Leasing KL999CD" },
    { description: "Porsche Bank Leasing ohne Kennung" },
    { description: "Porsche Bank Leasing KL123AB und KL999CD" },
    { description: "Andere Bank Leasing KL123AB" },
    { category: "Versicherungen", categoryOverride: true },
    { pocket: null, bankReference: undefined },
  ])("retains debits without exact matching bank/date/amount/vehicle evidence: %j", (change) => {
    expect(reconcileLeasingSources([legacy, { ...bankBooking(), ...change }])).toHaveLength(2);
  });

  it("never merges different bank references or multiple real payments into one monthly rate", () => {
    const first = bankBooking("first-reference");
    const second = bankBooking("second-reference");
    expect(reconcileLeasingSources([legacy, first, second])).toEqual([first, second]);
    expect(reconcileLeasingSources([legacy, { ...legacy, id: "xlsx-108" }, first]))
      .toEqual([{ ...legacy, id: "xlsx-108" }, first]);
    expect(reconcileLeasingSources([{ ...legacy, id: "manual-lease" }, first])).toHaveLength(2);
    const state = fixture(false);
    state.transactions.push(first, second);
    expect(calculateDashboard(state).current.actualSpending).toBe(579.04);
  });

  it("preserves explicit sharing and payment status when the detailed bank representation replaces the legacy view", () => {
    const state = fixture();
    state.transactions = [{ ...legacy, sharedWithRaphael: true, sharedPaidManually: true }];
    const before = JSON.stringify(state);
    expect(actualBookings(state)[0]).toMatchObject({ sharedWithRaphael: true, sharedPaidManually: true, amount: -289.52 });
    expect(personalAmount(actualBookings(state)[0])).toBe(-144.76);
    expect(calculateDashboard(state).current.actualSpending).toBe(144.76);
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each(["Sonstiges", "Prüfen"] as const)("uses the chart's effective Leasing category when an older save stores %s", async (category) => {
    const state = fixture();
    state.transactions = [{ ...legacy, category }];
    expect(classify(state.transactions[0]).category).toBe("Leasing");
    const before = JSON.stringify(state);
    const assertOverview = (value: typeof state) => {
      expect(calculateDashboard(value).spending).toEqual([{ name: "Leasing", value: 289.52 }]);
      expect(calculateDashboard(value).current.actualSpending).toBe(289.52);
      expect(actualBookings(value)).toHaveLength(1);
      expect(value.transactions[0].category).toBe(category);
    };
    assertOverview(state);
    assertOverview(appStateSchema.parse(JSON.parse(JSON.stringify(state))));
    assertOverview((await parseWorkbook(await exportWorkbook(state))).state);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("also uses effective classification for a detailed transaction with a stale stored category", () => {
    const detailed = { ...bankBooking(), category: "Sonstiges" as const };
    const state = fixture(false);
    state.transactions.push(detailed);
    expect(reconcileLeasingSources(state.transactions)).toEqual([detailed]);
    expect(calculateDashboard(state).spending).toEqual([{ name: "Leasing", value: 289.52 }]);
  });

  it("does not ignore an explicit manual non-leasing classification on the legacy row", () => {
    const manual = { ...legacy, category: "Shopping" as const, categoryOverride: true };
    expect(classify(manual).category).toBe("Shopping");
    expect(reconcileLeasingSources([manual, bankBooking()])).toHaveLength(2);
  });

  it("survives import, reimport, review, JSON and Excel restoration without deleting bank facts", async () => {
    let state = fixture(false);
    const source: StatementResult = { file: "leasing.csv", source: "Raiffeisen", rows: [bankBooking()], skipped: 0, issues: [] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = prepareStatementImport([source], state);
      expect(prepared.review).toEqual([]);
      state = queueLedgerReview(commitStatementImport(state, prepared.automatic, [], prepared.metadata).state);
      expect(calculateDashboard(state).spending).toEqual([{ name: "Leasing", value: 289.52 }]);
      expect(state.transactions).toEqual([legacy]);
      expect(state.fixedReceipts?.[0].amount).toBe(-289.52);
      expect(state.fixedReceipts?.[0].booking?.bankReference).toBe("leasing-reference");
    }
    const json = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    const restored = (await parseWorkbook(await exportWorkbook(json))).state;
    expect(calculateDashboard(restored).current).toMatchObject({ fixed: 289.52, actualSpending: 289.52 });
    expect(restored.transactions).toEqual(state.transactions.map(normalizeAccount));
    expect(restored.fixedReceipts).toEqual(state.fixedReceipts);
  });
});
