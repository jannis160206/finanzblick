import { describe, expect, it } from "vitest";
import { actualBookings, bookingMonth, calculateDashboard, calculatePlan, classify, sum } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, transactionSchema, type Transaction } from "@/lib/types";
import { personalAmount, reconcileSharedHoliday, selectSharedBookings } from "@/lib/shared-holiday";
import { commitStatementImport, openReviewCount, prepareStatementImport, queueLedgerReview } from "@/lib/import/review";
import { merchantRuleKey } from "@/lib/import/merchant-rules";
import { parseStatementCsv } from "@/lib/import/statements";

const row = (id: string, description: string, amount = -20, date = "2026-09-13"): Transaction => ({
  id, description, amount, date, bank: "Revolut", pocket: null, category: "Sonstiges", includeInPlan: true,
});

describe("unconditional lunch names", () => {
  it.each(["bIpA", "HOTSPOT", "mEnSa"])("always treats %s as lunch, including Sundays and holidays", (name) => {
    for (const date of ["2026-09-13", "2026-10-10", "2026-10-26"]) {
      for (const time of [undefined, "08:00:00", "12:15:00", "22:00:00"]) {
        const booking = { ...row(name, name, -200, date), time, category: "Transfer intern" as const, categoryOverride: true };
        expect(classify(booking)).toMatchObject({ category: "Mittagessen", isTransfer: false });
        const state = createSeed(); state.transactions = [booking];
        expect(queueLedgerReview(state).reviewQueue).toEqual([]);
      }
    }
  });
  it("keeps other merchants subject to time and the Kärnten calendar", () => {
    const booking = { ...row("billa", "BILLA", -8, "2026-09-14"), time: "12:00:00" };
    expect(classify(booking).category).toBe("Mittagessen");
    for (const changed of [{ date: "2026-09-13" }, { date: "2026-10-26" }, { date: "2026-10-10" }, { time: "14:00:01" }])
      expect(classify({ ...booking, ...changed }).category).toBe("Lebensmittel");
    const state = createSeed(); state.transactions = [{ ...booking, time: undefined, category: "Lebensmittel" }];
    expect(queueLedgerReview(state).reviewQueue).toHaveLength(1);
  });
});

describe("shared travel", () => {
  it.each(["Swiss", "Ryanair", "easyJet", "Booking.com", "Airbnb", "Lufthansa", "Austrian Airlines", "Expedia"])("splits %s into personal spend and a receivable", (name) => {
    const booking = { ...row("travel", name, -401.01), sharedWithRaphael: true };
    const result = reconcileSharedHoliday([booking]);
    expect(result.receivables[0]).toMatchObject({ ownSpend: 200.51, amount: 200.5, outstanding: 200.5 });
    expect(personalAmount(result.bookings[0])).toBe(-200.51);
    expect(result.bookings[0].amount).toBe(-401.01);
    expect(classify(result.bookings[0])).toMatchObject({ category: "Urlaub", includeInPlan: false });
  });
  it("clears a matching later Piber Raphael inbound once and never treats it as income", () => {
    const state = createSeed(); state.settings.asOf = "2026-10-30";
    const travel = { ...row("travel", "Booking.com", -400), sharedWithRaphael: true };
    const repayment = row("repayment", "Überweisung von Raphael Piber Urlaub", 203, "2026-10-20");
    state.transactions = [travel, repayment];
    const original = JSON.stringify(state.transactions);
    const result = reconcileSharedHoliday(state.transactions);
    expect(result.receivables[0]).toMatchObject({ outstanding: 0, repaymentId: "repayment", repaymentAmount: 203 });
    expect(result.bookings[1].holidayReimbursementFor).toBe("travel");
    expect(classify(result.bookings[1])).toMatchObject({ category: "Transfer", includeInPlan: false });
    expect(sum(result.bookings.map(personalAmount))).toBe(-200);
    expect(calculateDashboard(state).current.received).toBe(0);
    expect(calculateDashboard(state).current.actualSpending).toBe(0);
    expect(calculateDashboard(state).timeline.find((item) => item.month === "2026-09")?.actualSpending).toBe(200);
    expect(calculatePlan(state.transactions, state.settings.asOf).rows).toEqual([]);
    expect(JSON.stringify(state.transactions)).toBe(original);
    expect(reconcileSharedHoliday(appStateSchema.parse(JSON.parse(JSON.stringify(state))).transactions).receivables).toEqual(result.receivables);
    expect(reconcileSharedHoliday([travel]).receivables[0].outstanding).toBe(200);
  });
  it("requires a partner name and matching amount after the selected charge", () => {
    const travel = { ...row("travel", "Airbnb", -400), sharedWithRaphael: true };
    for (const incoming of [row("wrong-name", "Other Person", 200), row("early", "Piber Raphael", 200, "2026-09-12"), row("amount", "Piber Raphael", 206.01)])
      expect(reconcileSharedHoliday([travel, incoming]).receivables[0].outstanding).toBe(200);
    const result = reconcileSharedHoliday([travel, { ...row("twin", "Ryanair", -400), sharedWithRaphael: true }, row("repay", "Piber Raphael", 195)]);
    expect(result.receivables.filter((item) => item.outstanding === 0)).toHaveLength(1);
    for (const name of ["BIPA", "Hotspot", "Mensa", "BILLA", "Amazon", "Pizzeria"])
      expect(personalAmount(row(name, name, -400))).toBe(-400);
  });
  it("matches across separate imports in either order, without duplicated expenses", () => {
    for (const reverse of [false, true]) {
      let state = createSeed();
      state.settings.asOf = "2026-10-30";
      const files = ["2026-09-13,Swiss,-400", "2026-10-20,Piber Raphael,200"];
      if (reverse) files.reverse();
      for (const line of [...files, ...files]) {
        const prepared = prepareStatementImport([parseStatementCsv(`Revolut\nDatum,Beschreibung,Betrag\n${line}`)], state);
        state = queueLedgerReview(commitStatementImport(state, prepared.automatic, [], prepared.metadata).state);
        state = queueLedgerReview(selectSharedBookings(state, state.transactions.filter((booking) => booking.description === "Swiss").map((booking) => booking.id)));
      }
      expect(state.reviewQueue).toEqual([]);
      expect(state.transactions).toHaveLength(2);
      expect(reconcileSharedHoliday(actualBookings(state)).receivables[0].outstanding).toBe(0);
      expect(sum(actualBookings(state).map(personalAmount))).toBe(-200);
    }
  });
});

describe("assigned salary month", () => {
  it.each([26, 27, 28, 29, 30])("assigns August %s salary to September only", (day) => {
    const salary = row("pay", "Gehalt", 3000, `2026-08-${day}`);
    const state = createSeed(); state.settings.asOf = "2026-09-14";
    state.transactions = [salary, row("lunch", "BIPA", -8)];
    const ledger = actualBookings(state);
    expect(bookingMonth(salary)).toBe("2026-09");
    expect(sum(ledger.filter((booking) => bookingMonth(booking) === "2026-09").map(personalAmount))).toBe(2992);
    const dashboard = calculateDashboard(state);
    expect(dashboard.current.received).toBe(3000);
    expect(dashboard.timeline.find((month) => month.month === "2026-08")?.received).toBe(0);
  });
  it("handles year boundaries, non-payroll income and statement-only salary receipts", () => {
    expect(bookingMonth(row("year", "Gehalt", 3000, "2026-12-28"))).toBe("2027-01");
    for (const day of [25, 31]) expect(bookingMonth(row("pay", "Gehalt", 3000, `2026-08-${day}`))).toBe("2026-08");
    expect(bookingMonth(row("bonus", "Bonus", 3000, "2026-08-28"))).toBe("2026-08");
    const state = createSeed(); state.settings.asOf = "2026-09-14";
    state.financeRows = [{ id: "salary", label: "Gehalt", kind: "income", values: { "2026-08": 2500, "2026-09": 3000 } }];
    const imported = commitStatementImport(state, [row("pay", "Gehalt", 3000, "2026-08-28")]);
    expect(imported.changes).toEqual([]);
    expect(imported.state.transactions).toEqual([]);
    expect(bookingMonth(actualBookings(imported.state)[0])).toBe("2026-09");
    expect(calculateDashboard(imported.state).current.received).toBe(3000);
  });
});

describe("pedantic ledger review", () => {
  it("counts identical legacy rows separately and resolves both without adding bookings", () => {
    const state = createSeed();
    state.transactions = [row("first", "Identischer Laden"), row("second", "Identischer Laden")];
    const queued = queueLedgerReview(state);
    expect(openReviewCount(queued.reviewQueue ?? [])).toBe(2);
    const resolved = queueLedgerReview(commitStatementImport(queued, [{ ...state.transactions[0], category: "Shopping", categoryOverride: true }]).state);
    expect(resolved.reviewQueue).toEqual([]);
    expect(resolved.transactions).toHaveLength(2);
    expect(resolved.transactions.every((booking) => booking.category === "Shopping")).toBe(true);
  });
  it("counts every unsure row once, retains later reviews and bulk-resolves unknown merchant twins", () => {
    const state = createSeed();
    const missing = transactionSchema.parse({ ...row("empty", "Unknown Empty"), category: "" });
    const conflict = { ...row("conflict", "Amazon"), category: "Shopping" as const };
    state.transactions = [missing, { ...row("review", "Unknown Review"), category: "Prüfen" }, row("twin1", "New Shop"), row("twin2", "New Shop", -30), conflict,
      { ...row("lunch", "BILLA", -8, "2026-09-14"), category: "Lebensmittel" }, row("safe", "BIPA")];
    state.merchantRules = [{ key: merchantRuleKey(conflict), category: "Freizeit" }];
    const queued = queueLedgerReview(state);
    expect(openReviewCount(queued.reviewQueue ?? [])).toBe(6);
    const restored = queueLedgerReview(appStateSchema.parse(JSON.parse(JSON.stringify(queued))));
    expect(restored.reviewQueue).toEqual(queued.reviewQueue);
    const resolved = queueLedgerReview(commitStatementImport(restored, [{ ...state.transactions[2], category: "Shopping", categoryOverride: true }]).state);
    expect(openReviewCount(resolved.reviewQueue ?? [])).toBe(4);
    expect(resolved.transactions).toHaveLength(7);
    expect(resolved.transactions.slice(2, 4).map((booking) => booking.category)).toEqual(["Shopping", "Shopping"]);
    const bankFields = ({ id, description, amount, date, bank, pocket, time, sourceCategory, bankReference, occurrence }: Transaction) => ({ id, description, amount, date, bank, pocket, time, sourceCategory, bankReference, occurrence });
    expect(resolved.transactions.map(bankFields)).toEqual(state.transactions.map(bankFields));
  });
});
