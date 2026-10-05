import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { createSeed } from "./seed";
import { calculateDashboard, calculateMonthTotals, actualBookings } from "./calc";
import { amexFunding } from "./amex-balance";
import { exportWorkbook, parseWorkbook } from "./excel";
import { refreshPlanning } from "./planning";
import { monthlyVariableBudget } from "./variable-budgets";
import { matchPlannedOneOffs } from "./planned-one-offs";
import { appStateSchema, type AppState, type Transaction } from "./types";
import { legacyFingerprint } from "./import/identity";

const booking = (id: string, amount: number, patch: Partial<Transaction> = {}): Transaction => ({
  id, date: "2026-09-25", bank: "Amex", pocket: "Amex", description: `Kauf ${id}`,
  amount, category: "Shopping", includeInPlan: false, categoryOverride: true, ...patch,
});
function fixture(transactions: Transaction[] = [], reserved = 0): AppState {
  const seed = createSeed();
  return {
    ...seed, settings: { ...seed.settings, asOf: "2026-10-05" },
    transactions, fixedReceipts: [], savingsGoals: [], plannedOneOffs: [], plannedOneOffsSeeded: true,
    accountSnapshots: [{ bank: "Revolut", name: "AMEX", balance: reserved, date: "2026-09-30" }],
    financeRows: [{ id: "income", kind: "income", label: "Gehalt", values: { "2026-10": 3000, "2026-11": 3000 } }],
  };
}
function funding(state: AppState) {
  const bookings = actualBookings(state);
  return amexFunding(state, bookings, matchPlannedOneOffs(state.plannedOneOffs, bookings));
}

describe("Amex funding gap", () => {
  it("subtracts the available Amex reserve from net imported charges, then reduces surplus once", () => {
    const state = fixture([booking("one", -1000), booking("two", -619.19), booking("credit", 112.70)], 500);
    const d = calculateDashboard(state);
    expect(d.amex).toEqual({
      outstanding: 1506.49, ownOutstanding: 1506.49, reserved: 500,
      shortfall: 1006.49, plannedCoverage: 0, additional: 1006.49,
    });
    expect(d.current.amexOpen).toBe(1006.49);
    const budget = monthlyVariableBudget("2026-10").total;
    expect(d.current.variablePlan).toBe(budget + 1006.49);
    expect(d.current.surplus).toBe(3000 - budget - 1006.49);
    expect(d.timeline.find((row) => row.month === "2026-11")?.amexOpen).toBe(0);
    expect(d.ninetyDays[0].surplus).toBe(d.current.surplus);
    expect(d.monthlyFunding.find((item) => item.id === "savings")?.amount).toBe(d.current.surplus);
    expect(calculateMonthTotals(state, "2026-10", d.plan).surplus).toBe(d.current.surplus);
  });

  it("does not turn excess reserves or credits into income", () => {
    expect(funding(fixture([booking("purchase", -100)], 200))).toMatchObject({ additional: 0, shortfall: 0 });
    expect(funding(fixture([booking("credit", 200), booking("purchase", -100, { date: "2026-10-01" })]))).toMatchObject({
      outstanding: 0, ownOutstanding: 0, additional: 0,
    });
  });

  it("allows an uncovered bill to make surplus negative rather than promising savings that are not available", () => {
    const state = fixture([booking("large", -4000)]);
    const d = calculateDashboard(state);
    expect(d.current.surplus).toBe(-1000 - monthlyVariableBudget("2026-10").total);
    expect(d.monthlyFunding).toEqual([]);
  });

  it("uses the latest closing reserve plus later movements, not snapshot totals or already included transfers", () => {
    const state = fixture([
      booking("purchase", -1000),
      booking("included", 500, { bank: "Revolut", pocket: "AMEX", date: "2026-09-30", category: "Transfer intern" }),
      booking("top-up", 100, { bank: "Revolut", pocket: "Amex", date: "2026-10-01", category: "Transfer intern" }),
      booking("withdrawal", -50, { bank: "Revolut", pocket: "AMEX", date: "2026-10-02", category: "Transfer intern", description: "Auszahlung bei Pocket" }),
      booking("future", 900, { bank: "Revolut", pocket: "AMEX", date: "2026-10-06", category: "Transfer intern" }),
      booking("other", 900, { bank: "Revolut", pocket: "Sparkonto", date: "2026-10-01", category: "Transfer intern" }),
    ], 500);
    state.accountSnapshots!.push(
      { bank: "Revolut", name: "Amex", balance: 999, date: "2026-09-01" },
      { bank: "Revolut", name: "AMEX", balance: 9999, date: "2026-10-06" },
    );
    expect(funding(state)).toMatchObject({ outstanding: 1000, reserved: 550, additional: 450 });
    state.accountSnapshots = [];
    expect(funding(state).reserved).toBe(550);
  });

  it("uses the personal half for shared costs and keeps Raphael's own card out of personal surplus", () => {
    const state = fixture([
      booking("shared", -400, { sharedWithRaphael: true }),
      booking("raphael", -100, { pocket: "AMEX Raphael" }),
      booking("mine", -55),
      booking("repaid-half", 200, { bank: "Raiffeisen", pocket: "Giro", date: "2026-10-01", description: "Raphael Piber" }),
    ], 100);
    expect(funding(state)).toMatchObject({ outstanding: 555, ownOutstanding: 255, reserved: 100, additional: 155 });
  });

  it("recognizes real repayments, but not transfers into the reserve, and never settles one payment twice", () => {
    const state = fixture([
      booking("old", -800, { date: "2026-09-02" }),
      booking("bank-payment", -800, { bank: "Raiffeisen", pocket: "Giro", date: "2026-09-15", description: "American Express Europe S.A.", category: "Transfer intern" }),
      booking("card-payment", 800, { date: "2026-09-16", description: "ZAHLUNG/ÜBERWEISUNG ERHALTEN", category: "Transfer intern" }),
      booking("current", -300, { date: "2026-10-01" }),
      booking("top-up", 100, { bank: "Revolut", pocket: "Amex", date: "2026-10-02", description: "Um EUR Amex einzustecken", category: "Transfer intern" }),
      booking("top-up-source", -100, { bank: "Revolut", pocket: "Hauptkonto", date: "2026-10-02", description: "Um EUR Amex einzustecken", category: "Transfer intern" }),
    ]);
    expect(funding(state)).toMatchObject({ outstanding: 300, reserved: 100, additional: 200 });
    state.transactions = state.transactions.filter((row) => row.id !== "card-payment");
    expect(funding(state).additional).toBe(200);
    state.transactions.push(booking("settle-rest", -300, { bank: "Raiffeisen", date: "2026-10-03", description: "Amex Abrechnung", category: "Transfer intern" }));
    expect(funding(state).additional).toBe(0);
  });

  it("does not carry old payments for missing statements forward to erase new purchases", () => {
    const state = fixture([
      booking("prior-payment", -1200, { date: "2026-09-15", bank: "Raiffeisen", description: "American Express Europe", category: "Transfer intern" }),
      booking("current", -500, { date: "2026-10-01" }),
      booking("future-purchase", -5000, { date: "2026-10-06" }),
    ]);
    expect(funding(state).additional).toBe(500);
  });

  it("reduces gross and personal balances correctly for partial payments across the two cardholders", () => {
    const state = fixture([
      booking("raphael", -100, { date: "2026-09-20", pocket: "AMEX Raphael" }),
      booking("shared", -100.02, { date: "2026-09-21", sharedWithRaphael: true }),
      booking("partial", -150, { bank: "Raiffeisen", date: "2026-09-22", description: "Amex Abrechnung", category: "Transfer intern" }),
    ]);
    expect(funding(state)).toMatchObject({ outstanding: 50.02, ownOutstanding: 25.01, additional: 25.01 });
  });

  it("keeps already planned variable spending within the unchanged allowance, adding only the excess", () => {
    const state = fixture([
      booking("grocery", -300, { date: "2026-10-01", description: "BILLA", category: "Lebensmittel", includeInPlan: true }),
    ]);
    expect(funding(state)).toMatchObject({ shortfall: 300, plannedCoverage: 250, additional: 50 });
    const before = state.financeRows;
    const d = calculateDashboard(state);
    expect(state.financeRows).toBe(before);
    expect(d.plan.rows.find((row) => row.id === "food")?.total).toBe(250);
    state.transactions.push(booking("paid-grocery", -50, { bank: "Raiffeisen", date: "2026-10-02", description: "BILLA", category: "Lebensmittel", includeInPlan: true }));
    expect(funding(state)).toMatchObject({ plannedCoverage: 200, additional: 100 });
  });

  it("does not consume an allowance for refunded card spending", () => {
    const state = fixture([
      booking("grocery", -300, { date: "2026-10-01", description: "BILLA", category: "Lebensmittel", includeInPlan: true }),
      booking("refund", 100, { date: "2026-10-02", description: "BILLA", category: "Lebensmittel", includeInPlan: true }),
    ]);
    expect(funding(state)).toMatchObject({ ownOutstanding: 200, plannedCoverage: 200, additional: 0 });
  });

  it("restores budget capacity for a refund of a paid bank purchase, independently of import order", () => {
    const rows = [
      booking("paid", -100, { bank: "Raiffeisen", date: "2026-10-01", description: "BILLA", category: "Lebensmittel", includeInPlan: true }),
      booking("refund", 100, { bank: "Raiffeisen", date: "2026-10-02", description: "BILLA", category: "Lebensmittel", includeInPlan: true }),
      booking("card", -250, { date: "2026-10-03", description: "BILLA", category: "Lebensmittel", includeInPlan: true }),
    ];
    expect(funding(fixture(rows))).toMatchObject({ plannedCoverage: 250, additional: 0 });
    expect(funding(fixture(rows.reverse()))).toMatchObject({ plannedCoverage: 250, additional: 0 });
  });

  it.each([100, 400])("matches a %s EUR refund to the shared merchant instead of a preceding personal purchase", (refund) => {
    const state = fixture([
      booking("personal", -100, { description: "Persoenlicher Laden", date: "2026-09-25" }),
      booking("shared", -400, { description: "Gemeinsamer Laden", date: "2026-09-26", sharedWithRaphael: true }),
      booking("refund", refund, { description: "Gemeinsamer Laden", date: "2026-09-27" }),
    ]);
    expect(funding(state)).toMatchObject({ outstanding: 500 - refund, ownOutstanding: 300 - refund / 2 });
  });

  it("does not invent a card liability when a refund of a settled shared purchase covers the bill", () => {
    const state = fixture([
      booking("shared", -400, { description: "Gemeinsamer Laden", date: "2026-09-25", sharedWithRaphael: true }),
      booking("settled", -400, { bank: "Raiffeisen", description: "Amex Abrechnung", date: "2026-09-26", category: "Transfer intern" }),
      booking("refund", 400, { description: "Gemeinsamer Laden", date: "2026-09-27" }),
      booking("personal", -300, { description: "Persoenlicher Laden", date: "2026-09-28" }),
    ]);
    expect(funding(state)).toMatchObject({ outstanding: 0, ownOutstanding: 0, additional: 0 });
  });

  it("does not count fixed costs and matched one-offs twice, including shared halves", () => {
    const state = fixture([
      booking("fee", -65, { date: "2026-10-01", description: "Monatsgebühr", category: "AMEX Monatsgebühr" }),
      booking("cabinet", -400, { date: "2026-10-02", sharedWithRaphael: true }),
    ]);
    state.financeRows.push({ id: "fee", kind: "fixed", label: "AMEX Monatsgebühr", planCategory: "AMEX Monatsgebühr", values: { "2026-10": 65 } });
    state.plannedOneOffs = [{ id: "cabinet", name: "Schrank", date: "2026-10-02", amount: 400, pocket: "Giro", installments: 1, sharedWithRaphael: true }];
    expect(funding(state)).toMatchObject({ ownOutstanding: 265, plannedCoverage: 265, additional: 0 });
    const d = calculateDashboard(state);
    expect(d.current.fixed).toBe(65);
    expect(d.current.plannedOneOffs).toBe(200);
    expect(d.current.amexOpen).toBe(0);
  });

  it("includes Amex fixed receipts in the liability exactly once when their ledger booking is also present", () => {
    const row = booking("fee", -65, { date: "2026-10-01", description: "Monatsgebühr", category: "Bankgebühren" });
    const state = fixture([row]);
    const key = legacyFingerprint(row);
    state.fixedReceipts = [{ key, date: row.date, amount: row.amount, category: row.category, booking: row }];
    state.financeRows.push({ id: "fee", kind: "fixed", label: "AMEX Monatsgebühr", values: { "2026-10": 65 } });
    expect(funding(state)).toMatchObject({ outstanding: 65, ownOutstanding: 65, additional: 0 });
    state.transactions = [];
    expect(funding(state)).toMatchObject({ outstanding: 65, ownOutstanding: 65, additional: 0 });
  });

  it("counts unresolved and manually excluded card purchases as liabilities without changing their classification", () => {
    const state = fixture([booking("unknown", -42, { category: "Prüfen", date: "2026-10-01" })]);
    expect(funding(state).additional).toBe(42);
    expect(state.transactions[0].category).toBe("Prüfen");
  });

  it("derives the same gap after synchronization, storage and Excel restore without persisting a second plan row", async () => {
    const state = refreshPlanning(fixture([booking("purchase", -500)], 125), "2026-10-05");
    const original = calculateDashboard(state);
    const saved = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(calculateDashboard(saved).amex).toEqual(original.amex);
    const buffer = await exportWorkbook(saved);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet("Finanzen 2026")!;
    const line = sheet.getRows(1, sheet.rowCount)!.find((row) => row.getCell(2).value === "Amex offen")!;
    expect(line.getCell(1).value).toBe("calc");
    expect(line.getCell(12).value).toBe(375);
    const restored = (await parseWorkbook(buffer)).state;
    expect(calculateDashboard(restored).amex).toEqual(original.amex);
    expect(calculateDashboard(restored).current.surplus).toBe(original.current.surplus);
    expect(restored.financeRows.filter((row) => row.kind === "variable")).toHaveLength(7);
    expect(restored.transactions).toEqual(state.transactions);
  });
});
