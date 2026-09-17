import { describe, expect, it } from "vitest";
import { categories, categoryAliases, categoryGroups, canonicalCategory, isTravelCategory, type Category } from "./categories";
import { appStateSchema, fixedCategories, transactionSchema, type Transaction } from "./types";
import { actualBookings, calculateDashboard, calculateMonthTotals, calculatePlan, classify, missingFixedCosts } from "./calc";
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
const expandedCategories = [
  "Restaurants", "Lieferdienste", "Cafés & Snacks", "Kleidung & Schuhe", "Elektronik",
  "Bücher", "Weiterbildung", "Unterkunft", "Flugreisen", "Miete", "Energie & Nebenkosten",
  "Möbel & Einrichtung", "Reparaturen & Instandhaltung", "Tanken", "Öffentliche Verkehrsmittel",
  "Parken & Maut", "Fahrzeugwartung",
] as const satisfies readonly Category[];

describe("structured categories", () => {
  it("offers each purpose exactly once, without legacy provider names", () => {
    expect(new Set(categories).size).toBe(categories.length);
    expect(categoryGroups.flatMap((group): string[] => [...group.categories])).toEqual(categories);
    expect(categories).toContain("Entertainment");
    expect(categories).toContain("Abonnements");
    expect(categoryGroups).toHaveLength(6);
    expect(categories).toEqual(expect.arrayContaining([...expandedCategories]));
    expect(categories).toEqual(expect.arrayContaining([
      "Lebensmittel", "Mittagessen", "Ausgehen", "Shopping", "Drogerie", "Gesundheit", "Körperpflege",
      "Entertainment", "Freizeit", "Sport & Fitness", "Bildung", "Geschenke & Spenden", "Haustiere", "Urlaub",
      "Wohnen & Haushalt", "Mobilität", "Leasing", "Abonnements", "Versicherungen", "Telefon & Internet",
      "Bankgebühren", "Gehalt", "Rufbereitschaft", "Einkommen", "Sonstiges", "Transfer", "Transfer intern", "Prüfen",
    ]));
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
    ["Amazon Prime", "Shopping"], ["Disney Plus", "Abonnements"], ["Microsoft 365", "Abonnements"],
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

  it.each(expandedCategories)("accepts the manual purpose %s without remapping it", (category) => {
    const row = { ...booking("Fachhandel Linde", category), categoryOverride: true };
    expect(transactionSchema.parse(row)).toEqual(row);
    expect(canonicalCategory(category)).toBe(category);
    expect(classify(row)).toMatchObject({ category, isTransfer: false, includeInPlan: !isTravelCategory(category) && !fixedCategories.includes(category) });
    for (const description of ["BIPA", "Hotspot", "Mensa", "Mensen"])
      expect(classify({ ...row, description }).category).toBe("Mittagessen");
    expect(classify({ ...row, description: "Interne Überweisung" })).toMatchObject({ category: "Transfer intern", isTransfer: true, includeInPlan: false });
  });

  it.each([
    ["Booking.com", "Unterkunft"], ["Lufthansa", "Flugreisen"],
  ] as const)("keeps a refined travel choice for %s without adding it to everyday budgets", (description, category) => {
    expect(classify(booking(description)).category).toBe("Urlaub");
    expect(classify({ ...booking(description, category), categoryOverride: true }))
      .toMatchObject({ category, includeInPlan: false, isTransfer: false });
  });

  it("does not infer the new granular purposes from payment providers or replace old merchant classifications", () => {
    for (const description of ["PayPal Europe Zahlung", "Kartenzahlung", "Fachhandel Linde"])
      expect(classify(booking(description)).category).toBe("Prüfen");
    for (const [description, category] of [
      ["Thalia", "Bildung"], ["Udemy", "Bildung"], ["Miete", "Wohnen & Haushalt"],
      ["Stromrechnung", "Wohnen & Haushalt"], ["OEBB", "Mobilität"], ["Parkgebühr", "Mobilität"],
      ["Shell", "Mobilität"], ["Foodora", "Ausgehen"],
    ]) expect(classify(booking(description)).category).toBe(category);
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
    expect(backup.financeRows.filter((row) => row.kind === "fixed").map((row) => row.values)).toEqual(restored.financeRows.map((row) => row.values));
    for (const state of [restored, backup]) {
      expect(actualBookings(state)).toHaveLength(1);
      expect(calculateMonthTotals(state, "2026-09", calculatePlan(state.transactions, state.settings.asOf)).fixed).toBe(40);
    }
  });

  it("keeps new spending categories out of the strict variable plan", () => {
    const state = stateWith([]);
    state.transactions = ["2026-07-02", "2026-08-02"].map((date) => ({ ...booking("Cineplexx"), date }));
    state.financeRows = [{ id: "entertainment", kind: "variable", label: "Entertainment", planCategory: "Entertainment", values: {}, overrides: { "2026-10": 20 } }];
    const planned = synchronizePlan(state);
    expect(planned.financeRows.find((row) => row.id === "entertainment")).toBeUndefined();
    expect(planned.financeRows.filter((row) => row.kind === "variable")).toHaveLength(7);
    expect(canonicalCategory("Spotify")).toBe("Abonnements");
  });

  it("remembers every new manual choice through review, JSON, Excel and subsequent imports", async () => {
    const original = synchronizePlan(stateWith([]));
    const drafts = expandedCategories.map((category, index) => booking(`Fachhandel Linde ${index}`, category));
    const prepared = prepareStatementImport([result(drafts.map((row) => ({ ...row, category: "Prüfen" })))], original);
    expect(prepared.review).toHaveLength(expandedCategories.length);
    const saved = commitStatementImport(original, drafts.map((row) => ({ ...row, categoryOverride: true })), [], prepared.metadata).state;
    expect(saved.reviewQueue ?? []).toHaveLength(0);
    expect(saved.merchantRules?.map((rule) => rule.category)).toEqual(expandedCategories);
    const json = appStateSchema.parse(JSON.parse(JSON.stringify(saved)));
    const workbook = await parseWorkbook(await exportWorkbook(json));
    expect(workbook.warnings).toEqual([]);
    for (const restored of [json, workbook.state]) {
      expect(restored.transactions.map((row) => row.category)).toEqual(expandedCategories);
      expect(restored.merchantRules).toEqual(saved.merchantRules);
      expect(restored.transactions.map(statementFingerprint)).toEqual(saved.transactions.map(statementFingerprint));
      expect(restored.financeRows).toEqual(original.financeRows);
      const next = prepareStatementImport([result(drafts.map((row) => ({
        ...row, id: crypto.randomUUID(), date: "2026-09-03", category: "Prüfen",
      })))], restored);
      expect(next.review).toHaveLength(0);
      expect(next.automatic.map((row) => row.category)).toEqual(expandedCategories.filter((category) => !fixedCategories.includes(category)));
      expect(next.automatic.every((row) => row.categoryOverride)).toBe(true);
      expect(next.metadata.fixedReceipts.map((receipt) => receipt.category)).toEqual(["Miete", "Energie & Nebenkosten"]);
      expect(next.metadata.fixedReceipts.every((receipt) => receipt.booking?.categoryOverride)).toBe(true);
    }
  });

  it("retains a learned accommodation purpose for a recognized travel merchant after Excel reload", async () => {
    const original = synchronizePlan(stateWith([]));
    const row = { ...booking("Booking.com", "Unterkunft", -120), categoryOverride: true };
    const saved = commitStatementImport(original, [row]).state;
    const loaded = (await parseWorkbook(await exportWorkbook(saved))).state;
    expect(loaded.transactions[0]).toMatchObject({ category: "Unterkunft", categoryOverride: true, includeInPlan: false });
    const next = prepareStatementImport([result([{ ...booking("Booking.com"), date: "2026-09-03" }])], loaded);
    expect(next.review).toHaveLength(0);
    expect(next.automatic[0]).toMatchObject({ category: "Unterkunft", categoryOverride: true, includeInPlan: false });
  });

  it("matches explicit rent and utility contracts without counting them in variable budgets", async () => {
    const original = synchronizePlan(stateWith(["Wohnung Linde", "Stadtwerke Linde"]));
    original.financeRows[0].planCategory = "Miete";
    original.financeRows[1].planCategory = "Energie & Nebenkosten";
    const rows = [
      { ...booking("Wohnung Linde", "Miete"), categoryOverride: true },
      { ...booking("Stadtwerke Linde", "Energie & Nebenkosten"), categoryOverride: true },
    ];
    const imported = commitStatementImport(original, rows).state;
    expect(imported.fixedReceipts?.map((receipt) => receipt.rowId)).toEqual(["contract-0", "contract-1"]);
    for (const state of [imported, (await parseWorkbook(await exportWorkbook(imported))).state]) {
      expect(state.financeRows).toEqual(original.financeRows);
      expect(missingFixedCosts(state)).toEqual([]);
      expect(actualBookings(state)).toHaveLength(2);
      const dashboard = calculateDashboard(state);
      expect(dashboard.current).toMatchObject({ fixed: 20, actualSpending: 20 });
      expect(dashboard.plan.rows.every((row) => row.actual === 0)).toBe(true);
      expect(dashboard.spending).toEqual(expect.arrayContaining([{ name: "Miete", value: 10 }, { name: "Energie & Nebenkosten", value: 10 }]));
    }
    const updated = commitStatementImport(imported, [{ ...rows[0], id: crypto.randomUUID(), date: "2026-09-03", amount: -12 }]).state;
    expect(updated.financeRows).toEqual(original.financeRows);
    expect(actualBookings(updated)).toHaveLength(3);
    expect(calculateDashboard(updated).current.actualSpending).toBe(32);
  });

  it.each(["Miete", "Energie & Nebenkosten"] as const)("keeps separate %s contracts distinct and creates no plan rows", (category) => {
    const original = synchronizePlan(stateWith(["Vertrag Linde", "Vertrag Eiche"]));
    original.financeRows[0].planCategory = category;
    original.financeRows[1].planCategory = category;
    const row = { ...booking("Vertrag Linde", category), categoryOverride: true };
    const saved = commitStatementImport(original, [row]).state;
    expect(saved.fixedReceipts).toEqual([expect.objectContaining({ rowId: "contract-0", category })]);
    expect(missingFixedCosts(saved)).toEqual(["Vertrag Eiche"]);
    expect(matchingFixedRow(saved, category, booking("Unbekannter Vertrag", category))).toBeUndefined();
    const withoutContracts = synchronizePlan(stateWith([]));
    const unplanned = commitStatementImport(withoutContracts, [row]).state;
    expect(unplanned.financeRows).toEqual(withoutContracts.financeRows);
    expect(actualBookings(unplanned)).toHaveLength(1);
    expect(calculateDashboard(unplanned).plan.rows.every((row) => row.actual === 0)).toBe(true);
  });
});
