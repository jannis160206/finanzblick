import { describe, expect, it } from "vitest";
import { createSeed } from "./seed";
import { actualBookings, calculateDashboard } from "./calc";
import {
  amexBalancePeriodStart,
  amexCycle,
  amexDebitSchedule,
  amexStatement,
  amexTransferDeadline,
  expectedAmexDebit,
} from "./amex-statement";
import type { AppState, Transaction } from "./types";

const card = (id: string, date: string, amount: number, patch: Partial<Transaction> = {}): Transaction => ({
  id, date, bank: "Amex", pocket: "AMEX Jannis", description: `Kauf ${id}`, amount,
  category: "Shopping", includeInPlan: true, categoryOverride: true, ...patch,
});
const pocket = (id: string, date: string, amount: number): Transaction => ({
  id, date, bank: "Revolut", pocket: "Amex Rückzahlung", description: amount > 0 ? "Von Persönliches Konto" : "An Raiffeisen Giro",
  amount, category: "Transfer intern", includeInPlan: false, categoryOverride: true,
});
const debit = (id: string, date: string, amount: number): Transaction => ({
  id, date, bank: "Raiffeisen", pocket: "Raiffeisen Giro", description: "Zahlungsempfänger: AMERICAN EXPRESS EUROPE S.A",
  rawDetails: ["Creditor-ID GB03ZZZSDDDEUT0000000165752"], amount, category: "Transfer intern", includeInPlan: false,
  categoryOverride: true,
});
// Earlier statements were debited 7 days after the 10th, on Mondays after a weekend later.
const history = [
  debit("d-jun", "2026-06-17", -655.85), debit("d-jul", "2026-07-17", -3628.7),
  debit("d-sep", "2026-09-17", -4043.77), debit("d-oct", "2026-10-19", -1446.65),
];

function fixture(transactions: Transaction[], asOf = "2026-11-13", reserve = 500): AppState {
  const seed = createSeed();
  return {
    ...seed, settings: { ...seed.settings, asOf },
    transactions: [...history, ...transactions], fixedReceipts: [], savingsGoals: [], plannedOneOffs: [],
    plannedOneOffsSeeded: true, financeRows: [],
    accountSnapshots: [{ bank: "Revolut", name: "Amex Rückzahlung", date: "2026-10-20", balance: reserve }],
  };
}
const statement = (state: AppState) => amexStatement(state, actualBookings(state));

describe("Amex statement cycle", () => {
  it.each([
    ["2026-11-10", "2026-10-11", "2026-11-10"],
    ["2026-11-11", "2026-11-11", "2026-12-10"],
    ["2026-12-31", "2026-12-11", "2027-01-10"],
    ["2026-01-05", "2025-12-11", "2026-01-10"],
  ])("puts a purchase on %s into the statement %s – %s", (date, start, closing) => {
    expect(amexCycle(date)).toEqual({ start, closing });
  });

  it("learns the debit offset from history, counting Monday debits as due on the weekend before", () => {
    const schedule = amexDebitSchedule(fixture([]).transactions, "2026-11-13");
    expect(schedule).toEqual({ offsetDays: 7, basedOn: 4, recent: ["2026-06-17", "2026-07-17", "2026-09-17", "2026-10-19"] });
    expect(expectedAmexDebit("2026-11-10", schedule)).toBe("2026-11-17");
    expect(amexTransferDeadline("2026-11-17")).toBe("2026-11-16");
    // 17 October 2026 is a Saturday: the debit moves to Monday, the transfer to the Friday before.
    expect(expectedAmexDebit("2026-10-10", schedule)).toBe("2026-10-19");
    expect(amexTransferDeadline("2026-10-19")).toBe("2026-10-16");
    expect(amexDebitSchedule([], "2026-11-13")).toEqual({ offsetDays: 7, basedOn: 0, recent: [] });
  });
});

describe("Amex statement and pocket share", () => {
  const purchases = [
    card("before", "2026-10-11", -120),
    card("cutoff", "2026-11-10", -80.5),
    card("partner", "2026-11-02", -40, { pocket: "AMEX Raphael" }),
    card("refund", "2026-11-04", 20),
    card("next", "2026-11-11", -99.99),
    pocket("p-cutoff", "2026-11-11", 80.5),
    pocket("p-next", "2026-11-11", 100),
  ];

  it("takes only purchases up to the 10th and leaves pocket money for later purchases in place", () => {
    const result = statement(fixture(purchases))!;
    expect(result.cycle).toEqual({ start: "2026-10-11", closing: "2026-11-10" });
    expect(result.status).toBe("due");
    expect(result.total).toBe(220.5);
    expect(result.partner).toBe(40);
    expect(result.pocketBalance).toBe(680.5);
    expect(result.nextReserved).toBe(100);
    expect(result.fromPocket).toBe(220.5);
    expect(result.additional).toBe(0);
    expect(result.toTransfer).toBe(220.5);
    expect(result.expectedDebit).toBe("2026-11-17");
    expect(result.deadline).toBe("2026-11-16");
    expect(result.daysLeft).toBe(3);
    expect(result.rows.map((row) => row.booking.id)).toEqual(["cutoff", "refund", "partner", "before"]);
    expect(result.rows.filter((row) => row.reserved).map((row) => row.booking.id)).toEqual(["cutoff"]);
  });

  it("splits a bill larger than the pocket into pocket share and additional payment", () => {
    const result = statement(fixture([...purchases, card("big", "2026-10-20", -900)], "2026-11-13", 300))!;
    expect(result.total).toBe(1120.5);
    expect(result.fromPocket).toBe(380.5);
    expect(result.additional).toBe(740);
  });

  it("uses the Amex balance for purchases not imported yet, without the next statement's purchases", () => {
    const state = fixture(purchases);
    state.amexBalanceSnapshots = [{ periodStart: "2026-10-11", date: "2026-11-11", balance: 1599.99, pendingBalance: 0 }];
    const result = statement(state)!;
    expect(result.total).toBe(1500);
    expect(result.booked).toBe(220.5);
    expect(result.missing).toBe(1279.5);
    expect(result.snapshotDate).toBe("2026-11-11");
  });

  it("counts a transfer from the pocket since the 10th and calms down once it covers the pocket share", () => {
    const partial = statement(fixture([...purchases, pocket("out-1", "2026-11-12", -100)]))!;
    expect(partial).toMatchObject({ status: "due", transferred: 100, fromPocket: 220.5, toTransfer: 120.5 });
    const done = statement(fixture([...purchases, pocket("out-2", "2026-11-12", -220.5)]))!;
    expect(done).toMatchObject({ status: "transferred", transferred: 220.5, transferredOn: "2026-11-12", toTransfer: 0 });
    const corrected = statement(fixture([...purchases, pocket("in", "2026-11-12", 50), pocket("back", "2026-11-12", -50)]))!;
    expect(corrected.transferred).toBe(0);
  });

  it("moves on to the running statement once Amex has debited the giro", () => {
    const state = fixture([...purchases, debit("d-nov", "2026-11-17", -220.5)], "2026-11-18");
    const result = statement(state)!;
    expect(result.status).toBe("open");
    expect(result.cycle).toEqual({ start: "2026-11-11", closing: "2026-12-10" });
    expect(result.total).toBe(99.99);
    expect(result.lastDebit).toEqual({ date: "2026-11-17", amount: 220.5 });
    expect(result.deadline).toBe("2026-12-16");
  });

  it("is part of the dashboard and absent without any Amex data", () => {
    expect(calculateDashboard(fixture(purchases)).amexStatement?.total).toBe(220.5);
    const empty = fixture([]);
    empty.transactions = [];
    expect(calculateDashboard(empty).amexStatement).toBeNull();
  });

  it("dates an Amex total balance back to the closed statement while its debit is outstanding", () => {
    const rows = fixture([]).transactions;
    expect(amexBalancePeriodStart(rows, "2026-11-05")).toBe("2026-10-11");
    expect(amexBalancePeriodStart(rows, "2026-11-12")).toBe("2026-10-11");
    expect(amexBalancePeriodStart([...rows, debit("d-nov", "2026-11-17", -220.5)], "2026-11-18")).toBe("2026-11-11");
    expect(amexBalancePeriodStart(rows, "2026-10-15")).toBe("2026-09-11");
  });
});
