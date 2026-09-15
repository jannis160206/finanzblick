import { describe, expect, it } from "vitest";
import { actualBookings, bookingMonth, classify, calculateDashboard } from "@/lib/calc";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { isSpecialSalaryMonth } from "@/lib/payroll";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { applyMerchantRules, merchantRuleKey } from "./merchant-rules";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "./review";
import { parseStatementCsv, statementFingerprint, type StatementResult } from "./statements";

const row = (date: string, amount: number, period: string): Transaction => ({
  id: `${date}-${amount}`, date, amount, bank: "Raiffeisen", pocket: "Raiffeisen Giro",
  description: `TTS TeamTalentSolutions GmbH – Gehalt ${period}`, category: "Gehalt", includeInPlan: false,
});
const payments = [
  row("2026-01-12", 548.16, "12/2025"), row("2026-01-29", 2450.29, "1/2026"),
  row("2026-02-25", 3475.38, "2/2026"), row("2026-03-30", 2450.29, "3/2026"),
  row("2026-06-29", 5506.72, "6/2026"), row("2026-07-09", 371.29, "6/2026"),
  row("2026-11-27", 4000, "11/2026"),
];
function stateForTest(): AppState {
  const state = createSeed();
  state.settings.asOf = "2026-12-15";
  state.financeRows = [
    { id: "salary", label: "Nettogehalt", kind: "income", values: {
      "2026-01": 2442.56, "2026-02": 2442.56, "2026-03": 3475.38, "2026-04": 2442.56,
      "2026-07": 5506, "2026-12": 4000, "2027-01": 2576.43,
    }, overrides: { "2026-12": 4000 } },
    { id: "on-call", label: "Rufbereitschaft", kind: "income", values: { "2026-01": 250, "2026-07": 210 } },
  ];
  return state;
}
const result = (rows: Transaction[]): StatementResult => ({ rows, source: "Raiffeisen", file: "payroll.csv", skipped: 0, issues: [] });
function importRows(state: AppState, rows: Transaction[]) {
  const prepared = prepareStatementImport([result(rows)], state);
  expect(prepared.review).toEqual([]);
  return queueLedgerReview(commitStatementImport(state, prepared.automatic, [], prepared.metadata).state);
}

describe("automatic payroll", () => {
  it.each(Array.from({ length: 12 }, (_, index) => index + 1))("recognizes monthly on-call pay above 500 euros in month %s", (month) => {
    for (const year of [2026, 2027]) {
      const date = `${year}-${String(month).padStart(2, "0")}-12`;
      const previous = new Date(Date.UTC(year, month - 2, 1));
      const booking = row(date, 548.16, `${previous.getUTCMonth() + 1}/${previous.getUTCFullYear()}`);
      expect(classify(booking).category).toBe("Rufbereitschaft");
      expect(bookingMonth(booking)).toBe(date.slice(0, 7));
    }
  });
  it.each([
    [payments[0], "Rufbereitschaft", "2026-01"], [payments[1], "Gehalt", "2026-02"],
    [payments[2], "Gehalt", "2026-03"], [payments[3], "Gehalt", "2026-04"],
    [payments[4], "Gehalt", "2026-07"], [payments[5], "Rufbereitschaft", "2026-07"],
    [payments[6], "Gehalt", "2026-12"],
  ] as const)("recognizes %j as %s in %s", (booking, category, month) => {
    expect(classify(booking).category).toBe(category);
    expect(bookingMonth(booking)).toBe(month);
  });
  it.each(["03", "07", "12"])("recognizes special month %s in both supported years", (month) => {
    for (const year of [2026, 2027]) expect(isSpecialSalaryMonth(`${year}-${month}`)).toBe(true);
    expect(isSpecialSalaryMonth("2027-06")).toBe(false);
  });
  it("reads payroll period and on-call markers from details and source category", () => {
    const parsed = parseStatementCsv("Raiffeisen\nDatum;Beschreibung;Betrag;Verwendungszweck\n12.01.2026;TTS TeamTalentSolutions GmbH;548,16;Gehalt 12/2025");
    expect(parsed.rows[0].category).toBe("Rufbereitschaft");
    expect(classify({ ...payments[0], description: "Arbeitgeber", rawDetails: ["Rufbereitschaft"], amount: 800 }).category).toBe("Rufbereitschaft");
    expect(classify({ ...payments[0], description: "Arbeitgeber", sourceCategory: "Rufbereitschaft", amount: 800 }).category).toBe("Rufbereitschaft");
    expect(classify({ ...payments[0], description: "Anderer Arbeitgeber Gehalt 12/2025" }).category).toBe("Gehalt");
  });
  it("does not move regular generic salary on the 25th, on-call, or explicit bonuses", () => {
    expect(bookingMonth({ ...payments[2], description: "Gehalt" })).toBe("2026-02");
    expect(bookingMonth(row("2026-04-25", 2500, "4/2026"))).toBe("2026-04");
    expect(bookingMonth({ ...payments[6], description: "Rufbereitschaft" })).toBe("2026-11");
    expect(bookingMonth({ ...payments[6], description: "Sonderzahlung Bonus" })).toBe("2026-11");
    expect(classify({ ...payments[0], category: "Transfer intern", categoryOverride: true }).isTransfer).toBe(true);
    expect(classify({ ...payments[0], category: "Shopping", categoryOverride: true }).category).toBe("Shopping");
  });
  it("ignores an obsolete learned employer salary rule but preserves the payroll role", () => {
    const state = stateForTest();
    state.merchantRules = [{ key: merchantRuleKey(payments[0]), category: "Gehalt" }];
    expect(applyMerchantRules(state, [payments[0]])[0].category).toBe("Rufbereitschaft");
    const saved = importRows(state, payments);
    expect(actualBookings(saved)).toHaveLength(payments.length);
    expect(saved.reviewQueue).toEqual([]);
    expect(saved.financeRows).toEqual(state.financeRows);
    expect(actualBookings(importRows(saved, payments))).toHaveLength(payments.length);
    expect(calculateDashboard(saved).timeline.find((month) => month.month === "2026-03")?.received).toBe(3475.38);
  });
  it("repairs legacy receipt categories without duplicating the existing transaction", () => {
    const state = stateForTest();
    const booking = { ...payments[0], categoryOverride: true };
    state.transactions = [booking];
    state.fixedReceipts = [{ key: statementFingerprint(booking), booking, category: "Gehalt", amount: booking.amount,
      date: booking.date, rowId: "salary", merchantKey: merchantRuleKey(booking) }];
    const saved = queueLedgerReview(state);
    expect(saved.transactions[0]).toMatchObject({ id: booking.id, amount: 548.16, category: "Rufbereitschaft" });
    expect(saved.fixedReceipts![0]).toMatchObject({ amount: 548.16, category: "Rufbereitschaft", rowId: "on-call" });
    expect(actualBookings(saved)).toHaveLength(1);
    expect(saved.reviewQueue).toEqual([]);
    expect(actualBookings(importRows(saved, [booking]))).toHaveLength(1);
  });
  it("migrates old salary fixed reviews on reload, preserves facts and keeps leasing review", async () => {
    const state = stateForTest();
    const leasing: Transaction = { ...payments[0], id: "lease", amount: -300, description: "Porsche Bank", category: "Leasing" };
    state.reviewQueue = [...payments.slice(0, 4), leasing].map((booking) => ({ kind: "fixed", id: `change-${booking.id}`, change: {
      id: `change-${booking.id}`, category: booking.category, month: booking.date.slice(0, 7), previous: 2442.56,
      amount: Math.abs(booking.amount), bookings: [booking],
    } }));
    state.fixedAmountDecisions = [{ category: "Gehalt", merchantKey: merchantRuleKey(payments[0]), amount: 548.16, month: "2026-01", accept: true }];
    const saved = queueLedgerReview(appStateSchema.parse(JSON.parse(JSON.stringify(state))));
    expect(saved.reviewQueue).toHaveLength(1);
    expect(saved.reviewQueue![0]).toMatchObject({ kind: "fixed", change: { category: "Leasing" } });
    expect(saved.transactions.map(({ id, date, amount, description }) => ({ id, date, amount, description }))).toEqual(
      payments.slice(0, 4).map(({ id, date, amount, description }) => ({ id, date, amount, description })),
    );
    expect(saved.transactions[0].category).toBe("Rufbereitschaft");
    expect(saved.financeRows).toEqual(state.financeRows);
    expect(queueLedgerReview(saved)).toEqual(saved);
    const restored = queueLedgerReview((await parseWorkbook(await exportWorkbook(saved))).state);
    expect(restored.transactions).toEqual(saved.transactions);
    expect(restored.financeRows.filter((row) => row.kind !== "variable")).toEqual(saved.financeRows);
    expect(actualBookings(importRows(restored, payments.slice(0, 4)))).toHaveLength(4);
  });
});
