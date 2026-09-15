import { describe, expect, it } from "vitest";
import { categories, categoryAliases, categoryGroups, canonicalCategory, type Category } from "./categories";
import { appStateSchema, transactionSchema, type Transaction } from "./types";
import { actualBookings, calculateMonthTotals, calculatePlan, classify, missingFixedCosts } from "./calc";
import { createSeed } from "./seed";
import { exportWorkbook, parseWorkbook } from "./excel";
import { matchingFixedRow } from "./fixed";
import { commitStatementImport, prepareStatementImport } from "./import/review";
import { statementFingerprint } from "./import/identity";
import { synchronizePlan } from "./planning";

const booking = (description: string, category: Category = "Prüfen", amount = -10): Transaction => ({
  id: crypto.randomUUID(), bank: "Revolut", pocket: "Persönliches Konto", date: "2026-09-02",
  description, category, amount, includeInPlan: true,
});
const stateWith = (labels: string[]) => {
  const state = createSeed();
  state.settings.asOf = "2026-09-15";
  state.transactions = [];
  state.financeRows = labels.map((label, index) => ({ id: `contract-${index}`, kind: "fixed", label, values: { "2026-09": 10, "2026-10": 10 } }));
  return state;
};
const result = (rows: Transaction[]) => ({ file: "categories.csv", source: "Revolut" as const, rows, skipped: 0, issues: [] });

describe("structured categories", () => {
  it("offers each purpose exactly once, without legacy provider names", () => {
    expect(new Set(categories).size).toBe(categories.length);
    expect(categoryGroups.flatMap((group): string[] => [...group.categories])).toEqual(categories);
    expect(categories).toContain("Entertainment");
    expect(categories).toContain("Abonnements");
    for (const legacy of Object.keys(categoryAliases)) expect(categories).not.toContain(legacy);
  });

  it.each(Object.entries(categoryAliases))("migrates %s to %s without changing bank facts", (legacy, expected) => {
    const row = booking("Originaltext", legacy as Category);
    const parsed = transactionSchema.parse({ ...row, categoryOverride: true });
    expect(parsed).toEqual({ ...row, category: expected, categoryOverride: true });
    expect(transactionSchema.parse(parsed)).toEqual(parsed);
    expect(statementFingerprint(parsed)).toBe(statementFingerprint(row));
  });

  it.each([
    ["Spotify Premium", "Abonnements"], ["Netflix", "Abonnements"], ["PayPal Software Subscription", "Abonnements"],
    ["Amazon Prime", "Abonnements"], ["Disney Plus", "Abonnements"], ["Microsoft 365", "Abonnements"],
    ["Cineplexx", "Entertainment"], ["Steam Games", "Entertainment"], ["Nintendo", "Entertainment"],
    ["Fitinn", "Sport & Fitness"], ["Decathlon", "Sport & Fitness"], ["Udemy", "Bildung"],
    ["Fressnapf", "Haustiere"], ["Caritas Spende", "Geschenke & Spenden"], ["Apotheke", "Gesundheit"],
    ["dm Drogerie", "Drogerie"], ["IKEA", "Wohnen & Haushalt"], ["OEBB Ticket", "Mobilität"],
    ["Friseur", "Körperpflege"], ["Allianz Haftpflicht", "Versicherungen"], ["A1 Telekom", "Telefon & Internet"],
    ["AMEX Monatsgebühr", "Bankgebühren"],
  ])("recognizes %s as %s", (description, expected) => {
    expect(classify(booking(description)).category).toBe(expected);
  });

  it("keeps manual choices, unknown PayPal, payroll, Amazon purchases and compulsory lunch rules", () => {
    expect(classify({ ...booking("Netflix", "Freizeit"), categoryOverride: true }).category).toBe("Freizeit");
    expect(classify(booking("PayPal Europe Zahlung")).category).toBe("Prüfen");
    expect(classify(booking("Unbekannter Händler")).category).toBe("Prüfen");
    expect(classify(booking("Amazon Marketplace")).category).toBe("Shopping");
    expect(classify(booking("BIPA")).category).toBe("Mittagessen");
    expect(classify(booking("Gehalt", "Prüfen", 2500)).category).toBe("Gehalt");
  });
});

describe("grouped contracts and persistence", () => {
  it("keeps equal Spotify and Netflix charges distinct and never marks an unpaid subscription paid", () => {
    const state = stateWith(["Spotify", "Netflix"]);
    const spotify = booking("Spotify Premium");
    const prepared = prepareStatementImport([result([spotify])], state);
    const saved = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
    expect(saved.fixedReceipts).toEqual([expect.objectContaining({ category: "Abonnements", rowId: "contract-0" })]);
    expect(missingFixedCosts(saved)).toContain("Netflix");
    const next = prepareStatementImport([result([booking("Netflix")])], saved);
    const complete = commitStatementImport(saved, next.automatic, [], next.metadata).state;
    expect(actualBookings(complete)).toHaveLength(2);
    expect(missingFixedCosts(complete)).toEqual([]);
    const again = prepareStatementImport([result([spotify, booking("Netflix")])], complete);
    expect(again.automatic).toHaveLength(0);
    expect(again.review).toHaveLength(0);
    expect(again.duplicates).toBe(2);
  });

  it("keeps separate insurance price decisions and only updates the accepted contract", () => {
    const state = stateWith(["Vollkasko", "Haftpflicht"]);
    const prepared = prepareStatementImport([result([booking("Vollkasko", "Prüfen", -12), booking("Haftpflicht", "Prüfen", -12)])], state);
    const changes = prepared.review.flatMap((item) => item.kind === "fixed" ? [item.change] : []);
    expect(changes).toHaveLength(2);
    expect(new Set(changes.map((change) => change.id)).size).toBe(2);
    const change = changes.find((item) => item.rowId === "contract-0")!;
    const saved = commitStatementImport(state, [], [{ change, accept: true }], prepared.metadata).state;
    expect(saved.financeRows.find((row) => row.id === "contract-0")?.values["2026-10"]).toBe(12);
    expect(saved.financeRows.find((row) => row.id === "contract-1")?.values["2026-10"]).toBe(10);
    expect(saved.reviewQueue).toHaveLength(1);
    expect(matchingFixedRow(state, "Versicherungen", booking("Unbekannte Versicherung"))).toBeUndefined();
  });

  it("migrates every persisted category reference and preserves separate budgets through JSON and Excel", async () => {
    const original = stateWith(["Spotify", "PayPal Abo", "Vollkasko", "Haftpflicht"]);
    const old = booking("Spotify Premium", "Spotify");
    original.transactions = [old];
    original.financeRows[0].planCategory = "Spotify";
    original.financeRows[0].overrides = { "2026-10": 13 };
    original.merchantRules = [{ key: "revolut|spotify premium", category: "Spotify" }];
    original.fixedReceipts = [{ key: statementFingerprint(old), date: old.date, category: "Spotify", amount: old.amount, rowId: "contract-0", booking: old }];
    original.fixedAmountDecisions = [{ merchantKey: "revolut|spotify premium", category: "Spotify", month: "2026-09", amount: 10, accept: false }];
    original.reviewQueue = [{ kind: "booking", id: "review", draft: booking("PayPal Abonnement", "PayPal Abo"), message: "Prüfen" }];
    const restored = appStateSchema.parse(JSON.parse(JSON.stringify(original)));
    expect(restored.transactions[0].category).toBe("Abonnements");
    expect(restored.fixedReceipts?.[0].category).toBe("Abonnements");
    expect(restored.fixedReceipts?.[0].booking?.category).toBe("Abonnements");
    expect(restored.fixedAmountDecisions?.[0].category).toBe("Abonnements");
    expect(restored.merchantRules?.[0].category).toBe("Abonnements");
    expect(restored.financeRows[0].planCategory).toBe("Abonnements");
    expect(restored.financeRows.map((row) => row.values)).toEqual(original.financeRows.map((row) => row.values));
    const backup = (await parseWorkbook(await exportWorkbook(restored))).state;
    expect(backup.fixedReceipts).toEqual(restored.fixedReceipts);
    expect(backup.merchantRules).toEqual(restored.merchantRules);
    expect(backup.reviewQueue).toEqual(restored.reviewQueue);
    expect(backup.financeRows.map((row) => row.values)).toEqual(restored.financeRows.map((row) => row.values));
    for (const state of [restored, backup]) {
      expect(actualBookings(state)).toHaveLength(1);
      expect(calculateMonthTotals(state, "2026-09", calculatePlan(state.transactions, state.settings.asOf)).fixed).toBe(40);
    }
  });

  it("automatically plans new variable categories without touching existing overrides", () => {
    const state = stateWith([]);
    state.transactions = ["2026-07-02", "2026-08-02"].map((date) => ({ ...booking("Cineplexx"), date }));
    state.financeRows = [{ id: "entertainment", kind: "variable", label: "Entertainment", planCategory: "Entertainment", values: {}, overrides: { "2026-10": 20 } }];
    const planned = synchronizePlan(state);
    expect(planned.financeRows.find((row) => row.id === "entertainment")?.values).toMatchObject({ "2026-09": 6.5, "2026-10": 20 });
    expect(canonicalCategory("Spotify")).toBe("Abonnements");
  });
});
