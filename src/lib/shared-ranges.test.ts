import { describe, expect, it } from "vitest";
import { actualBookings, calculateDashboard, calculatePlan, classify } from "@/lib/calc";
import { appStateSchema, holidayRangeSchema, type Transaction } from "@/lib/types";
import { createSeed } from "@/lib/seed";
import { personalAmount, reconcileSharedHoliday, selectSharedBookings } from "@/lib/shared-holiday";
import { refreshPlanning, synchronizePlan } from "@/lib/planning";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { commitStatementImport, queueLedgerReview } from "@/lib/import/review";

const booking = (id: string, description: string, amount = -100, date = "2026-08-05", category: Transaction["category"] = "Lebensmittel"): Transaction =>
  ({ id, description, amount, date, category, categoryOverride: true, includeInPlan: true, bank: "Revolut", pocket: null });
const fixture = (transactions: Transaction[]) => {
  const state = createSeed();
  state.transactions = transactions;
  state.settings.asOf = "2026-09-15";
  state.financeRows = [];
  return state;
};

describe("selected shared costs", () => {
  it.each(["Swiss", "Booking.com", "Airbnb", "BILLA", "Sakura"])("never automatically halves %s", (merchant) => {
    const row = booking("one", merchant);
    expect(personalAmount(row)).toBe(-100);
    expect(reconcileSharedHoliday([row]).receivables).toEqual([]);
  });
  it("keeps the personal half in the original everyday category and history after manual payment", () => {
    let state = fixture([booking("july", "BILLA", -100, "2026-07-05"), booking("aug", "BILLA"), booking("sep", "BILLA", -100, "2026-09-05")]);
    state = selectSharedBookings(state, ["july", "aug", "sep"]);
    const before = calculateDashboard(state);
    expect(before.current.actualSpending).toBe(50);
    expect(before.spending).toEqual([{ name: "Lebensmittel", value: 50 }]);
    expect(before.plan.rows.find((row) => row.category === "Lebensmittel")?.total).toBe(250);
    expect(calculatePlan(state.transactions, state.settings.asOf).byCategory).toEqual([{ category: "Lebensmittel", total: 57.5 }]);
    state = selectSharedBookings(state, ["sep"], true);
    expect(calculateDashboard(state)).toEqual(before);
    expect(state.transactions[2].amount).toBe(-100);
    expect(reconcileSharedHoliday(state.transactions).receivables.find((item) => item.bookingId === "sep")).toMatchObject({ status: "Bezahlt", outstanding: 0 });
  });
  it.each(["Raphael", "PIBER", "Überweisung Piber, Raphael"])("matches %s with the larger of 5 EUR or 3 percent", (name) => {
    const row = { ...booking("share", "Sakura", -1000), sharedWithRaphael: true };
    for (const amount of [485, 515]) {
      const result = reconcileSharedHoliday([row, booking("in", name, amount)]);
      expect(result.receivables[0]).toMatchObject({ status: "Bezahlt", repaymentId: "in" });
      expect(personalAmount(result.bookings[1])).toBe(0);
    }
    expect(reconcileSharedHoliday([row, booking("in", name, 515.01)]).receivables[0].status).toBe("Offen");
    const small = { ...row, amount: -80 };
    expect(reconcileSharedHoliday([small, booking("in", name, 45)]).receivables[0].status).toBe("Bezahlt");
    expect(reconcileSharedHoliday([small, booking("in", name, 45.01)]).receivables[0].status).toBe("Offen");
  });
  it("uses the oldest matching open item rather than the closest amount, without reusing a transfer", () => {
    const older = { ...booking("older", "Sakura", -408, "2026-07-01"), sharedWithRaphael: true };
    const newer = { ...booking("newer", "Sakura", -400), sharedWithRaphael: true };
    const incoming = booking("in", "Raphael", 200);
    const result = reconcileSharedHoliday([newer, incoming, older]);
    expect(result.receivables.map((item) => item.status)).toEqual(["Bezahlt", "Offen"]);
    expect(result.bookings[1].holidayReimbursementFor).toBe("older");
    expect(reconcileSharedHoliday([{ ...older, sharedPaidManually: true }, newer, incoming]).bookings[2].holidayReimbursementFor).toBe("newer");
    expect(reconcileSharedHoliday([older, incoming], "2026-08-01").receivables[0].status).toBe("Offen");
  });
  it("keeps matched income out of salary, actual income and plan; restores unmatched booking semantics", () => {
    const share = { ...booking("share", "Sakura", -100, "2026-09-05", "Ausgehen"), sharedWithRaphael: true };
    const payment = booking("in", "Raphael Piber Gehalt", 53, "2026-09-06", "Gehalt");
    let state = fixture([share]);
    const originalFinanceRows = state.financeRows;
    state = queueLedgerReview(commitStatementImport(state, [payment]).state);
    expect(state.financeRows).toEqual(originalFinanceRows);
    expect(state.fixedReceipts ?? []).toEqual([]);
    expect(calculateDashboard(state).current).toMatchObject({ received: 0, income: 0, actualSpending: 50 });
    expect(calculateDashboard(state).plan.rows.some((row) => /raphael/i.test(row.label))).toBe(false);
    const unmatched = reconcileSharedHoliday([share, { ...payment, amount: 70 }]);
    expect(unmatched.receivables[0].status).toBe("Offen");
    expect(personalAmount(unmatched.bookings[1])).toBe(70);
    state.transactions = state.transactions.filter((row) => row.id !== "share");
    expect(personalAmount(actualBookings(state)[0])).toBe(53);
    expect(classify(actualBookings(state)[0]).isTransfer).toBe(false);
  });
});

describe("holiday periods and plan membership", () => {
  const ranges = [{ from: "2026-07-01", to: "2026-07-10" }, { from: "2026-08-01", to: "2026-08-10" }];
  const holidayState = () => ({ ...fixture([
    booking("home", "BILLA", -100, "2026-06-20"),
    booking("home-trip", "BILLA"),
    booking("foreign-july", "Mercado extranjero", -400, "2026-07-05"),
    booking("foreign-aug", "Mercado extranjero", -400),
    booking("restaurant-july", "Coastal Burger", -300, "2026-07-05", "Ausgehen"),
    booking("restaurant-aug", "Coastal Burger", -300, "2026-08-05", "Ausgehen"),
    { ...booking("amazon", "Amazon", -500), categoryOverride: false },
  ]), holidayRanges: ranges });
  it("moves a foreign supermarket and restaurant out of averages, but retains recurring BILLA and excludes Amazon", () => {
    const state = holidayState();
    const original = JSON.stringify(state.transactions);
    const ledger = actualBookings(state);
    expect(classify(ledger.find((row) => row.id === "foreign-aug")!).category).toBe("Urlaub");
    expect(classify(ledger.find((row) => row.id === "home-trip")!).category).toBe("Lebensmittel");
    expect(classify(ledger.find((row) => row.id === "amazon")!)).toMatchObject({ category: "Shopping", includeInPlan: false });
    expect(calculatePlan(state.transactions, state.settings.asOf, state.holidayRanges).byCategory).toEqual([{ category: "Lebensmittel", total: 55 }]);
    expect(calculateDashboard(state).plan.rows.find((row) => row.category === "Lebensmittel")?.total).toBe(250);
    expect(calculateDashboard(state).timeline.find((row) => row.month === "2026-08")?.actualSpending).toBe(1300);
    expect(JSON.stringify(state.transactions)).toBe(original);
    expect(calculatePlan(state.transactions, state.settings.asOf).byCategory.find((row) => row.category === "Lebensmittel")!.total).toBeGreaterThan(55);
  });
  it.each(["Leasing", "Versicherungen", "Telefon & Internet", "Abonnements", "Bankgebühren", "Gehalt", "Rufbereitschaft"] as const)("never moves %s into Urlaub", (category) => {
    const row = booking("fixed", "Vertrag", category === "Gehalt" || category === "Rufbereitschaft" ? 1000 : -100, "2026-08-05", category);
    expect(classify(actualBookings({ ...fixture([row]), holidayRanges: ranges })[0]).category).toBe(category);
  });
  it("does not merge an unrelated foreign restaurant with a recurring home burger merchant", () => {
    const state = holidayState();
    state.transactions.push(booking("home-burger", "Home Burger", -100, "2026-06-20", "Ausgehen"));
    expect(classify(actualBookings(state).find((row) => row.id === "restaurant-aug")!).category).toBe("Urlaub");
  });
  it("re-evaluates recurrence after import, save and load, and reverses the derived category on range deletion", () => {
    let state = synchronizePlan(holidayState());
    expect(state.financeRows.find((row) => row.planCategory === "Lebensmittel")?.values["2026-09"]).toBe(250);
    state = refreshPlanning(appStateSchema.parse(JSON.parse(JSON.stringify(state))), "2026-09-15");
    expect(calculateDashboard(state).plan.rows[0].total).toBe(250);
    const imported = commitStatementImport(state, [booking("home-new", "Mercado extranjero", -100, "2026-09-12")]).state;
    expect(classify(actualBookings(refreshPlanning(imported, "2026-09-15")).find((row) => row.id === "foreign-aug")!).category).toBe("Lebensmittel");
    state.holidayRanges = [];
    expect(classify(actualBookings(state).find((row) => row.id === "foreign-aug")!).category).toBe("Lebensmittel");
  });
  it("rejects reversed, invalid, overlapping, and longer-than-25-day periods", () => {
    expect(holidayRangeSchema.safeParse({ from: "2026-07-01", to: "2026-07-25" }).success).toBe(true);
    for (const range of [{ from: "2026-07-01", to: "2026-07-26" }, { from: "2026-07-02", to: "2026-07-01" }, { from: "2026-02-30", to: "2026-03-01" }])
      expect(holidayRangeSchema.safeParse(range).success).toBe(false);
    expect(appStateSchema.safeParse({ ...fixture([]), holidayRanges: ranges }).success).toBe(true);
    expect(appStateSchema.safeParse({ ...fixture([]), holidayRanges: [ranges[0], ranges[0]] }).success).toBe(false);
  });
  it("never leaks explicitly tagged Urlaub, Eventim, Amazon or unknown POS into everyday averages", () => {
    const rows = ["2026-07-05", "2026-08-05"].flatMap((date) => [
      booking(`${date}-trip`, "Sakura", -100, date, "Urlaub"),
      booking(`${date}-hotel`, "Booking.com", -100, date),
      booking(`${date}-ticket`, "Eventim", -100, date, "Entertainment"),
      booking(`${date}-amazon`, "Amazon", -100, date),
      booking(`${date}-pos`, "POS 100,00 AT D1 05.07. 12:00", -100, date),
      booking(`${date}-pocket`, "Auszahlung bei Pocket Urlaub", -100, date),
    ]);
    expect(calculatePlan(rows, "2026-09-15").total).toBe(0);
    expect(classify(rows[4]).category).toBe("Prüfen");
  });
  it("round-trips periods, explicit halves and manual status through Excel, including receipt-only charges", async () => {
    let state = holidayState();
    state = selectSharedBookings(state, ["foreign-aug"], true) as typeof state;
    state.fixedReceipts = [{ key: "receipt", date: "2026-08-05", category: "Abonnements", amount: -20, booking: booking("fixed", "Netflix", -20, "2026-08-05", "Abonnements") }];
    state = selectSharedBookings(state, ["receipt"]) as typeof state;
    const loaded = (await parseWorkbook(await exportWorkbook(state))).state;
    expect(loaded.holidayRanges).toEqual(ranges);
    expect(loaded.transactions).toEqual(appStateSchema.parse(state).transactions);
    expect(personalAmount(actualBookings(loaded).find((row) => row.id === "receipt")!)).toBe(-10);
    expect(reconcileSharedHoliday(loaded.transactions).receivables[0]).toMatchObject({ status: "Bezahlt", ownSpend: 200 });
    expect(calculateDashboard(loaded).plan).toEqual(calculateDashboard(state).plan);
  });
});
