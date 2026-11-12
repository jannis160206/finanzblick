import { describe, expect, it } from "vitest";
import { categories, categoryAliases, categoryGroups, canonicalCategory, isTravelCategory, knownMerchantCategory, type Category } from "./categories";
import { appStateSchema, fixedCategories, transactionSchema, type Transaction } from "./types";
import { actualBookings, calculateDashboard, calculateMonthTotals, calculatePlan, classify, classifyStatementRows, missingFixedCosts } from "./calc";
import { createSeed } from "./seed";
import { exportWorkbook, parseWorkbook } from "./excel";
import { matchingFixedRow } from "./fixed";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "./import/review";
import { statementFingerprint } from "./import/identity";
import { merchantRuleKey } from "./import/merchant-rules";
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
  "Restaurants", "Lieferdienste", "Cafés & Snacks", "Shopping", "Guthabenkarten", "Porto & Versand",
  "Bildung", "Weiterbildung", "Urlaub", "Miete", "Energie & Nebenkosten",
  "Möbel & Einrichtung", "Reparaturen & Instandhaltung", "Tanken", "Öffentliche Verkehrsmittel",
  "Parken & Maut", "Fahrzeugwartung",
  "Rückerstattungen", "Rücklastschriftgebühren",
] as const satisfies readonly Category[];

describe("structured categories", () => {
  it("offers each purpose exactly once, without legacy provider names", () => {
    expect(new Set(categories).size).toBe(categories.length);
    expect(categoryGroups.flatMap((group): string[] => [...group.categories])).toEqual(categories);
    expect(categories).toContain("Entertainment");
    expect(categories).toContain("Abonnements");
    expect(categoryGroups).toHaveLength(6);
    expect(categories).toHaveLength(43);
    expect(categories).toEqual(expect.arrayContaining([...expandedCategories]));
    expect(categories).toEqual(expect.arrayContaining([
      "Lebensmittel", "Mittagessen", "Shopping", "Drogerie", "Gesundheit", "Körperpflege",
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
    const state = stateWith(["Altvertrag"]);
    state.financeRows[0].planCategory = row.category;
    state.merchantRules = [{ key: merchantRuleKey(row), category: row.category }];
    state.fixedReceipts = [{ key: statementFingerprint(row), date: row.date, amount: row.amount, category: row.category, booking: row }];
    state.fixedAmountDecisions = [{ merchantKey: merchantRuleKey(row), category: row.category, month: "2026-09", amount: 10, accept: false }];
    state.reviewQueue = [{ kind: "fixed", id: "change", change: {
      id: "change", category: row.category, month: "2026-09", previous: 9, amount: 10, bookings: [row],
    } }];
    const restored = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(restored.financeRows[0].planCategory).toBe(expected);
    expect(restored.merchantRules?.[0].category).toBe(expected);
    expect(restored.fixedReceipts?.[0]).toMatchObject({ category: expected, booking: { ...row, category: expected } });
    expect(restored.fixedAmountDecisions?.[0].category).toBe(expected);
    expect(restored.reviewQueue?.[0]).toMatchObject({ change: { category: expected, bookings: [{ ...row, category: expected }] } });
  });

  it.each([
    ["Spotify Premium", "Abonnements"], ["Netflix", "Abonnements"], ["PayPal Software Subscription", "Abonnements"],
    ["Amazon Prime", "Abonnements"], ["Disney Plus", "Abonnements"], ["Microsoft 365", "Abonnements"],
    ["Cineplexx", "Entertainment"], ["Steam Games", "Entertainment"], ["Nintendo", "Entertainment"],
    ["Fitinn", "Sport & Fitness"], ["Decathlon", "Sport & Fitness"], ["Udemy", "Bildung"],
    ["Fressnapf", "Haustiere"], ["Caritas Spende", "Geschenke & Spenden"], ["Apotheke", "Gesundheit"],
    ["dm Drogerie", "Drogerie"], ["IKEA", "Möbel & Einrichtung"], ["OEBB Ticket", "Öffentliche Verkehrsmittel"],
    ["WWW.OEBB.AT TICKET FOR WIEN", "Öffentliche Verkehrsmittel"], ["Wiener Linien", "Öffentliche Verkehrsmittel"],
    ["City Parkhaus", "Parken & Maut"], ["APCOA Parking", "Parken & Maut"], ["ASFINAG Vignette", "Parken & Maut"],
    ["Friseur", "Körperpflege"], ["Allianz Haftpflicht", "Versicherungen"], ["A1 Telekom", "Telefon & Internet"],
    ["AMEX Monatsgebühr", "Bankgebühren"],
    ["G2A.COM", "Guthabenkarten"], ["Guthabenkarte", "Guthabenkarten"], ["Apple-Guthaben", "Guthabenkarten"],
    ["Paysafecard", "Guthabenkarten"], ["Post", "Porto & Versand"], ["Österreichische Post AG", "Porto & Versand"],
    ["Kartenzahlung Oesterreichische Post", "Porto & Versand"], ["Deutsche Post", "Porto & Versand"],
    ["Postfiliale 9500", "Porto & Versand"], ["Post.at", "Porto & Versand"],
    ["DHL Paket", "Porto & Versand"], ["DPD", "Porto & Versand"], ["GLS", "Porto & Versand"],
    ["UPS", "Porto & Versand"], ["FedEx", "Porto & Versand"], ["Hermes Paketshop", "Porto & Versand"],
    ["Briefmarken", "Porto & Versand"], ["Paketversand", "Porto & Versand"],
    ["McDonalds", "Restaurants"], ["Wolt", "Lieferdienste"], ["Foodora", "Lieferdienste"],
    ["Lieferando", "Lieferdienste"], ["Uber Eats", "Lieferdienste"], ["Uber", "Mobilität"],
    ["Martin Auer", "Cafés & Snacks"], ["Starbucks", "Cafés & Snacks"], ["Café Linde", "Cafés & Snacks"],
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
  ] as const)("consolidates a legacy travel choice for %s outside everyday budgets", (description, category) => {
    expect(classify(booking(description)).category).toBe("Urlaub");
    expect(classify({ ...booking(description, category), categoryOverride: true }))
      .toMatchObject({ category: "Urlaub", includeInPlan: false, isTransfer: false });
    expect(isTravelCategory(category)).toBe(true);
  });

  it("does not infer purposes from providers, balances, place names or conflicting merchants", () => {
    for (const description of ["PayPal Europe Zahlung", "Kartenzahlung", "Fachhandel Linde"])
      expect(classify(booking(description)).category).toBe("Prüfen");
    for (const description of ["Postbank", "Postproduktion", "Guthaben", "PayPal Guthaben", "Hermes", "G2A DHL"])
      expect(classify(booking(description)).category).toBe("Prüfen");
    expect(classify(booking("Gasthaus Zur Post")).category).toBe("Restaurants");
    expect(classify({ ...booking("G2A", "Shopping"), categoryOverride: true }).category).toBe("Shopping");
    for (const [description, category] of [
      ["Thalia", "Bildung"], ["Udemy", "Bildung"], ["Miete", "Wohnen & Haushalt"],
      ["Stromrechnung", "Wohnen & Haushalt"], ["OEBB", "Öffentliche Verkehrsmittel"], ["Parkgebühr", "Parken & Maut"],
      ["Shell", "Mobilität"], ["Foodora", "Lieferdienste"],
    ]) expect(classify(booking(description)).category).toBe(category);
  });
});

describe("refund and returned-debit fee categories", () => {
  it.each([
    "Rücklastschriftgebühr", "Rücklastschriftgebühren", "Ruecklastschriftgebuehr",
    "Rücklastschrift-Entgelt", "Rücklastschrift Entgelt", "Rücklastschriftkosten",
    "Gebühr für Rücklastschrift", "Entgelt wegen einer Rücklastschrift",
  ])("recognizes the explicit fee %s, not returned principal", (description) => {
    expect(classify(booking(description, "Prüfen", -3.5)).category).toBe("Rücklastschriftgebühren");
  });

  it.each(["Bankgebühren", "Kontokosten", "Kontoführungsgebühr", "Kontoführungsentgelt", "Entgelt für die Kontoführung"])(
    "keeps generic account costs %s under Bankgebühren", (description) => {
      expect(classify(booking(description, "Prüfen", -5)).category).toBe("Bankgebühren");
    },
  );

  it.each([-100, 100])("does not infer a fee or income from ambiguous returned principal (%s)", (amount) => {
    for (const description of ["Rücklastschrift", "Rücklastschrift SEPA", "Ruecklastschrift", "Lastschriftretoure", "Rückerstattung",
      "Rücklastschrift 100 EUR inklusive Gebühr 3 EUR"])
      expect(classify(booking(description, "Prüfen", amount)).category).toBe("Prüfen");
  });

  it("imports explicit one-off fees without treating unresolved reversals as fees or creating contracts", () => {
    const original = synchronizePlan(stateWith([]));
    const fee = booking("Rücklastschriftgebühr", "Prüfen", -3.5);
    const prepared = prepareStatementImport([result([fee, booking("Rücklastschrift", "Prüfen", -100), booking("Rücklastschrift", "Prüfen", 100)])], original);
    expect(prepared.automatic).toEqual([expect.objectContaining({ ...fee, category: "Rücklastschriftgebühren" })]);
    expect(prepared.review).toHaveLength(2);
    expect(prepared.review.every((item) => item.kind === "booking" && item.draft.category === "Prüfen")).toBe(true);
    const imported = commitStatementImport(original, prepared.automatic, [], prepared.metadata).state;
    expect(imported.transactions).toHaveLength(1);
    expect(imported.financeRows).toEqual(original.financeRows);
    expect(imported.fixedReceipts ?? []).toEqual([]);
    expect(calculateDashboard(imported).current).toMatchObject({ received: 0, salaryReceived: 0, actualSpending: 3.5 });
  });

  it("keeps a manually selected positive refund out of salary and preserves it through JSON, Excel and reimport", async () => {
    const original = synchronizePlan(stateWith([]));
    const row = { ...booking("Erstattung Fachhandel Linde", "Rückerstattungen", 30), categoryOverride: true };
    const imported = commitStatementImport(original, [row]).state;
    const json = appStateSchema.parse(JSON.parse(JSON.stringify(imported)));
    const excel = (await parseWorkbook(await exportWorkbook(json))).state;
    for (const state of [imported, json, excel]) {
      expect(state.transactions[0]).toMatchObject({ ...row, category: "Rückerstattungen" });
      expect(state.merchantRules ?? []).toEqual(original.merchantRules ?? []);
      expect(calculateDashboard(state).current).toMatchObject({ received: 0, salaryReceived: 0, actualSpending: -30 });
      expect(state.financeRows).toEqual(original.financeRows);
      expect(statementFingerprint(state.transactions[0])).toBe(statementFingerprint(row));
      const next = prepareStatementImport([result([{ ...row, id: crypto.randomUUID(), date: "2026-09-03", category: "Prüfen", categoryOverride: false }])], state);
      expect(next.review).toEqual([]);
      expect(next.automatic[0]).toMatchObject({ category: "Rückerstattungen", amount: 30, categoryOverride: true });
    }
  });

  it("retains matched refunds in their original spending category", () => {
    const debit = { ...booking("Fachhandel Linde", "Shopping", -50), categoryOverride: true };
    const refund = { ...booking("Fachhandel Linde Erstattung", "Prüfen", 20), date: "2026-09-03" };
    const matched = classifyStatementRows([refund], [debit]);
    expect(matched[0]).toMatchObject({ ...refund, category: "Shopping", categoryOverride: true });
    expect(classify(booking("BILLA Erstattung", "Prüfen", 20)).category).toBe("Lebensmittel");
  });

  it("keeps matching shared repayments as transfers even when manually tagged as refunds", () => {
    const state = synchronizePlan(stateWith([]));
    state.transactions = [
      { ...booking("Sakura", "Restaurants", -80), categoryOverride: true, sharedWithRaphael: true },
      { ...booking("Raphael Piber Rückerstattung", "Rückerstattungen", 40), date: "2026-09-03", categoryOverride: true },
    ];
    const repayment = actualBookings(state).find((row) => row.amount > 0)!;
    expect(classify(repayment)).toMatchObject({ category: "Transfer", isTransfer: true, includeInPlan: false });
    expect(calculateDashboard(state).current).toMatchObject({ received: 0, salaryReceived: 0, actualSpending: 40 });
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

  it("consolidates a learned accommodation purpose for a recognized travel merchant after Excel reload", async () => {
    const original = synchronizePlan(stateWith([]));
    const row = { ...booking("Booking.com", "Unterkunft", -120), categoryOverride: true };
    const saved = commitStatementImport(original, [row]).state;
    const loaded = (await parseWorkbook(await exportWorkbook(saved))).state;
    expect(loaded.transactions[0]).toMatchObject({ category: "Urlaub", categoryOverride: true, includeInPlan: false });
    const next = prepareStatementImport([result([{ ...booking("Booking.com"), date: "2026-09-03" }])], loaded);
    expect(next.review).toHaveLength(0);
    expect(next.automatic[0]).toMatchObject({ category: "Urlaub", categoryOverride: true, includeInPlan: false });
  });

  it("migrates consolidated choices, learned rules and pending reviews without losing facts or duplicating imports", async () => {
    const original = synchronizePlan(stateWith([]));
    const legacyCategories = ["Ausgehen", "Kleidung & Schuhe", "Elektronik", "Bücher", "Unterkunft", "Flugreisen"] as const;
    const expected = ["Restaurants", "Shopping", "Shopping", "Bildung", "Urlaub", "Urlaub"];
    original.transactions = legacyCategories.map((category, index) => ({
      ...booking(`Fachhandel Linde ${index}`, category, -20), categoryOverride: true,
      includeInPlan: !isTravelCategory(category), time: "18:20:00", bankReference: `synthetic-${index}`,
      rawDescription: `Originalbuchung ${index}`, rawDetails: [`Beleg ${index}`], sourceCategory: category,
      occurrence: 1, afterBaseline: true, sharedWithRaphael: false, sharedPaidManually: false,
    }));
    original.merchantRules = original.transactions.map((row) => ({ key: merchantRuleKey(row), category: row.category }));
    original.reviewQueue = original.transactions.map((row, index) => ({
      kind: "booking", id: `pending-${index}`, draft: { ...row, id: `pending-${index}`, amount: null }, message: "Betrag fehlt",
    }));
    const json = appStateSchema.parse(JSON.parse(JSON.stringify(original)));
    const workbook = await parseWorkbook(await exportWorkbook(original));
    expect(workbook.warnings).toEqual([]);
    for (const restored of [json, workbook.state]) {
      expect(restored.transactions).toEqual(original.transactions.map((row, index) => ({ ...row, category: expected[index] })));
      expect(restored.merchantRules).toEqual(original.merchantRules.map((rule, index) => ({ ...rule, category: expected[index] })));
      expect(restored.reviewQueue).toEqual(original.reviewQueue.map((item, index) => item.kind === "booking" ? {
        ...item, draft: { ...item.draft, category: expected[index] },
      } : item));
      expect(queueLedgerReview(restored).transactions).toEqual(restored.transactions);
      expect(restored.transactions.map(statementFingerprint)).toEqual(original.transactions.map(statementFingerprint));
      expect(restored.financeRows).toEqual(original.financeRows);
      expect(calculateDashboard(restored).plan).toEqual(calculateDashboard(original).plan);
      expect(calculateDashboard(restored).current.actualSpending).toBe(calculateDashboard(original).current.actualSpending);
      const repeated = prepareStatementImport([result(original.transactions.map((row) => ({ ...row, id: `${row.id}-reimport` })))], restored);
      expect(repeated.duplicates).toBe(legacyCategories.length);
      expect(repeated.automatic).toEqual([]);
      const next = prepareStatementImport([result(original.transactions.map((row) => ({
        ...row, id: crypto.randomUUID(), date: "2026-09-03", bankReference: `${row.bankReference}-next`,
        category: "Prüfen", categoryOverride: false,
      })))], { ...restored, reviewQueue: [] });
      expect(next.review).toEqual([]);
      expect(next.automatic.map((row) => row.category)).toEqual(expected);
      expect(next.automatic.every((row) => row.categoryOverride)).toBe(true);
    }
  });

  it("refines trusted merchants on reload without overriding learned or manual choices", () => {
    const original = synchronizePlan(stateWith([]));
    original.transactions = [
      booking("G2A", "Freizeit"), booking("Foodora", "Ausgehen"), booking("Martin Auer", "Freizeit"),
      { ...booking("DHL Paket", "Shopping"), categoryOverride: true },
    ];
    const restored = queueLedgerReview(appStateSchema.parse(JSON.parse(JSON.stringify(original))));
    expect(restored.transactions.map((row) => row.category)).toEqual(["Guthabenkarten", "Lieferdienste", "Cafés & Snacks", "Shopping"]);
    expect(restored.transactions.map(statementFingerprint)).toEqual(original.transactions.map(statementFingerprint));
    expect(restored.reviewQueue).toEqual([]);
    const learned = appStateSchema.parse({
      ...original, merchantRules: [{ key: merchantRuleKey(original.transactions[0]), category: "Freizeit" }],
    });
    expect(queueLedgerReview(learned).transactions[0]).toMatchObject({ category: "Freizeit", categoryOverride: true });
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

describe("merchant rules for card texts", () => {
  it.each([
    ["MPG MÄRZPARKGARAGE WIEN", -12, "Parken & Maut"],
    ["BIP THEATERGARAGE KLAGE KLAGENFURT", -2, "Parken & Maut"],
    ["HM VILLACH AT0159 VILLACH", -124.16, "Shopping"],
    ["DR LEGRADI VILLACH 9500", -195, "Gesundheit"],
    ["BLUMEN B B FILNR902 VILLACH 9500", -34, "Geschenke & Spenden"],
    ["EUROPA PARK FREIZEIT RUST 77977", -5.5, "Freizeit"],
    ["PAYPAL *EPIC GAMES 9198540070", -11.99, "Entertainment"],
    ["PAYPAL *KINGUINDIGI 35529052 | KINGUIN DIGITAL LIMITED", -17.32, "Guthabenkarten"],
    ["PAYPAL *GENERALLOGI | General Logistics Systems Austria GmbH", -10.9, "Porto & Versand"],
    ["HOTEL ON BOOKING.COM AMSTERDAM", -661.56, "Urlaub"],
    ["ZAHLUNG/UBERWEISUNG ERHALTEN BESTEN DANK", 1446.65, "Transfer intern"],
    ["ZAHLUNG/ÜBERWEISUNG ERHALTEN BESTEN DANK", 310, "Transfer intern"],
  ] as const)("%s => %s", (text, amount, category) => {
    expect(knownMerchantCategory(text, amount)).toBe(category);
  });

  it("leaves a drink at a local hotel and a law office open", () => {
    expect(knownMerchantCategory("Schlosshotel Velden Gmb Velden am Wörth", -20)).toBeUndefined();
    expect(knownMerchantCategory("DR HUBER RECHTSANWALT KANZLEI", -300)).toBeUndefined();
  });
});
