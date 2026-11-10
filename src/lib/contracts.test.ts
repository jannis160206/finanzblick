import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type FinanceRow, type Transaction } from "@/lib/types";
import {
  addMonthsToDate,
  cancellationWindow,
  contractChargesBetween,
  contractReminders,
  contractSummary,
  detectContracts,
  upsertContractOverride,
} from "./contracts";

let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"]): Transaction => ({
  id: `c${++counter}`, date, bank: "Raiffeisen", pocket: "Testkonto", description, amount, category, includeInPlan: true,
});
const stateWith = (transactions: Transaction[], extra: Partial<AppState> = {}): AppState => appStateSchema.parse({
  ...createSeed(), transactions, financeRows: [], merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
  ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [], ...extra,
});
const series = (description: string, amounts: number[], dates: string[], category: Transaction["category"] = "Abonnements") =>
  amounts.map((amount, index) => row(dates[index], description, -amount, category));
const monthsFrom = (start: string, count: number) => Array.from({ length: count }, (_, index) => addMonthsToDate(start, index));

describe("contract detection", () => {
  it("detects monthly subscriptions with next date, yearly cost and price increase", () => {
    const state = stateWith(series("Streamflix Abo", [9.99, 9.99, 9.99, 12.99], monthsFrom("2026-05-15", 4)));
    const [contract] = detectContracts(state, "2026-09-01");
    expect(contract).toMatchObject({
      name: "Streamflix Abo", interval: "monthly", amount: 12.99, monthly: 12.99, yearly: 155.88,
      nextDate: "2026-09-15", lastDate: "2026-08-15", status: "review", source: "detected",
    });
    expect(contract.priceChange).toMatchObject({ from: 9.99, to: 12.99 });
    expect(contract.charges).toHaveLength(4);
  });

  it("recognises quarterly, half-yearly and yearly payments", () => {
    const state = stateWith([
      ...series("Kfz Versicherung Donau", [120, 120, 120], ["2026-01-10", "2026-04-10", "2026-07-10"], "Versicherungen"),
      ...series("Haushalt Versicherung Uniqa", [80, 80], ["2025-11-02", "2026-05-02"], "Versicherungen"),
      ...series("Cloud Speicher Pro", [99, 99], ["2025-03-20", "2026-03-20"], "Abonnements"),
    ]);
    const byName = Object.fromEntries(detectContracts(state, "2026-08-01").map((contract) => [contract.name, contract]));
    expect(byName["Kfz Versicherung Donau"]).toMatchObject({ interval: "quarterly", monthly: 40, nextDate: "2026-10-10" });
    expect(byName["Haushalt Versicherung Uniqa"]).toMatchObject({ interval: "halfyearly", nextDate: "2026-11-02" });
    expect(byName["Cloud Speicher Pro"]).toMatchObject({ interval: "yearly", yearly: 99, nextDate: "2027-03-20" });
  });

  it("ignores everyday shopping, one-off purchases and stopped subscriptions", () => {
    const groceries = ["05-02", "05-09", "06-02", "06-09", "07-02", "07-09", "08-02"].map((date) => row(`2026-${date}`, "Supermarkt Nord", -40, "Lebensmittel"));
    const state = stateWith([
      ...groceries,
      row("2026-06-11", "Elektro Shop", -499, "Shopping"),
      ...series("Altabo Media", [5, 5, 5], monthsFrom("2026-01-03", 3)),
    ]);
    expect(detectContracts(state, "2026-08-20")).toEqual([]);
  });

  it("keeps parallel series at one merchant apart", () => {
    const state = stateWith([
      ...series("Ratenkauf Shop", [30, 30, 30], monthsFrom("2026-05-05", 3), "Shopping"),
      ...series("Ratenkauf Shop", [90, 90, 90], monthsFrom("2026-05-20", 3), "Shopping"),
    ]);
    const contracts = detectContracts(state, "2026-08-01");
    expect(contracts.map((contract) => contract.amount).sort((a, b) => a - b)).toEqual([30, 90]);
    expect(new Set(contracts.map((contract) => contract.id)).size).toBe(2);
  });

  it("takes fixed-cost plan rows without bookings and does not duplicate linked ones", () => {
    const charges = series("Handyvertrag Magenta", [25, 25, 25], monthsFrom("2026-05-07", 3), "Telefon & Internet");
    const fixedRows: FinanceRow[] = [
      { id: "rent", label: "Miete", kind: "fixed", planCategory: "Miete", values: { "2026-08": 650, "2026-09": 650, "2026-10": 650 } },
      { id: "phone", label: "Handy", kind: "fixed", planCategory: "Telefon & Internet", values: { "2026-08": 25, "2026-09": 25 },
        fixedSource: { key: "phone", bookingIds: charges.map((charge) => charge.id), merchantKeys: [], pocket: null, applied: {} } },
    ];
    const contracts = detectContracts(stateWith(charges, { financeRows: fixedRows }), "2026-08-01");
    expect(contracts).toHaveLength(2);
    const rent = contracts.find((contract) => contract.source === "fixed")!;
    expect(rent).toMatchObject({ name: "Miete", amount: 650, interval: "monthly", status: "active", fixedRowId: "rent" });
    expect(contracts.find((contract) => contract.source === "detected")).toMatchObject({ fixedRowId: "phone", status: "active" });
  });
});

describe("contract overrides", () => {
  const base = series("Streamflix Abo", [9.99, 9.99, 9.99], monthsFrom("2026-05-15", 3));

  it("confirms, ignores, edits and cancels detected contracts", () => {
    const id = detectContracts(stateWith(base), "2026-08-01")[0].id;
    const confirmed = detectContracts(stateWith(base, { contracts: upsertContractOverride(undefined, id, { status: "confirmed", amount: 11, name: "Streamflix" }, 1) }), "2026-08-01")[0];
    expect(confirmed).toMatchObject({ status: "active", amount: 11, name: "Streamflix", edited: true });
    const ignored = detectContracts(stateWith(base, { contracts: [{ id, status: "ignored", updatedAt: 1 }] }), "2026-08-01")[0];
    expect(ignored.status).toBe("ignored");
    const cancelled = stateWith(base, { contracts: [{ id, status: "cancelled", cancelledAt: "2026-09-01", updatedAt: 1 }] });
    const contracts = detectContracts(cancelled, "2026-08-01");
    expect(contracts[0].status).toBe("cancelled");
    expect(contractChargesBetween(contracts, "2026-08-01", "2026-12-31", "2026-08-01").map((charge) => charge.date)).toEqual(["2026-08-15"]);
    expect(contractSummary(detectContracts(stateWith(base, { contracts: [{ id, status: "ignored", updatedAt: 1 }] }), "2026-08-01"), "2026-08-01").monthly).toBe(0);
  });

  it("adds manual contracts and rejects incomplete ones", () => {
    const contracts = [{ id: "manual:gym", manual: true, name: "Fitnessstudio", amount: 39.9, interval: "monthly" as const, nextDate: "2026-07-01", category: "Sport & Fitness" as const, updatedAt: 1 }];
    const [gym] = detectContracts(stateWith([], { contracts }), "2026-08-10");
    expect(gym).toMatchObject({ source: "manual", status: "active", nextDate: "2026-09-01", type: "gym", monthly: 39.9 });
    expect(appStateSchema.safeParse({ ...stateWith([]), contracts: [{ id: "manual:x", manual: true, name: "X", updatedAt: 1 }] }).success).toBe(false);
  });

  it("updates overrides in place", () => {
    const first = upsertContractOverride(undefined, "a", { status: "confirmed" }, 1);
    const second = upsertContractOverride(first, "a", { note: "Kundennr. 4711" }, 2);
    expect(second).toEqual([{ id: "a", status: "confirmed", note: "Kundennr. 4711", updatedAt: 2 }]);
  });
});

describe("cancellation deadlines and reminders", () => {
  it("computes the latest notice date for monthly terms and fixed terms with renewal", () => {
    expect(cancellationWindow({ notice: { value: 1, unit: "months" }, nextDate: "2026-09-15", interval: "monthly" }, "2026-08-01"))
      .toEqual({ deadline: "2026-08-15", effectiveEnd: "2026-09-15" });
    expect(cancellationWindow({ notice: { value: 1, unit: "months" }, nextDate: "2026-09-15", interval: "monthly" }, "2026-08-20"))
      .toEqual({ deadline: "2026-09-15", effectiveEnd: "2026-10-15" });
    expect(cancellationWindow({ notice: { value: 3, unit: "months" }, termEnd: "2026-10-31", interval: "monthly", renewalMonths: 12 }, "2026-08-15"))
      .toEqual({ deadline: "2027-07-31", effectiveEnd: "2027-10-31" });
    expect(cancellationWindow({ notice: { value: 14, unit: "days" }, termEnd: "2026-08-20", interval: "monthly", autoRenew: false }, "2026-08-15")).toBeUndefined();
    expect(cancellationWindow({ nextDate: "2026-09-15", interval: "monthly" }, "2026-08-01")).toBeUndefined();
  });

  it("reminds of deadlines within 30 days and of recent price increases", () => {
    const transactions = series("Streamflix Abo", [9.99, 9.99, 12.99], monthsFrom("2026-06-15", 3));
    const id = detectContracts(stateWith(transactions), "2026-08-20")[0].id;
    const state = stateWith(transactions, { contracts: [{ id, status: "confirmed", notice: { value: 2, unit: "weeks" }, updatedAt: 1 }] });
    const reminders = contractReminders(detectContracts(state, "2026-08-20"), "2026-08-20");
    expect(reminders.map((reminder) => reminder.kind).sort()).toEqual(["deadline", "price"]);
    expect(reminders.find((reminder) => reminder.kind === "deadline")).toMatchObject({ date: "2026-09-01", tone: "warn" });
  });

  it("summarises running contracts and the next charge", () => {
    const state = stateWith([
      ...series("Streamflix Abo", [10, 10, 10], monthsFrom("2026-05-15", 3)),
      ...series("Kfz Versicherung Donau", [120, 120, 120], ["2026-01-10", "2026-04-10", "2026-07-10"], "Versicherungen"),
    ]);
    const summary = contractSummary(detectContracts(state, "2026-08-01"), "2026-08-01");
    expect(summary).toMatchObject({ monthly: 50, yearly: 600, active: 2, review: 2 });
    expect(summary.next?.name).toBe("Streamflix Abo");
  });
});
