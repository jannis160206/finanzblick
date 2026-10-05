import { describe, expect, it } from "vitest";
import { actualBookings, calculateDashboard, calculateMonthTotals } from "@/lib/calc";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { initializePlannedOneOffs, matchPlannedOneOffs, plannedOccurrences, synchronizePlannedOneOffs } from "@/lib/planned-one-offs";
import { personalAmount, reconcileSharedHoliday, selectSharedBookings } from "@/lib/shared-holiday";
import { createSeed } from "@/lib/seed";
import { plannedOneOffSchema, appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { commitStatementImport, queueLedgerReview } from "@/lib/import/review";

const plan = (overrides = {}) => plannedOneOffSchema.parse({
  id: "cabinet", name: "Schrank", date: "2026-10-10", amount: 400, ...overrides,
});
const row = (id: string, amount: number, date = "2026-10-10", description = "Shop"): Transaction => ({
  id, amount, date, description, category: amount > 0 ? "Einkommen" : "Shopping", bank: "Amex", pocket: "Amex", includeInPlan: false,
});
const fixture = (): AppState => ({
  ...createSeed(), settings: { ...createSeed().settings, asOf: "2026-10-25" },
  financeRows: [{ id: "salary", kind: "income", label: "Gehalt", values: { "2026-10": 3000, "2026-11": 3000 } }],
});

describe("planned one-offs", () => {
  it("defaults Giro and one rate, validates dates, money, repetitions and the final remainder", () => {
    expect(plan()).toMatchObject({ pocket: "Giro", installments: 1 });
    for (const overrides of [{ date: "2026-02-30" }, { amount: -1 }, { amount: 1.001 }, { installments: 0 }, { installments: 1.5 }, { amount: 55, installments: 12, total: 600 }])
      expect(plannedOneOffSchema.safeParse({ ...plan(), ...overrides }).success).toBe(false);
  });

  it("seeds once, persists deletion and uses only each month's rate and personal halves", () => {
    const state = initializePlannedOneOffs(fixture());
    expect(state.plannedOneOffs).toHaveLength(5);
    const october = plannedOccurrences(state.plannedOneOffs).filter((item) => item.date.startsWith("2026-10"));
    expect(october.map((item) => [item.name, item.ownAmount])).toEqual([
      ["Monitor-Rate", 55], ["Schrank", 200], ["Teppich", 90], ["Vorhänge", 200], ["Führerschein", 780],
    ]);
    const rates = plannedOccurrences(state.plannedOneOffs).filter((item) => item.name === "Monitor-Rate");
    expect(rates).toHaveLength(12);
    expect(rates.at(-1)).toMatchObject({ date: "2027-09-06", amount: 59 });
    expect(rates.reduce((sum, item) => sum + item.amount, 0)).toBe(664);
    expect(initializePlannedOneOffs(appStateSchema.parse({ ...state, plannedOneOffs: [] })).plannedOneOffs).toEqual([]);
    const custom = { ...fixture(), plannedOneOffs: [plan()] };
    expect(initializePlannedOneOffs(custom).plannedOneOffs).toEqual(custom.plannedOneOffs);
  });

  it("clamps monthly dates without drifting after February", () => {
    expect(plannedOccurrences([plan({ date: "2026-01-31", installments: 3 })]).map((item) => item.date))
      .toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("matches one expense once at inclusive two-euro and three-day boundaries", () => {
    const items = [plan(), plan({ id: "second" })];
    const matches = matchPlannedOneOffs(items, [row("paid", -398, "2026-10-07")]);
    expect(matches.filter((item) => item.bookingId)).toHaveLength(1);
    for (const booking of [row("bad", -397.99), row("late", -400, "2026-10-14"), row("credit", 400),
      { ...row("transfer", -400), category: "Transfer" as const },
      { ...row("settlement", -400, "2026-10-10", "AMEX Abrechnung"), category: "Prüfen" as const, bank: "Raiffeisen" }])
      expect(matchPlannedOneOffs([plan()], [booking])[0].bookingId).toBeUndefined();
    expect(matchPlannedOneOffs([plan()], [row("paid", -402, "2026-10-13")])[0].bookingId).toBe("paid");
  });

  it("hides booked seeds and marks only the requested Amex amounts, including a later Tapeso import", () => {
    const transactions = [
      row("ikea", -207.82, "2026-10-02", "IKEA KLAGENFURT 9020 IK"),
      row("snack", -6.97, "2026-10-02", "IKEA KLAGENFURT 9020 IK"),
      row("bnb", -126, "2026-10-03", "AIRBNB * HMKFJJJ9QC LONDON"),
      row("cabinet", -400),
    ];
    const initialized = initializePlannedOneOffs({ ...fixture(), transactions });
    expect(calculateDashboard(initialized).plannedOneOffs.filter((item) => !item.bookingId).some((item) => item.name === "Schrank")).toBe(false);
    expect(initialized.transactions.map((item) => !!item.sharedWithRaphael)).toEqual([true, false, true, true]);
    const carpet = row("carpet", -164.9, "2026-10-02", "MOLLIE=TAPESO DRACHTEN");
    const afterImport = synchronizePlannedOneOffs({ ...initialized, transactions: [...initialized.transactions, carpet] });
    expect(afterImport.plannedOneOffs?.some((item) => item.name === "Teppich")).toBe(false);
    expect(afterImport.transactions.at(-1)?.sharedWithRaphael).toBe(true);
    expect(initializePlannedOneOffs({ ...fixture(), transactions: [carpet] }).plannedOneOffs?.some((item) => item.name === "Teppich")).toBe(false);
    const importedLater = synchronizePlannedOneOffs({ ...initializePlannedOneOffs(fixture()), transactions });
    expect(calculateDashboard(initialized).current).toEqual(calculateDashboard(importedLater).current);
  });

  it("deducts only the current month's halves without changing budgets, fixed rows or goal rates", () => {
    const before = fixture();
    const state = { ...before, plannedOneOffs: [plan({ sharedWithRaphael: true }), plan({ id: "rate", amount: 55, installments: 12, total: 664 })] };
    const original = calculateDashboard(before);
    const dashboard = calculateDashboard(state);
    expect(dashboard.current.surplus).toBe(original.current.surplus - 255);
    expect(dashboard.timeline.find((item) => item.month === "2026-11")?.plannedOneOffs).toBe(55);
    expect(dashboard.current.actualSpending).toBe(0);
    expect(dashboard.plan).toEqual(original.plan);
    expect(dashboard.timeline.map((item) => item.goalRates)).toEqual(original.timeline.map((item) => item.goalRates));
    expect(state.financeRows).toEqual(before.financeRows);
    expect(state.months).toEqual(before.months);
    const booked = calculateDashboard({ ...state, transactions: [row("paid", -400)] });
    expect(booked.current.surplus).toBe(dashboard.current.surplus);
    expect(booked.current.actualSpending).toBe(200);
    expect(booked.plannedOneOffs.find((item) => item.itemId === "cabinet")?.bookingId).toBe("paid");
  });

  it("shares the existing open list, accepts an advance, and never counts Raphael's matching transfer as income", () => {
    const planned = [plan({ id: "older", date: "2026-10-08", sharedWithRaphael: true }),
      plan({ id: "newer", sharedWithRaphael: true })];
    const incoming = row("raphael", 205, "2026-10-05", "Raphael Piber");
    const state = { ...fixture(), plannedOneOffs: planned, transactions: [incoming] };
    const result = reconcileSharedHoliday(state.transactions, state.settings.asOf, planned);
    expect(result.receivables.map((item) => item.status)).toEqual(["Bezahlt", "Offen"]);
    expect(result.receivables[0].bookingId).toContain("older");
    expect(personalAmount(actualBookings(state)[0])).toBe(0);
    expect(calculateMonthTotals(state, "2026-10", { currentMonth: "2026-10" }).received).toBe(0);
    const imported = queueLedgerReview(commitStatementImport({ ...state, transactions: [] }, [incoming]).state);
    expect(imported.financeRows).toEqual(state.financeRows);
    expect(imported.reviewQueue ?? []).toEqual([]);
    const paid = selectSharedBookings(state, [result.receivables[1].bookingId], true);
    expect(reconcileSharedHoliday(paid.transactions, paid.settings.asOf, paid.plannedOneOffs).receivables.every((item) => item.status === "Bezahlt")).toBe(true);
    const booked = { ...state, transactions: [incoming, row("real", -400, "2026-10-08")] };
    const resolved = reconcileSharedHoliday(booked.transactions, booked.settings.asOf, planned);
    expect(resolved.receivables).toHaveLength(2);
    expect(resolved.receivables[0]).toMatchObject({ bookingId: "real", status: "Bezahlt" });
    expect(personalAmount(resolved.bookings[0])).toBe(0);
  });

  it("retains confirmed sharing after the matched plan is deleted", () => {
    const state = synchronizePlannedOneOffs({ ...fixture(), plannedOneOffs: [plan({ sharedWithRaphael: true, paidOccurrences: ["2026-10-10"] })], transactions: [row("real", -400)] });
    expect(actualBookings({ ...state, plannedOneOffs: [] })[0]).toMatchObject({ sharedWithRaphael: true, sharedPaidManually: true });
  });

  it("round-trips plans, final installment, paid occurrences and seed marker through Excel", async () => {
    let state = initializePlannedOneOffs(fixture());
    state = selectSharedBookings(state, ["planned:seed-schrank-2026:2026-10-10"], true);
    const loaded = (await parseWorkbook(await exportWorkbook(state))).state;
    expect(loaded.plannedOneOffs).toEqual(state.plannedOneOffs);
    expect(loaded.plannedOneOffsSeeded).toBe(true);
    expect(initializePlannedOneOffs(loaded).plannedOneOffs).toEqual(state.plannedOneOffs);
    const empty = (await parseWorkbook(await exportWorkbook({ ...state, plannedOneOffs: [] }))).state;
    expect(initializePlannedOneOffs(empty).plannedOneOffs).toEqual([]);
  });
});
