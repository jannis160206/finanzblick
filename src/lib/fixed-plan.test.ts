import { describe, expect, it } from "vitest";
import { calculateDashboard, missingFixedCosts } from "@/lib/calc";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { removeFixedPlanRow, synchronizeFixedPlan } from "@/lib/fixed-plan";
import { matchingFixedRow } from "@/lib/fixed";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { synchronizePlan } from "@/lib/planning";
import { merchantRuleKey } from "@/lib/import/merchant-rules";
import { statementFingerprint } from "@/lib/import/identity";

const booking = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: "october", date: "2026-10-01", bank: "Raiffeisen", pocket: "Giro",
  description: "Nordlicht Verwaltung", merchantAlias: "Verwaltung", amount: -3,
  category: "Shopping", categoryOverride: true, manualCategory: true, reviewed: true,
  includeInPlan: false, fixedCost: true, ...overrides,
});
const fixture = (transactions: Transaction[] = []): AppState => ({
  ...createSeed(), financeRows: [], transactions, fixedReceipts: [], merchantRules: [],
  holidayRanges: [], plannedOneOffs: [], plannedOneOffsSeeded: true,
});
const generated = (state: AppState) => state.financeRows.filter((row) => row.fixedSource);

describe("fixed markings in the monthly plan", () => {
  it("adds a named monthly row from the booking month and keeps budgets, cash and goals unchanged", () => {
    const state = synchronizePlan(fixture());
    const before = structuredClone(state);
    const next = synchronizePlan({ ...state, transactions: [booking()] });
    const row = generated(next)[0];
    expect(row).toMatchObject({ label: "Verwaltung", kind: "fixed", planCategory: "Shopping" });
    expect(row.values["2026-09"]).toBeUndefined();
    expect(row.values["2026-10"]).toBe(3);
    expect(row.values["2027-12"]).toBe(3);
    expect(next.financeRows.filter((row) => row.kind === "variable")).toEqual(state.financeRows.filter((row) => row.kind === "variable"));
    expect(next.settings).toEqual(state.settings);
    expect(next.savingsGoals).toEqual(state.savingsGoals);
    expect(next.months).toEqual(state.months);
    expect(calculateDashboard(next).timeline.find((row) => row.month === "2026-10")?.fixed).toBe(3);
    expect(synchronizePlan(next)).toEqual(next);
    expect(state).toEqual(before);
  });

  it.each(["unmark", "delete"] as const)("removes the generated row on %s and restores it on undo", (action) => {
    const row = booking();
    const active = synchronizeFixedPlan(fixture([row]));
    const removed = synchronizeFixedPlan({ ...active, transactions: action === "delete" ? [] : [{ ...row, fixedCost: false }] });
    expect(removed.financeRows).toEqual([]);
    expect(synchronizeFixedPlan({ ...removed, transactions: [row] }).financeRows).toEqual(active.financeRows);
  });

  it("uses one rate per merchant, applies later prices, and stops at the unmarked month", () => {
    const state = synchronizeFixedPlan(fixture([
      booking({ id: "november", date: "2026-11-01", amount: -4, merchantAlias: "Neuer Name" }),
      booking({ id: "december", date: "2026-12-01", fixedCost: false }),
      booking(),
    ]));
    expect(state.financeRows).toHaveLength(1);
    expect(state.financeRows[0].label).toBe("Neuer Name");
    expect(state.financeRows[0].values).toMatchObject({ "2026-10": 3, "2026-11": 4, "2026-12": null, "2027-12": null });
    const repeated = synchronizeFixedPlan({ ...state, transactions: [...state.transactions, booking({ id: "second", date: "2026-10-15" })] });
    expect(repeated.financeRows).toHaveLength(1);
    expect(repeated.financeRows[0].values["2026-10"]).toBe(3);
  });

  it("never merges unrelated named contracts, pockets or merchants just because their categories match", () => {
    const first = booking({ category: "Miete" });
    const second = booking({ id: "other", category: "Miete", description: "Anderer Vermieter", merchantAlias: undefined, amount: -5 });
    const otherPocket = booking({ id: "other-pocket", category: "Miete", pocket: "Sparkonto" });
    const state = fixture([first, second, otherPocket]);
    state.financeRows = [{ id: "manual", label: "Studentenheim", kind: "fixed", planCategory: "Miete", values: { "2026-10": 450 } }];
    const next = synchronizeFixedPlan(state);
    expect(next.financeRows).toHaveLength(4);
    expect(next.financeRows[0]).toEqual(state.financeRows[0]);
    for (const row of [first, second, otherPocket]) {
      expect(matchingFixedRow(next, row.category, row, merchantRuleKey(row))?.fixedSource?.bookingIds).toContain(row.id);
    }
  });

  it("updates an existing matching plan without duplicating it and restores its independent values", () => {
    const source = booking({ category: "Telefon & Internet", merchantAlias: undefined });
    const state = fixture([source]);
    state.financeRows = [{ id: "phone", label: "Telefon & Internet", kind: "fixed",
      planCategory: "Telefon & Internet", values: { "2026-09": 20, "2026-10": 20, "2026-11": 20 } }];
    const next = synchronizeFixedPlan(state);
    expect(next.financeRows).toHaveLength(1);
    expect(next.financeRows[0]).toMatchObject({ id: "phone", label: "Telefon & Internet",
      values: { "2026-09": 20, "2026-10": 3, "2026-11": 3, "2027-12": 3 } });
    const restored = synchronizeFixedPlan({ ...next, transactions: [{ ...source, fixedCost: false }] });
    expect(restored.financeRows).toEqual(state.financeRows);
  });

  it("preserves independent table edits while other generated months stay synchronized", () => {
    const source = booking();
    let state = synchronizeFixedPlan(fixture([source]));
    state = { ...state, financeRows: state.financeRows.map((row) => ({ ...row, label: "Eigene Tabellenbezeichnung", values: { ...row.values, "2026-11": 10 } })) };
    state = synchronizeFixedPlan(state);
    expect(state.financeRows[0].label).toBe("Eigene Tabellenbezeichnung");
    expect(state.financeRows[0].values["2026-11"]).toBe(10);
    state = synchronizeFixedPlan({ ...state, transactions: [...state.transactions, booking({ id: "new", date: "2026-12-01", amount: -5 })] });
    expect(state.financeRows[0].values).toMatchObject({ "2026-10": 3, "2026-11": 10, "2026-12": 5 });
  });

  it("uses the personal shared amount and excludes repayments, income, transfers and legacy flags", () => {
    const state = synchronizeFixedPlan(fixture([
      booking({ amount: -100, sharedWithRaphael: true }),
      booking({ id: "income", amount: 100, category: "Einkommen" }),
      booking({ id: "transfer", description: "Interne Überweisung", merchantAlias: undefined, category: "Transfer intern" }),
      booking({ id: "legacy", description: "Altvertrag", category: "Miete", fixedCost: undefined }),
      booking({ id: "normal", description: "Normaler Einkauf", fixedCost: false }),
    ]));
    expect(state.financeRows).toHaveLength(1);
    expect(state.financeRows[0].values["2026-10"]).toBe(50);
  });

  it("links receipt-only charges and does not duplicate a ledger representation", () => {
    const source = booking();
    const receipt = { key: statementFingerprint(source), merchantKey: merchantRuleKey(source),
      date: source.date, amount: source.amount, category: source.category, booking: source };
    const state = fixture();
    state.fixedReceipts = [receipt];
    const next = synchronizeFixedPlan(state);
    expect(next.financeRows).toHaveLength(1);
    expect(next.financeRows[0].fixedSource?.bookingIds).toContain(source.id);
    expect(synchronizeFixedPlan({ ...next, transactions: [source] }).financeRows).toHaveLength(1);
    next.settings.asOf = "2026-10-20";
    expect(missingFixedCosts(next)).toEqual([]);
  });

  it("round-trips linkage through JSON and Excel so later unmarking still removes the row", async () => {
    const initial = synchronizeFixedPlan(fixture([booking()]));
    const json = appStateSchema.parse(JSON.parse(JSON.stringify(initial)));
    const excel = (await parseWorkbook(await exportWorkbook(json))).state;
    expect(generated(excel)).toEqual(generated(json));
    expect(generated(synchronizeFixedPlan({ ...excel, transactions: excel.transactions.map((row) => ({ ...row, fixedCost: false })) }))).toEqual([]);
  });

  it("keeps table deletion permanent by unmarking only its linked bookings and future merchant rule", () => {
    const initial = synchronizeFixedPlan(fixture([booking(), booking({ id: "other", description: "Anderer Anbieter", merchantAlias: undefined })]));
    const removed = initial.financeRows.find((row) => row.fixedSource?.bookingIds.includes("october"))!;
    const next = synchronizeFixedPlan(removeFixedPlanRow(initial, removed));
    expect(next.financeRows).toHaveLength(1);
    expect(next.transactions).toHaveLength(2);
    expect(next.transactions.find((row) => row.id === "october")?.fixedCost).toBe(false);
    expect(next.transactions.find((row) => row.id === "other")?.fixedCost).toBe(true);
    expect(next.merchantRules?.find((rule) => rule.key === merchantRuleKey(booking()))?.fixedCost).toBe(false);
  });

  it("does not collide with a converted row when its former booking is marked again", () => {
    const active = synchronizeFixedPlan(fixture([booking()]));
    const converted = { ...active.financeRows[0], kind: "income" as const, fixedSource: undefined };
    const next = synchronizeFixedPlan({ ...active, financeRows: [converted] });
    expect(new Set(next.financeRows.map((row) => row.id)).size).toBe(2);
    expect(next.financeRows.filter((row) => row.kind === "income")).toEqual([converted]);
    expect(next.financeRows.filter((row) => row.kind === "fixed")).toHaveLength(1);
    expect(synchronizeFixedPlan(next)).toEqual(next);
  });

  it("retains manual override ownership even when an automatic rate temporarily equals it", async () => {
    let state = synchronizeFixedPlan(fixture([booking({ amount: -50 })]));
    state.financeRows[0].values["2027-12"] = 60;
    state = synchronizeFixedPlan(state);
    state = synchronizeFixedPlan({ ...state, transactions: [...state.transactions, booking({ id: "nov", date: "2026-11-01", amount: -60 })] });
    state = (await parseWorkbook(await exportWorkbook(state))).state;
    state = synchronizeFixedPlan({ ...state, transactions: [...state.transactions, booking({ id: "dec", date: "2026-12-01", amount: -70 })] });
    expect(generated(state)[0].values["2027-12"]).toBe(60);
    expect(generated(state)[0].values["2027-11"]).toBe(70);
  });

  it("recognizes legacy payments by original merchant and account without overriding explicit false", () => {
    const state = synchronizeFixedPlan(fixture([booking()]));
    state.settings.asOf = "2026-11-20";
    const legacy = booking({ id: "legacy", date: "2026-11-01", merchantAlias: undefined, fixedCost: undefined });
    state.transactions.push(legacy);
    expect(missingFixedCosts(state)).toEqual([]);
    for (const change of [{ fixedCost: false }, { pocket: "Sparkonto" }, { description: "Anderer Anbieter" }]) {
      expect(missingFixedCosts({ ...state, transactions: [state.transactions[0], { ...legacy, ...change }] })).toEqual(["Verwaltung"]);
    }
  });

  it("does not treat a generic payment provider as an identifiable recurring merchant", () => {
    const generic = booking({ description: "PayPal", merchantAlias: undefined });
    const state = synchronizeFixedPlan(fixture([generic]));
    expect(state.financeRows).toHaveLength(1);
    expect(state.financeRows[0].fixedSource?.merchantKeys).toEqual([]);
    expect(matchingFixedRow(state, generic.category, { ...generic, id: "other", date: "2026-11-01" }, merchantRuleKey(generic))).toBeUndefined();
  });
});
