import { expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { transactionSchema, type AppState } from "@/lib/types";
import { mergeFinanceStates, sameFinanceData } from "./account-finance-merge";
import { classify } from "@/lib/calc";

const booking = (id: string) =>
  transactionSchema.parse({
    id,
    bank: "Amex",
    pocket: "Amex",
    description: "Public Duty Free",
    date: "2026-10-06",
    amount: -42,
    category: "Shopping",
    includeInPlan: true,
  });
const state = (id: string): AppState => ({
  ...createEmptyAccountState(),
  transactions: [booking(id)],
});

it("compares contents rather than references, property order or omitted optional fields", () => {
  expect(
    sameFinanceData({ a: 1, b: [2], optional: undefined }, { b: [2], a: 1 }),
  ).toBe(true);
  expect(sameFinanceData(state("same"), structuredClone(state("same")))).toBe(
    true,
  );
  expect(sameFinanceData(state("old"), state("new"))).toBe(false);
});

it("uses a confirmed common baseline for independent settings and payroll edits without guessing", () => {
  const base = state("shared"), local = structuredClone(base), remote = structuredClone(base);
  local.settings.emergencyTarget = 123;
  remote.settings.vacationTarget = 456;
  local.transactions[0] = { ...local.transactions[0], manualCategory: true, category: "Geschenke & Spenden" };
  const result = mergeFinanceStates(local, remote, base);
  expect(result.settings.emergencyTarget).toBe(123);
  expect(result.settings.vacationTarget).toBe(456);
  expect(result.transactions[0].manualCategory).toBe(true);
  remote.settings.emergencyTarget = 789;
  expect(() => mergeFinanceStates(local, remote, base)).toThrow(/widersprüchliche/);
});

it("retains all bookings even when one side deleted a baseline row", () => {
  const base = state("shared"), local = structuredClone(base), remote = structuredClone(base);
  local.transactions = [];
  remote.transactions.push(booking("new"));
  expect(mergeFinanceStates(local, remote, base).transactions.map((row) => row.id)).toEqual(["shared", "new"]);
});

it("protects baseline manual categories from an automatic server classification", () => {
  const base = state("shared");
  base.transactions[0] = { ...base.transactions[0], category: "Geschenke & Spenden", manualCategory: true };
  const remote = state("shared");
  const combined = mergeFinanceStates(structuredClone(base), remote, base);
  expect(combined.transactions[0].category).toBe("Geschenke & Spenden");
  expect(combined.transactions[0].manualCategory).toBe(true);
  const receipt = { key: "receipt-key", amount: -42, date: base.transactions[0].date,
    booking: base.transactions[0], category: "Geschenke & Spenden" as const };
  base.fixedReceipts = [receipt];
  remote.fixedReceipts = [{ ...receipt, booking: remote.transactions[0], category: "Shopping" }];
  expect(mergeFinanceStates(structuredClone(base), remote, base).fixedReceipts![0].booking?.manualCategory).toBe(true);
});

it("keeps all local and server bookings, goals, plans and original snapshots without duplicates", () => {
  const local = state("local"),
    remote = state("remote");
  local.transactions.push(booking("shared"));
  remote.transactions.push(booking("shared"));
  local.savingsGoals = [
    {
      id: "local-goal",
      name: "Local",
      pocket: "Sparkonto",
      target: 100,
      date: "2027-01-01",
    },
  ];
  remote.savingsGoals = [
    {
      id: "server-goal",
      name: "Server",
      pocket: "Sparkonto",
      target: 200,
      date: "2027-02-01",
    },
  ];
  local.holidayRanges = [{ from: "2026-10-01", to: "2026-10-03" }];
  remote.holidayRanges = [{ from: "2026-11-01", to: "2026-11-03" }];
  local.amexBalanceSnapshots = [
    { date: "2026-10-01", periodStart: "2026-09-01", balance: 42 },
  ];
  remote.amexBalanceSnapshots = [
    { date: "2026-11-01", periodStart: "2026-10-01", balance: 84 },
  ];
  const originals = structuredClone([local, remote]);
  const result = mergeFinanceStates(local, remote);
  expect(result.transactions.map((row) => row.id)).toEqual([
    "local",
    "shared",
    "remote",
  ]);
  expect(result.savingsGoals?.map((goal) => goal.id)).toEqual([
    "local-goal",
    "server-goal",
  ]);
  expect(result.holidayRanges).toHaveLength(2);
  expect(result.amexBalanceSnapshots).toHaveLength(2);
  expect([local, remote]).toEqual(originals);
});

it("takes current automatic source evidence, not stale device categories", () => {
  const local = state("shared"),
    remote = state("shared");
  local.transactions[0] = {
    ...local.transactions[0],
    category: "Urlaub",
    requires_manual_review: true,
  };
  remote.transactions[0] = {
    ...remote.transactions[0],
    categoryOverride: true,
    requires_manual_review: false,
    automaticCategoryEvidence: {
      method: "purpose",
      category: "Shopping",
      budgetExcluded: true,
    },
  };
  expect(mergeFinanceStates(local, remote).transactions[0]).toEqual(
    remote.transactions[0],
  );
});

it.each(["local", "remote"] as const)(
  "preserves the %s manual decision against automatic evidence",
  (owner) => {
    const local = state("shared"),
      remote = state("shared");
    const chosen = {
      ...booking("shared"),
      category: "Geschenke & Spenden" as const,
      manualCategory: true,
      fixedCost: false,
    };
    (owner === "local" ? local : remote).transactions[0] = chosen;
    expect(mergeFinanceStates(local, remote).transactions[0]).toEqual(chosen);
  },
);

it("does not choose between two differing manual decisions", () => {
  const local = state("shared"),
    remote = state("shared");
  local.transactions[0].manualCategory = true;
  remote.transactions[0] = {
    ...remote.transactions[0],
    manualCategory: true,
    category: "Geschenke & Spenden",
  };
  expect(() => mergeFinanceStates(local, remote)).toThrow(
    /widersprüchliche.*Buchungen/,
  );
});

it("retains manual-category provenance when an identical device row only has a confirmed identity", () => {
  const local = state("shared"),
    remote = state("shared");
  local.transactions[0] = {
    ...local.transactions[0],
    merchantNameConfirmed: true,
    sourceCategory: "Urlaub",
  };
  remote.transactions[0] = { ...local.transactions[0], manualCategory: true };
  const result = mergeFinanceStates(local, remote).transactions[0];
  expect(result.manualCategory).toBe(true);
  expect(classify(result).category).toBe("Shopping");
});

it.each([
  "amount",
  "description",
  "bank",
  "date",
  "rawDetails",
  "sourceCategory",
] as const)(
  "never guesses or overwrites conflicting original booking %s",
  (field) => {
    const local = state("shared"),
      remote = state("shared");
    const patch = {
      amount: -84,
      description: "Different source",
      bank: "Revolut",
      date: "2026-10-07",
      rawDetails: ["Different original"],
      sourceCategory: "Different source",
    };
    remote.transactions[0] = {
      ...remote.transactions[0],
      [field]: patch[field],
    };
    expect(() => mergeFinanceStates(local, remote)).toThrow(
      /widersprüchliche.*Buchungen/,
    );
  },
);

it("refuses contradictory balances, settings and overlapping holidays without mutating either side", () => {
  const local = state("local"),
    remote = state("remote");
  remote.settings.balances.Sparkonto = 42;
  expect(() => mergeFinanceStates(local, remote)).toThrow(/Einstellungen/);
  remote.settings = structuredClone(local.settings);
  local.holidayRanges = [{ from: "2026-10-01", to: "2026-10-03" }];
  remote.holidayRanges = [{ from: "2026-10-02", to: "2026-10-04" }];
  expect(() => mergeFinanceStates(local, remote)).toThrow(/nicht gültig/);
});

it("retains receipt-only facts and follows their protected booking's category", () => {
  const local = state("shared"),
    remote = state("shared");
  local.transactions = [];
  remote.transactions = [];
  const manual = {
    ...booking("receipt"),
    manualCategory: true,
    category: "Geschenke & Spenden" as const,
  };
  local.fixedReceipts = [
    {
      key: "receipt-key",
      amount: -42,
      date: manual.date,
      category: manual.category,
      booking: manual,
    },
  ];
  remote.fixedReceipts = [
    {
      ...local.fixedReceipts[0],
      category: "Shopping",
      booking: booking("receipt"),
    },
  ];
  expect(mergeFinanceStates(local, remote).fixedReceipts).toEqual(
    local.fixedReceipts,
  );
});

it("preserves incomplete and review-only bookings without accepting them into the ledger", () => {
  const local = state("local"),
    remote = state("remote");
  local.reviewQueue = [
    {
      kind: "booking",
      id: "draft",
      sourceRepair: true,
      draft: { ...booking("draft"), amount: null, date: "", description: "" },
      message: "Original incomplete",
    },
  ];
  remote.reviewQueue = [
    {
      kind: "booking",
      id: "pending",
      draft: booking("pending"),
      message: "Pending acceptance",
    },
  ];
  const result = mergeFinanceStates(local, remote);
  expect(result.reviewQueue?.map((item) => item.id)).toEqual([
    "draft",
    "pending",
  ]);
  expect(result.transactions.map((row) => row.id)).toEqual(["local", "remote"]);
});
