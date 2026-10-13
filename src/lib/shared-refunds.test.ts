import { describe, expect, it } from "vitest";
import { actualBookings, calculateDashboard, calculateMonthTotals, sum } from "@/lib/calc";
import { decideSharedSettlement, personalAmount, reconcileSharedHoliday, selectSharedBookings } from "@/lib/shared-holiday";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { commitStatementImport } from "@/lib/import/review";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import type { SharedSettlementFields } from "@/lib/shared-refund-schema";

const booking = (id: string, amount: number, patch: Partial<Transaction & SharedSettlementFields> = {}): Transaction & SharedSettlementFields => ({
  id, amount, date: "2026-10-10", description: "Shared shop", bank: "Amex", pocket: "Amex",
  category: "Shopping", categoryOverride: true, includeInPlan: false, ...patch,
});
const purchase = (patch = {}) => booking("purchase", -100, { sharedWithRaphael: true, ...patch });
const fixture = (transactions: Transaction[]): AppState => ({
  ...createSeed(), settings: { ...createSeed().settings, asOf: "2026-10-25" },
  transactions, plannedOneOffs: [], plannedOneOffsSeeded: true, savingsGoals: [], fixedReceipts: [],
  financeRows: [{ id: "salary", kind: "income", label: "Gehalt", values: { "2026-10": 3000 } }],
});

describe("shared merchant refunds", () => {
  it("neutralizes the personal share and partner debt after a complete merchant refund", () => {
    const rows = [purchase(), booking("refund", 100, { date: "2026-10-11" })];
    const result = reconcileSharedHoliday(rows);
    expect(sum(result.bookings.map(personalAmount))).toBe(0);
    expect(result.receivables[0]).toMatchObject({ ownSpend: 0, amount: 0, outstanding: 0, refundedAmount: 100, overpaid: 0 });
    const dashboard = calculateDashboard(fixture(rows));
    expect(dashboard.current.actualSpending).toBe(0);
    expect(dashboard.amex).toMatchObject({ outstanding: 0, ownOutstanding: 0 });
    expect(dashboard.spending).toEqual([{ name: "Shopping", value: 0 }]);
  });

  it("uses cumulative proportional cents for partial returns, including an odd-cent final return", () => {
    const rows = [purchase({ amount: -100.01 }), booking("refund-a", 33.33, { date: "2026-10-11" }),
      booking("refund-b", 33.33, { date: "2026-10-12" }), booking("refund-c", 33.35, { date: "2026-10-13" })];
    const partial = reconcileSharedHoliday(rows, "2026-10-11");
    expect(partial.receivables[0]).toMatchObject({ ownSpend: 33.34, amount: 33.34, outstanding: 33.34 });
    const full = reconcileSharedHoliday(rows);
    expect(full.bookings.filter((row) => row.amount > 0).map(personalAmount)).toEqual([16.67, 16.66, 16.68]);
    expect(sum(full.bookings.map(personalAmount))).toBe(0);
    expect(full.receivables[0]).toMatchObject({ ownSpend: 0, outstanding: 0 });
  });

  it("keeps partner payments separate and preserves refund-induced partner overpayment", () => {
    const rows = [purchase(), booking("payment", 50, { bank: "Raiffeisen", pocket: "Giro", description: "Raphael Piber", categoryOverride: false, date: "2026-10-11" }),
      booking("refund", 100, { date: "2026-10-12" })];
    const result = reconcileSharedHoliday(rows);
    expect(result.bookings[1]).toMatchObject({ holidayReimbursementFor: "purchase" });
    expect(personalAmount(result.bookings[1])).toBe(0);
    expect(result.receivables[0]).toMatchObject({ partnerPaid: 50, overpaid: 50, outstanding: 0, ownSpend: 0 });
    expect(calculateDashboard(fixture(rows)).current.actualSpending).toBe(0);
  });

  it("preserves a manually confirmed payment and its overpayment after a partial refund", () => {
    const result = reconcileSharedHoliday([purchase({ sharedPaidManually: true }), booking("refund", 40, { date: "2026-10-11" })]);
    expect(result.receivables[0]).toMatchObject({ partnerPaid: 50, amount: 30, overpaid: 20, outstanding: 0, ownSpend: 30 });
  });

  it("preserves a partner payment arriving after the merchant refund rather than treating it as income", () => {
    const result = reconcileSharedHoliday([purchase(), booking("refund", 100, { date: "2026-10-11" }),
      booking("payment", 50, { bank: "Raiffeisen", pocket: "Giro", description: "Raphael Piber", categoryOverride: false, date: "2026-10-12" })]);
    expect(personalAmount(result.bookings[2])).toBe(0);
    expect(result.receivables[0]).toMatchObject({ partnerPaid: 50, overpaid: 50, outstanding: 0 });
  });

  it("does not count a confirmed full payment and its linked partial bank evidence twice", () => {
    const result = reconcileSharedHoliday([purchase({ sharedPaidManually: true }),
      booking("payment", 15, { sharedRepaymentFor: "purchase", date: "2026-10-11" })]);
    expect(result.receivables[0]).toMatchObject({ partnerPaid: 50, overpaid: 0, outstanding: 0 });
  });

  it("freezes only the reduced partner amount when manual payment is confirmed after a refund", async () => {
    let state = fixture([purchase(), booking("refund", 40, { date: "2026-10-11" })]);
    state = selectSharedBookings(state, ["purchase"], true);
    expect(state.transactions[0]).toMatchObject({ sharedPaidManually: true, sharedPaidAmount: 30 });
    expect(reconcileSharedHoliday(state.transactions).receivables[0]).toMatchObject({ partnerPaid: 30, overpaid: 0, outstanding: 0 });
    for (const loaded of [appStateSchema.parse(JSON.parse(JSON.stringify(state))), (await parseWorkbook(await exportWorkbook(state))).state]) {
      expect(loaded.transactions[0]).toMatchObject({ sharedPaidAmount: 30 });
      loaded.transactions.push(booking("next-refund", 20, { date: "2026-10-12" }));
      expect(reconcileSharedHoliday(loaded.transactions).receivables[0]).toMatchObject({ partnerPaid: 30, overpaid: 10, outstanding: 0 });
    }
  });

  it("keeps manual confirmation at zero after a full merchant refund", () => {
    const state = selectSharedBookings(fixture([purchase(), booking("refund", 100, { date: "2026-10-11" })]), ["purchase"], true);
    const loaded = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(loaded.transactions[0]).toMatchObject({ sharedPaidManually: true, sharedPaidAmount: 0 });
    expect(reconcileSharedHoliday(loaded.transactions).receivables[0])
      .toMatchObject({ partnerPaid: 0, overpaid: 0, outstanding: 0 });
  });

  it("freezes a receipt-backed reduced share and does not restore the original half on subsequent refunds", () => {
    let state = fixture([booking("refund", 40, { sharedRefundFor: "receipt", date: "2026-10-11" })]);
    state.fixedReceipts = [{ key: "receipt", date: "2026-10-10", amount: -100, category: "Shopping", booking: purchase() }];
    state = selectSharedBookings(state, ["receipt"], true);
    const loaded = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(loaded.fixedReceipts![0].booking).toMatchObject({ sharedPaidManually: true, sharedPaidAmount: 30 });
    loaded.transactions.push(booking("later-refund", 20, { sharedRefundFor: "receipt", date: "2026-10-12" }));
    expect(reconcileSharedHoliday(actualBookings(loaded)).receivables[0])
      .toMatchObject({ partnerPaid: 30, outstanding: 0, overpaid: 10 });
  });

  it("allows explicit partial partner payments without pretending they settle the entire debt", () => {
    const rows = [purchase(), booking("payment", 15, { description: "Raphael Piber", category: "Einkommen", manualCategory: true,
      bank: "Raiffeisen", pocket: "Giro", sharedRepaymentFor: "purchase", date: "2026-10-11" })];
    const result = reconcileSharedHoliday(rows);
    expect(result.receivables[0]).toMatchObject({ partnerPaid: 15, outstanding: 35, status: "Offen" });
    expect(personalAmount(result.bookings[1])).toBe(0);
    expect(calculateDashboard(fixture(rows)).current.received).toBe(0);
    const full = reconcileSharedHoliday([...rows, booking("rest", 35, { description: "Raphael Piber", categoryOverride: false, date: "2026-10-12" })]);
    expect(full.receivables[0]).toMatchObject({ partnerPaid: 50, outstanding: 0, status: "Bezahlt" });
  });

  it("requires a decision when the same merchant has multiple eligible shared or personal purchases", () => {
    const rows = [purchase(), purchase({ id: "other", date: "2026-10-09" }), booking("refund", 50, { date: "2026-10-11" })];
    const unresolved = reconcileSharedHoliday(rows);
    expect(unresolved.refundReviews).toEqual([{ refundId: "refund", candidateIds: ["purchase", "other"], reason: "ambiguous" }]);
    expect(unresolved.receivables.map((row) => row.outstanding)).toEqual([50, 50]);
    const linked = reconcileSharedHoliday(rows.map((row) => row.id === "refund" ? { ...row, sharedRefundFor: "purchase" } : row));
    expect(linked.receivables.find((row) => row.bookingId === "purchase")).toMatchObject({ ownSpend: 25, outstanding: 25 });
    expect(personalAmount(linked.bookings[2])).toBe(25);
    const personal = reconcileSharedHoliday([purchase(), booking("personal", -100), rows[2]]);
    expect(personal.refundReviews).toHaveLength(1);
  });

  it("honors an explicit non-shared decision instead of guessing from a merchant name", () => {
    const state = decideSharedSettlement(fixture([purchase(), booking("refund", 50)]), "refund", null);
    const result = reconcileSharedHoliday(state.transactions);
    expect(result.receivables[0].outstanding).toBe(50);
    expect(personalAmount(result.bookings[1])).toBe(50);
    expect(result.refundReviews).toEqual([]);
  });

  it("never associates a refund with a future charge or a different cardholder without an explicit decision", () => {
    for (const patch of [{ date: "2026-10-09" }, { pocket: "Amex Raphael" }, { description: "Another merchant" }]) {
      const result = reconcileSharedHoliday([purchase(), booking("refund", 50, patch)]);
      expect(result.receivables[0].outstanding).toBe(50);
      expect(personalAmount(result.bookings[1])).toBe(50);
    }
  });

  it("reports invalid explicit links and never applies more returns than the immutable purchase", () => {
    const result = reconcileSharedHoliday([purchase(), booking("refund", 101, { sharedRefundFor: "purchase", date: "2026-10-11" })]);
    expect(result.receivables[0].outstanding).toBe(50);
    expect(result.refundReviews[0]).toMatchObject({ reason: "invalid-link" });
    const unlinked = reconcileSharedHoliday([purchase(), booking("refund", 101, { date: "2026-10-11" })]);
    expect(unlinked.refundReviews[0]).toMatchObject({ reason: "ambiguous", candidateIds: ["purchase"] });
  });

  it("deduplicates repeated stable IDs and derives the same result regardless of import order", () => {
    const shared = purchase();
    const refund = booking("refund", 40, { date: "2026-10-11" });
    const result = reconcileSharedHoliday([shared, refund]);
    expect(reconcileSharedHoliday([refund, shared, refund, shared]).receivables).toEqual(result.receivables);
    expect(reconcileSharedHoliday([shared, refund, shared, refund]).bookings).toHaveLength(2);
    let state = commitStatementImport(fixture([]), [shared, refund]).state;
    state = commitStatementImport(state, [shared, refund]).state;
    expect(state.transactions).toHaveLength(2);
    expect(reconcileSharedHoliday(actualBookings(state)).receivables[0]).toMatchObject({ ownSpend: 30, outstanding: 30 });
  });

  it("preserves explicit refund and partial partner decisions when the original bank rows are reimported", () => {
    const rows = [purchase(), booking("other-purchase", -100), booking("refund", 40, { date: "2026-10-11" }),
      booking("payment", 10, { description: "Raphael Piber", bank: "Raiffeisen", pocket: "Giro", date: "2026-10-12" })];
    let state = commitStatementImport(fixture([]), rows).state;
    state = decideSharedSettlement(state, "refund", "purchase");
    state = decideSharedSettlement(state, "payment", "purchase", "repayment");
    state = commitStatementImport(state, rows).state;
    expect(state.transactions).toHaveLength(4);
    expect(state.transactions.find((row) => row.id === "refund")).toMatchObject({ sharedRefundFor: "purchase" });
    expect(state.transactions.find((row) => row.id === "payment")).toMatchObject({ sharedRepaymentFor: "purchase" });
    const result = reconcileSharedHoliday(state.transactions);
    expect(result.receivables[0]).toMatchObject({ ownSpend: 30, outstanding: 20, partnerPaid: 10 });
  });

  it("accounts later-month refunds in their real month without erasing prior personal spend", () => {
    const rows = [purchase({ date: "2026-09-25" }), booking("refund", 40, { date: "2026-10-11" })];
    const state = fixture(rows);
    expect(calculateMonthTotals(state, "2026-09", { currentMonth: "2026-10" }).actualSpending).toBe(50);
    expect(calculateMonthTotals(state, "2026-10", { currentMonth: "2026-10" }).actualSpending).toBe(-20);
    expect(calculateDashboard(state).amex).toMatchObject({ outstanding: 60, ownOutstanding: 30 });
  });

  it("keeps a later refund in the source purchase's derived holiday category", () => {
    const state = fixture([purchase({ description: "Mercado extranjero", category: "Lebensmittel",
      categoryOverride: false, includeInPlan: true, date: "2026-10-05" }),
    booking("refund", 40, { description: "Mercado extranjero", date: "2026-10-12" })]);
    state.holidayRanges = [{ from: "2026-10-01", to: "2026-10-10" }];
    const dashboard = calculateDashboard(state);
    expect(dashboard.current.actualSpending).toBe(30);
    expect(dashboard.spending).toEqual([{ name: "Urlaub", value: 30 }]);
  });

  it("persists source decisions in JSON and XLSX, including receipt-backed purchases", async () => {
    let state = fixture([purchase(), booking("refund", 40, { description: "Ambiguous refund", date: "2026-10-11" }),
      booking("payment", 10, { description: "Raphael Piber", bank: "Raiffeisen", pocket: "Giro", date: "2026-10-12" })]);
    state = decideSharedSettlement(state, "refund", "purchase");
    state = decideSharedSettlement(state, "payment", "purchase", "repayment");
    for (const loaded of [appStateSchema.parse(JSON.parse(JSON.stringify(state))), (await parseWorkbook(await exportWorkbook(state))).state]) {
      expect(loaded.transactions[1]).toMatchObject({ sharedRefundFor: "purchase" });
      expect(loaded.transactions[2]).toMatchObject({ sharedRepaymentFor: "purchase" });
      expect(calculateDashboard(loaded).current).toMatchObject({ actualSpending: 30, received: 0 });
      expect(reconcileSharedHoliday(loaded.transactions).receivables[0]).toMatchObject({ outstanding: 20 });
    }
    state = fixture([booking("refund", 40, { sharedRefundFor: "receipt", date: "2026-10-11" })]);
    state.fixedReceipts = [{ key: "receipt", date: "2026-10-10", amount: -100, category: "Shopping", booking: purchase() }];
    const loaded = (await parseWorkbook(await exportWorkbook(state))).state;
    expect(actualBookings(loaded).find((row) => row.id === "refund")).toMatchObject({ holidayRefundFor: "receipt", holidayPersonalRefund: 20 });
  });
});
