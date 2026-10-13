import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { createSeed } from "./seed";
import { calculateDashboard, calculateMonthTotals, actualBookings } from "./calc";
import { amexFunding } from "./amex-balance";
import { exportWorkbook, parseWorkbook } from "./excel";
import { refreshPlanning } from "./planning";
import { monthlyVariableBudget } from "./variable-budgets";
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
  return amexFunding(state, bookings);
}

describe("Amex funding gap", () => {
  it("uses the 1619.19 EUR current bill instead of accumulating historical statements, then deducts halves and repayment reserve", () => {
    const state = fixture([
      booking("historical", -7650.34, { date: "2026-08-15", sharedWithRaphael: true }),
      booking("ikea", -207.82, { date: "2026-10-02", description: "IKEA Klagenfurt", sharedWithRaphael: true }),
      booking("airbnb", -126, { date: "2026-10-03", description: "Airbnb", sharedWithRaphael: true }),
      booking("tapeso", -164.9, { date: "2026-10-02", description: "Mollie Tapeso", sharedWithRaphael: true }),
    ]);
    state.amexBalanceSnapshots = [{ periodStart: "2026-09-11", date: "2026-10-05", balance: 1619.19 }];
    state.accountSnapshots = [{ bank: "Revolut", name: "Amex Rückzahlung", date: "2026-10-04", balance: 954 }];
    const before = structuredClone(state);
    expect(funding(state)).toMatchObject({
      outstanding: 1619.19, ownOutstanding: 1369.83, reserved: 954, shortfall: 415.83, additional: 415.83,
    });
    expect(calculateDashboard(state).current.amexOpen).toBe(415.83);
    expect(state).toEqual(before);
  });

  it("subtracts only current Raphael card spending, not old shared payments or other Revolut pockets", () => {
    const state = fixture([
      booking("old-shared", -500, { date: "2026-08-15", sharedWithRaphael: true }),
      booking("raphael", -50, { date: "2026-09-25", pocket: "AMEX Raphael" }),
      booking("shared", -100, { date: "2026-09-26", sharedWithRaphael: true }),
    ]);
    state.amexBalanceSnapshots = [{ periodStart: "2026-09-11", date: "2026-10-05", balance: 300 }];
    state.accountSnapshots = [
      { bank: "Revolut", name: "Amex Rückzahlung (EUR)", date: "2026-10-03", balance: 75 },
      { bank: "Revolut", name: "Sparkonto", date: "2026-10-04", balance: 999 },
      { bank: "Revolut", name: "Amex Raphael", date: "2026-10-04", balance: 999 },
    ];
    expect(funding(state)).toMatchObject({ outstanding: 300, ownOutstanding: 200, reserved: 75, additional: 125 });
    state.accountSnapshots[0].balance = 500;
    expect(funding(state).additional).toBe(0);
  });

  it("applies payments and new charges only after a captured balance, deduping a bank/card repayment pair", () => {
    const state = fixture([
      booking("historic", -9999, { date: "2026-08-01" }),
      booking("shared", -200, { date: "2026-09-25", sharedWithRaphael: true }),
      booking("covered-payment", -999, { date: "2026-09-30", bank: "Raiffeisen", description: "American Express Europe" }),
      booking("bank-payment", -100, { date: "2026-10-03", bank: "Raiffeisen", description: "Amex Abrechnung" }),
      booking("card-payment", 100, { date: "2026-10-04", description: "ZAHLUNG/ÜBERWEISUNG ERHALTEN" }),
      booking("new", -20, { date: "2026-10-05" }),
    ]);
    state.amexBalanceSnapshots = [
      { periodStart: "2026-08-11", date: "2026-09-01", balance: 9999 },
      { periodStart: "2026-09-11", date: "2026-10-02", balance: 200 },
      { periodStart: "2026-10-11", date: "2026-10-12", balance: 9000 },
    ];
    expect(funding(state)).toMatchObject({ outstanding: 120, ownOutstanding: 70, additional: 70 });
  });

  it("keeps a header credit available for later purchases and uses each snapshot only once", () => {
    const state = fixture([booking("new", -20, { date: "2026-10-05" })]);
    state.amexBalanceSnapshots = [{ periodStart: "2026-09-11", date: "2026-10-02", balance: -10 }];
    expect(funding(state)).toMatchObject({ outstanding: 10, ownOutstanding: 10, additional: 10 });
    state.amexBalanceSnapshots.push({ periodStart: "2026-09-11", date: "2026-10-05", balance: 10 });
    expect(funding(state).outstanding).toBe(10);
  });

  it.each([
    ["2026-10-01", "2026-10-03", "2026-10-02"],
    ["2026-10-03", "2026-10-01", "2026-10-02"],
    ["2026-09-10", "2026-09-12", "2026-09-11"],
  ])("does not deduct a repayment twice across the captured balance: bank %s, card %s, snapshot %s", (bankDate, cardDate, captureDate) => {
    const state = fixture([
      booking("purchase", -200, { date: "2026-09-11" }),
      booking("bank-payment", -100, { date: bankDate, bank: "Raiffeisen", description: "Amex Abrechnung" }),
      booking("card-payment", 100, { date: cardDate, description: "ZAHLUNG/ÜBERWEISUNG ERHALTEN" }),
    ]);
    state.amexBalanceSnapshots = [{ periodStart: "2026-09-11", date: captureDate, balance: 100 }];
    expect(funding(state)).toMatchObject({ outstanding: 100, ownOutstanding: 100, additional: 100 });
  });

  it("retains overpayments after an authoritative balance as credit for subsequent purchases", () => {
    const state = fixture([
      booking("settlement", -150, { date: "2026-10-03", bank: "Raiffeisen", description: "Amex Abrechnung" }),
      booking("purchase", -75, { date: "2026-10-04" }),
    ]);
    state.amexBalanceSnapshots = [{ periodStart: "2026-09-11", date: "2026-10-02", balance: 100 }];
    expect(funding(state)).toMatchObject({ outstanding: 25, ownOutstanding: 25, additional: 25 });
  });

  it.each([
    { pocket: "Amex Raphael" },
    { sharedWithRaphael: true },
    { pocket: "Amex" },
  ])("does not reuse exhausted captured account credit for a later personal purchase: %j", (patch) => {
    const state = fixture([
      booking("first", -100, { date: "2026-10-03", ...patch }),
      booking("personal", -100, { date: "2026-10-04" }),
    ]);
    state.amexBalanceSnapshots = [{ periodStart: "2026-09-11", date: "2026-10-02", balance: -100 }];
    expect(funding(state)).toMatchObject({ outstanding: 100, ownOutstanding: 100, additional: 100 });
  });

  it("reduces a partial captured balance with later Raphael refunds and carries excess credit across cardholders", () => {
    const state = fixture([
      booking("refund", 20, { date: "2026-10-03", pocket: "Amex Raphael" }),
    ]);
    state.amexBalanceSnapshots = [{ periodStart: "2026-09-11", date: "2026-10-02", balance: 100 }];
    expect(funding(state)).toMatchObject({ outstanding: 80, ownOutstanding: 80, additional: 80 });
    state.transactions[0].amount = 120;
    state.transactions.push(booking("purchase", -75, { date: "2026-10-04" }));
    expect(funding(state)).toMatchObject({ outstanding: 55, ownOutstanding: 55, additional: 55 });
  });

  it("subtracts a shared refund from the personal half instead of subtracting it a second time from the header", () => {
    const state = fixture([
      booking("shared", -400, { date: "2026-09-25", description: "IKEA", sharedWithRaphael: true }),
      booking("refund", 100, { date: "2026-09-26", description: "IKEA" }),
    ]);
    state.amexBalanceSnapshots = [{ periodStart: "2026-09-11", date: "2026-10-02", balance: 300 }];
    expect(funding(state)).toMatchObject({ outstanding: 300, ownOutstanding: 150, additional: 150 });
    state.transactions.push(booking("later-refund", 100, { date: "2026-10-04", description: "IKEA" }));
    expect(funding(state)).toMatchObject({ outstanding: 200, ownOutstanding: 100, additional: 100 });
  });

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

  it("shows the complete funding gap without subtracting a variable allowance", () => {
    const state = fixture([
      booking("grocery", -300, { date: "2026-10-01", description: "BILLA", category: "Lebensmittel", includeInPlan: true }),
    ]);
    expect(funding(state)).toMatchObject({ shortfall: 300, plannedCoverage: 0, additional: 300 });
    const before = state.financeRows;
    const d = calculateDashboard(state);
    expect(state.financeRows).toBe(before);
    expect(d.plan.rows.find((row) => row.id === "food")?.total).toBe(250);
    state.transactions.push(booking("paid-grocery", -50, { bank: "Raiffeisen", date: "2026-10-02", description: "BILLA", category: "Lebensmittel", includeInPlan: true }));
    expect(funding(state)).toMatchObject({ plannedCoverage: 0, additional: 300 });
  });

  it("reduces the gap by real refunds, not by a budget allowance", () => {
    const state = fixture([
      booking("grocery", -300, { date: "2026-10-01", description: "BILLA", category: "Lebensmittel", includeInPlan: true }),
      booking("refund", 100, { date: "2026-10-02", description: "BILLA", category: "Lebensmittel", includeInPlan: true }),
    ]);
    expect(funding(state)).toMatchObject({ ownOutstanding: 200, plannedCoverage: 0, additional: 200 });
  });

  it("does not treat a refunded bank purchase as money in the Amex reserve", () => {
    const rows = [
      booking("paid", -100, { bank: "Raiffeisen", date: "2026-10-01", description: "BILLA", category: "Lebensmittel", includeInPlan: true }),
      booking("refund", 100, { bank: "Raiffeisen", date: "2026-10-02", description: "BILLA", category: "Lebensmittel", includeInPlan: true }),
      booking("card", -250, { date: "2026-10-03", description: "BILLA", category: "Lebensmittel", includeInPlan: true }),
    ];
    expect(funding(fixture(rows))).toMatchObject({ plannedCoverage: 0, additional: 250 });
    expect(funding(fixture(rows.reverse()))).toMatchObject({ plannedCoverage: 0, additional: 250 });
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

  it("does not erase unpaid fixed or planned card charges by treating plans as cash reserves", () => {
    const state = fixture([
      booking("fee", -65, { date: "2026-10-01", description: "Monatsgebühr", category: "AMEX Monatsgebühr" }),
      booking("cabinet", -400, { date: "2026-10-02", sharedWithRaphael: true }),
    ]);
    state.financeRows.push({ id: "fee", kind: "fixed", label: "AMEX Monatsgebühr", planCategory: "AMEX Monatsgebühr", values: { "2026-10": 65 } });
    state.plannedOneOffs = [{ id: "cabinet", name: "Schrank", date: "2026-10-02", amount: 400, pocket: "Giro", installments: 1, sharedWithRaphael: true }];
    expect(funding(state)).toMatchObject({ outstanding: 465, ownOutstanding: 265, plannedCoverage: 200, additional: 65 });
    const d = calculateDashboard(state);
    expect(d.current.fixed).toBe(65);
    expect(d.current.plannedOneOffs).toBe(200);
    expect(d.current.amexOpen).toBe(65);
  });

  it("includes Amex fixed receipts in the liability exactly once when their ledger booking is also present", () => {
    const row = booking("fee", -65, { date: "2026-10-01", description: "Monatsgebühr", category: "Bankgebühren" });
    const state = fixture([row]);
    const key = legacyFingerprint(row);
    state.fixedReceipts = [{ key, date: row.date, amount: row.amount, category: row.category, booking: row }];
    state.financeRows.push({ id: "fee", kind: "fixed", label: "AMEX Monatsgebühr", values: { "2026-10": 65 } });
    expect(funding(state)).toMatchObject({ outstanding: 65, ownOutstanding: 65, additional: 65 });
    state.transactions = [];
    expect(funding(state)).toMatchObject({ outstanding: 65, ownOutstanding: 65, additional: 65 });
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

  it("persists captured bill totals in JSON and Excel, including a snapshot without any imported rows", async () => {
    const state = fixture([], 500);
    state.amexBalanceSnapshots = [{ periodStart: "2026-09-11", date: "2026-10-05", balance: 1619.19 }];
    for (const loaded of [appStateSchema.parse(JSON.parse(JSON.stringify(state))), (await parseWorkbook(await exportWorkbook(state))).state]) {
      expect(loaded.amexBalanceSnapshots).toEqual(state.amexBalanceSnapshots);
      expect(funding(loaded)).toMatchObject({ outstanding: 1619.19, additional: 1119.19 });
    }
  });
});
