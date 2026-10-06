import { describe, expect, it } from "vitest";
import { calculateDashboard } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { synchronizeFixedPlan } from "@/lib/fixed-plan";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { statementFingerprint } from "@/lib/import/identity";
import { fixedCostSchedule } from "./fixed-cost-schedule";
import type { AppState, FinanceRow, Transaction } from "./types";

const booking = (id: string, date: string, patch: Partial<Transaction> = {}): Transaction => ({
  id, date, bank: "Raiffeisen", pocket: "Giro", description: "A1 Mobilfunk",
  amount: -20, category: "Telefon & Internet", categoryOverride: true, reviewed: true,
  includeInPlan: false, ...patch,
});
const plan = (id = "phone", label = "Handyvertrag A1", amount = 20): FinanceRow => ({
  id, label, kind: "fixed", values: { "2026-10": amount }, planCategory: "Telefon & Internet",
});
function fixture(transactions: Transaction[] = [], financeRows = [plan()]): AppState {
  const seed = createSeed();
  return { ...seed, settings: { ...seed.settings, asOf: "2026-10-06" },
    transactions, financeRows, fixedReceipts: [], holidayRanges: [],
    savingsGoals: [], plannedOneOffs: [], plannedOneOffsSeeded: true };
}

describe("monthly fixed debit schedule", () => {
  it("shows the remaining month with an estimated debit date, without changing finance data or projected surplus", () => {
    const state = fixture([booking("sep", "2026-09-15")]);
    const before = structuredClone(state);
    const surplus = calculateDashboard(state).current.surplus;
    expect(fixedCostSchedule(state)).toMatchObject({
      month: "2026-10", asOf: "2026-10-06", openTotal: 20, bookedTotal: 0, booked: [],
      open: [{ id: "phone", name: "Handyvertrag A1", planned: 20,
        expectedFrom: "2026-10-15", expectedTo: "2026-10-15", status: "open", account: "Raiffeisen · Girokonto" }],
    });
    expect(state).toEqual(before);
    expect(calculateDashboard(state).current.surplus).toBe(surplus);
  });

  it("marks a current actual charge as booked even if its price differs from the planned monthly rate", () => {
    const state = fixture([booking("sep", "2026-09-15"), booking("oct", "2026-10-02", { amount: -18 })]);
    expect(fixedCostSchedule(state)).toMatchObject({
      open: [], openTotal: 0, bookedTotal: 18,
      booked: [{ bookedDates: ["2026-10-02"], bookedAmount: 18, planned: 20, status: "booked" }],
    });
    state.transactions = state.transactions.filter((row) => row.id !== "oct");
    expect(fixedCostSchedule(state).openTotal).toBe(20);
  });

  it("never treats a future-dated charge as paid or uses it to infer the debit day", () => {
    const state = fixture([booking("future", "2026-10-20"), booking("later-month", "2026-11-15")]);
    expect(fixedCostSchedule(state).open[0]).toMatchObject({ status: "open", bookedDates: [] });
    expect(fixedCostSchedule(state).open[0].expectedFrom).toBeUndefined();
    state.settings.asOf = "2026-10-20";
    expect(fixedCostSchedule(state).booked[0].bookedDates).toEqual(["2026-10-20"]);
  });

  it.each([
    ["2026-10-02", "due"], ["2026-10-06", "unconfirmed"], ["2026-10-01", "open"],
  ] as const)("distinguishes expected today and unconfirmed past dates on %s", (asOf, status) => {
    const state = fixture([booking("sep", "2026-09-02")]);
    state.settings.asOf = asOf;
    expect(fixedCostSchedule(state).open[0].status).toBe(status);
  });

  it("derives a range from the three latest booked months, not an obsolete schedule or future imports", () => {
    const state = fixture([
      booking("old", "2026-05-28"), booking("june", "2026-06-30"),
      booking("july", "2026-07-14"), booking("aug", "2026-08-15"), booking("sep", "2026-09-16"),
      booking("future", "2026-11-30"),
    ]);
    expect(fixedCostSchedule(state).open[0]).toMatchObject({ expectedFrom: "2026-10-14", expectedTo: "2026-10-16" });
  });

  it("projects month-end debits to the actual end of the current month and clamps the 31st in February", () => {
    const state = fixture([booking("aug", "2026-08-31"), booking("sep", "2026-09-30")]);
    expect(fixedCostSchedule(state).open[0]).toMatchObject({ expectedFrom: "2026-10-31", expectedTo: "2026-10-31" });
    state.settings.asOf = "2027-02-06";
    state.financeRows[0].values["2027-02"] = 20;
    state.transactions = [booking("jan", "2027-01-31")];
    expect(fixedCostSchedule(state).open[0]).toMatchObject({ expectedFrom: "2027-02-28", expectedTo: "2027-02-28" });
  });

  it("leaves missing dates unknown and excludes inactive, income and variable plan rows", () => {
    const state = fixture([], [
      plan(), plan("zero", "Zero", 0), { ...plan("stopped"), values: { "2026-09": 20, "2026-10": null } },
      { ...plan("income"), kind: "income" }, { ...plan("variable"), kind: "variable" },
    ]);
    expect(fixedCostSchedule(state).open).toHaveLength(1);
    expect(fixedCostSchedule(state).open[0].expectedFrom).toBeUndefined();
  });

  it("does not mark a different named insurance contract paid merely because its category matches", () => {
    const state = fixture([
      booking("allianz-sep", "2026-09-02", { description: "Allianz", category: "Versicherungen", amount: -65 }),
      booking("allianz-oct", "2026-10-02", { description: "Allianz", category: "Versicherungen", amount: -65 }),
      booking("kasko-sep", "2026-09-15", { description: "Vollkasko", category: "Versicherungen", amount: -50 }),
    ], [
      { ...plan("allianz", "Haftpflicht", 65), planCategory: "Versicherungen" },
      { ...plan("kasko", "Vollkasko", 50), planCategory: "Versicherungen" },
    ]);
    expect(fixedCostSchedule(state)).toMatchObject({
      openTotal: 50, open: [{ id: "kasko", expectedFrom: "2026-10-15" }],
      bookedTotal: 65, booked: [{ id: "allianz" }],
    });
  });

  it("links receipt-only bookings and deduplicates the same ledger entry without losing shared halves", () => {
    const row = booking("oct", "2026-10-02", { sharedWithRaphael: true });
    const state = fixture();
    state.fixedReceipts = [{ key: statementFingerprint(row), date: row.date, amount: row.amount,
      category: row.category, rowId: "phone", booking: row }];
    expect(fixedCostSchedule(state)).toMatchObject({ openTotal: 0, bookedTotal: 10 });
    state.transactions = [row];
    expect(fixedCostSchedule(state)).toMatchObject({ openTotal: 0, bookedTotal: 10 });
    state.transactions[0].fixedCost = false;
    expect(fixedCostSchedule(state)).toMatchObject({ openTotal: 20, booked: [] });
  });

  it("keeps a multi-contract category budget partly open until all its planned amount is booked", () => {
    const state = fixture([
      booking("allianz-sep", "2026-09-02", { description: "Allianz", category: "Versicherungen", amount: -65 }),
      booking("kasko-sep", "2026-09-15", { description: "Vollkasko", category: "Versicherungen", amount: -50 }),
      booking("allianz-oct", "2026-10-02", { description: "Allianz", category: "Versicherungen", amount: -65 }),
    ], [{ ...plan("all-insurance", "Versicherungen", 115), planCategory: "Versicherungen" }]);
    expect(fixedCostSchedule(state)).toMatchObject({
      openTotal: 50, bookedTotal: 65,
      open: [{ openAmount: 50, planned: 115, bookedAmount: 65, expectedFrom: "2026-10-15" }],
      booked: [{ bookedDates: ["2026-10-02"], bookedAmount: 65 }],
    });
    state.transactions.push(booking("kasko-oct", "2026-10-05", { description: "Vollkasko", category: "Versicherungen", amount: -50 }));
    expect(fixedCostSchedule(state)).toMatchObject({ openTotal: 0, open: [], bookedTotal: 115 });
  });

  it("accepts a linked legacy receipt without complete bank metadata", () => {
    const state = fixture();
    state.fixedReceipts = [{ key: "legacy-receipt", date: "2026-10-02", amount: -20,
      category: "Telefon & Internet", rowId: "phone" }];
    expect(fixedCostSchedule(state)).toMatchObject({ open: [], bookedTotal: 20 });
    expect(fixedCostSchedule(state).booked[0].account).toBeUndefined();
  });

  it("honors explicit generated merchant/account links instead of merging unrelated merchants or pockets", () => {
    const sep = booking("marked-sep", "2026-09-15", { description: "Hausverwaltung", category: "Shopping", fixedCost: true });
    const other = booking("other", "2026-10-02", { description: "Anderer Laden", category: "Shopping", fixedCost: true });
    const pocket = booking("other-pocket", "2026-10-02", { description: "Hausverwaltung", category: "Shopping", fixedCost: true, pocket: "Sparkonto" });
    const state = synchronizeFixedPlan(fixture([sep, other, pocket], []));
    expect(fixedCostSchedule(state).open).toHaveLength(1);
    expect(fixedCostSchedule(state).booked).toHaveLength(2);
    expect(fixedCostSchedule(state).open[0].expectedFrom).toBe("2026-10-15");
  });

  it("never uses transfers, refunds, normal unmarked expenses, or pending review drafts as evidence", () => {
    const state = fixture([
      booking("unmarked", "2026-10-02", { fixedCost: false }),
      booking("transfer", "2026-10-02", { description: "Transfer JANNIS BRUEHL", category: "Transfer", fixedCost: true }),
      booking("refund", "2026-10-02", { amount: 20 }),
    ]);
    state.reviewQueue = [{ kind: "booking", id: "pending", draft: booking("pending", "2026-10-02"), message: "Prüfen" }];
    expect(fixedCostSchedule(state)).toMatchObject({ openTotal: 20, bookedTotal: 0, booked: [] });
  });

  it("reconstructs the same schedule after JSON and Excel restoration without storing invented payments", async () => {
    const state = fixture([booking("sep", "2026-09-15"), booking("oct", "2026-10-02")]);
    const expected = fixedCostSchedule(state);
    expect(fixedCostSchedule(JSON.parse(JSON.stringify(state)))).toEqual(expected);
    const restored = await parseWorkbook(await exportWorkbook(state));
    expect(restored.warnings).toEqual([]);
    expect(fixedCostSchedule(restored.state)).toEqual(expected);
    expect(restored.state.transactions).toHaveLength(2);
  });
});
