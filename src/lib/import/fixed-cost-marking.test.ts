import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { actualBookings, calculateDashboard, classify, classifyStatementRows, missingFixedCosts } from "@/lib/calc";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { matchingFixedRow } from "@/lib/fixed";
import { createSeed } from "@/lib/seed";
import { appStateSchema, transactionSchema, type AppState, type Transaction } from "@/lib/types";
import { variableBudgetId } from "@/lib/variable-budgets";
import { approveReviewedBooking } from "./approve-review";
import { statementFingerprint } from "./identity";
import { applyMerchantRules, merchantRuleKey, rememberMerchants } from "./merchant-rules";
import { commitStatementImport, prepareStatementImport, queueLedgerReview, splitFixedBookings } from "./review";
import type { StatementResult } from "./statements";

const booking = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: "phone",
  date: "2026-09-03",
  bank: "Raiffeisen",
  pocket: "Testkonto",
  description: "Nordlicht Mobil",
  amount: -24,
  category: "Telefon & Internet",
  categoryOverride: true,
  includeInPlan: true,
  ...overrides,
});
const fixture = (overrides: Partial<AppState> = {}): AppState => appStateSchema.parse({
  ...createSeed(),
  transactions: [],
  financeRows: [],
  fixedReceipts: [],
  fixedAmountDecisions: [],
  merchantRules: [],
  ignoredStatementKeys: [],
  reviewQueue: [],
  holidayRanges: [],
  ...overrides,
});
const pending = (draft: Transaction) => ({ kind: "booking" as const, id: draft.id, draft, message: "Zuordnung prüfen." });
const statement = (rows: Transaction[]): StatementResult => ({
  file: "synthetic.csv", source: "Raiffeisen", rows, issues: [], skipped: 0,
});
const phonePlan: AppState["financeRows"] = [{
  id: "phone-plan", label: "Telefon & Internet", kind: "fixed",
  values: { "2026-09": 20, "2026-10": 20 },
}];
const bufferActual = (state: AppState) => calculateDashboard(state).plan.rows.find((row) => row.id === "buffer")!.actual;

describe("per-booking fixed expense marking", () => {
  it.each(["Telefon & Internet", "Abonnements", "Versicherungen", "Miete", "Shopping"] as const)(
    "separates the checkbox from the %s category", (category) => {
      expect(classify(booking({ category, fixedCost: true }))).toMatchObject({ isFixedCost: true, includeInPlan: false });
      expect(classify(booking({ category, fixedCost: false }))).toMatchObject({ isFixedCost: false, includeInPlan: true });
      expect(variableBudgetId(category, false)).toBe("buffer");
      expect(variableBudgetId(category, true)).toBeUndefined();
    },
  );

  it.each([true, false, undefined])("never marks incomes or internal transfers (%s)", (fixedCost) => {
    for (const row of [
      booking({ amount: 2400, description: "Gehalt September", category: "Einkommen", fixedCost }),
      booking({ description: "Interne Überweisung", fixedCost }),
      booking({ amount: 24, fixedCost }),
    ]) expect(classify(row).isFixedCost).toBe(false);
    expect(classify(booking({ description: "Interne Überweisung", fixedCost }))).toMatchObject({
      category: "Transfer intern", isTransfer: true, includeInPlan: false,
    });
    expect(variableBudgetId("Einkommen", fixedCost)).toBeUndefined();
  });

  it.each([true, false])("imports a newly reviewed phone once without creating a plan (%s)", (fixedCost) => {
    const draft = booking({ category: "Prüfen", categoryOverride: undefined, includeInPlan: false,
      rawDescription: "Nordlicht Mobil Original", bankReference: "phone-reference" });
    const state = fixture({ reviewQueue: [pending(draft)] });
    const before = structuredClone(state);
    const selected = booking({ fixedCost, rawDescription: "Nordlicht Mobil Original", bankReference: "phone-reference" });
    const result = commitStatementImport(state, [selected]);
    expect(state).toEqual(before);
    expect(result.changes).toEqual([]);
    expect(result.state.financeRows).toEqual([]);
    expect(result.state.fixedAmountDecisions).toEqual([]);
    expect(result.state.transactions).toHaveLength(1);
    expect(result.state.transactions[0]).toMatchObject({ ...selected, includeInPlan: !fixedCost });
    expect(result.state.fixedReceipts).toEqual([]);
    expect(actualBookings(result.state)).toHaveLength(1);
    expect(classify(result.state.transactions[0])).toMatchObject({ isFixedCost: fixedCost, includeInPlan: !fixedCost });
    expect(calculateDashboard(result.state).current.actualSpending).toBe(24);
    expect(calculateDashboard(result.state).current.fixed).toBe(0);
    expect(bufferActual(result.state)).toBe(fixedCost ? 0 : 24);
    expect(result.state.reviewQueue).toEqual([]);
  });

  it.each([true, false])("does not trigger existing contract price changes (%s)", (fixedCost) => {
    const state = fixture({ financeRows: phonePlan });
    const result = commitStatementImport(state, [booking({ fixedCost })]);
    expect(result.state.financeRows).toEqual(phonePlan);
    expect(result.changes).toEqual([]);
    expect(result.state.fixedAmountDecisions).toEqual([]);
    expect(result.state.ignoredStatementKeys).toEqual([]);
    expect(result.state.fixedReceipts).toHaveLength(fixedCost ? 1 : 0);
    expect(actualBookings(result.state)).toHaveLength(1);
    expect(calculateDashboard(result.state).current.actualSpending).toBe(24);
    expect(missingFixedCosts(result.state)).toEqual(fixedCost ? [] : ["Telefon & Internet"]);
    expect(matchingFixedRow(state, "Telefon & Internet", booking({ fixedCost }))?.id).toBe(fixedCost ? "phone-plan" : undefined);
  });

  it("does not match a new provider to an unrelated named phone contract", () => {
    const state = fixture({ financeRows: [{ ...phonePlan[0], label: "Handyvertrag A1" }] });
    const result = commitStatementImport(state, [booking({ fixedCost: true })]);
    expect(result.state.fixedReceipts).toEqual([]);
    expect(result.state.financeRows).toEqual(state.financeRows);
    expect(missingFixedCosts(result.state)).toEqual(["Handyvertrag A1"]);
  });

  it("does not invent a contract receipt for a previously ignored marked booking", () => {
    const original = booking({ fixedCost: true });
    const state = fixture({ ignoredStatementKeys: [statementFingerprint(original)] });
    const result = commitStatementImport(state, [original]);
    expect(result.duplicates).toBe(1);
    expect(result.state.fixedReceipts).toEqual([]);
    expect(actualBookings(result.state)).toEqual([]);
    expect(result.state.financeRows).toEqual([]);
  });

  it("preserves the legacy category-inferred price review and initial planning", () => {
    expect(classify(booking())).toMatchObject({ isFixedCost: true, includeInPlan: false });
    expect(splitFixedBookings(fixture({ financeRows: phonePlan }), [booking()]).changes).toHaveLength(1);
    expect(commitStatementImport(fixture(), [booking()]).state.financeRows).toHaveLength(1);
  });

  it.each([true, false])("edits an existing ledger review in place and can restore its snapshot (%s)", (fixedCost) => {
    const original = booking({ category: "Prüfen", categoryOverride: undefined, time: "13:04:05",
      rawDescription: "Nordlicht Mobil Original", rawDetails: ["Vertrag 123"], bankReference: "original-ref" });
    const state = fixture({ transactions: [original], reviewQueue: [pending(original)], financeRows: phonePlan });
    const before = structuredClone(state);
    const selected = { ...original, category: "Telefon & Internet" as const, categoryOverride: true, fixedCost,
      amount: -1, date: "2026-09-02", rawDescription: "stale description", bankReference: "stale-reference" };
    const result = commitStatementImport(state, [selected]);
    expect(result.added).toBe(0);
    expect(result.state.transactions).toHaveLength(1);
    expect(result.state.transactions[0]).toMatchObject({ ...original, category: selected.category,
      categoryOverride: true, fixedCost, includeInPlan: !fixedCost });
    expect(result.state.fixedReceipts).toEqual([]);
    expect(result.state.financeRows).toEqual(phonePlan);
    expect(calculateDashboard(result.state).current.actualSpending).toBe(24);
    expect(state).toEqual(before);
    expect(appStateSchema.parse(JSON.parse(JSON.stringify(before)))).toEqual(state);
  });

  it.each([true, false])("updates receipt-only reviews without duplicating cash or retaining stale suppression (%s)", (fixedCost) => {
    const original = booking();
    const key = statementFingerprint(original);
    const state = fixture({ financeRows: phonePlan, fixedReceipts: [{
      key, merchantKey: merchantRuleKey(original), booking: original,
      rowId: "phone-plan", date: original.date, amount: original.amount, category: original.category,
    }] });
    const selected = { ...actualBookings(state)[0], fixedCost, includeInPlan: true };
    state.reviewQueue = [pending(selected)];
    const result = commitStatementImport(state, [selected]);
    expect(result.state.transactions).toHaveLength(1);
    expect(actualBookings(result.state)).toHaveLength(1);
    expect(actualBookings(result.state)[0]).toMatchObject({ amount: -24, fixedCost });
    expect(result.state.fixedReceipts).toHaveLength(fixedCost ? 1 : 0);
    expect(result.state.financeRows).toEqual(phonePlan);
    expect(calculateDashboard(result.state).current.actualSpending).toBe(24);
    expect(bufferActual(result.state)).toBe(fixedCost ? 0 : 24);
  });

  it("keeps existing and queued same-merchant marks independent while learning categories", () => {
    const normal = booking({ id: "normal", date: "2026-09-01", fixedCost: false });
    const fixed = booking({ id: "fixed", date: "2026-09-02", fixedCost: true });
    const selected = booking({ id: "selected", date: "2026-09-03", fixedCost: false });
    const queued = booking({ id: "queued", date: "2026-09-04", fixedCost: true });
    const state = fixture({ transactions: [normal, fixed], reviewQueue: [pending(selected), pending(queued)] });
    const result = commitStatementImport(state, [selected]);
    expect(result.state.transactions.map((row) => [row.id, row.fixedCost])).toEqual([
      ["normal", false], ["fixed", true], ["selected", false], ["queued", true],
    ]);
    expect(result.state.financeRows).toEqual([]);
    expect(bufferActual(result.state)).toBe(48);
    expect(calculateDashboard(result.state).current.actualSpending).toBe(96);
    expect(result.state.merchantRules).toEqual([{ key: merchantRuleKey(selected), category: selected.category, fixedCost: false }]);
    const future = applyMerchantRules(result.state, [booking({ id: "future", date: "2026-10-03", category: "Prüfen", categoryOverride: undefined })])[0];
    expect(future.fixedCost).toBe(false);
    expect(classify(future).isFixedCost).toBe(false);
    const changed = rememberMerchants(result.state, [{ ...selected, category: "Shopping" }]);
    expect(changed.transactions.map((row) => row.fixedCost)).toEqual([false, true, false, true]);
  });

  it.each([true, false])("retains per-booking flags after JSON reload, reimport and queue repair (%s)", (fixedCost) => {
    const original = booking({ fixedCost });
    const state = commitStatementImport(fixture({ financeRows: phonePlan }), [original]).state;
    const loaded = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    const incoming = booking({ id: "reimported", fixedCost: undefined, categoryOverride: undefined, category: "Prüfen" });
    const prepared = prepareStatementImport([statement([incoming])], loaded);
    const result = queueLedgerReview(commitStatementImport(loaded, prepared.automatic, [], prepared.metadata).state);
    expect(actualBookings(result)).toHaveLength(1);
    expect(result.transactions[0].fixedCost).toBe(fixedCost);
    expect(result.financeRows).toEqual(phonePlan);
    expect(bufferActual(result)).toBe(fixedCost ? 0 : 24);
  });

  it.each([true, false])("remembers %s only for future imports, without changing old markers or planning contracts", async (fixedCost) => {
    const older = booking({ id: "older", date: "2026-08-03", categoryOverride: undefined });
    const opposite = booking({ id: "opposite", date: "2026-09-01", fixedCost: !fixedCost });
    const reviewed = booking({ fixedCost });
    let state = commitStatementImport(fixture({ transactions: [older, opposite] }), [reviewed]).state;
    expect(state.merchantRules).toEqual([{ key: merchantRuleKey(reviewed), category: reviewed.category, fixedCost }]);
    state = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    const workbook = await parseWorkbook(await exportWorkbook(state));
    expect(workbook.state.merchantRules).toEqual(state.merchantRules);
    state = queueLedgerReview(state);
    expect(state.transactions.find((row) => row.id === older.id)?.fixedCost).toBeUndefined();
    expect(state.transactions.find((row) => row.id === opposite.id)?.fixedCost).toBe(!fixedCost);
    const incoming = booking({ id: "future", date: "2026-09-04", category: "Prüfen", categoryOverride: undefined });
    const prepared = prepareStatementImport([statement([incoming])], state);
    expect(prepared.automatic).toHaveLength(1);
    expect(prepared.automatic[0].fixedCost).toBe(fixedCost);
    const next = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
    expect(next.financeRows).toEqual(state.financeRows);
    expect(next.fixedAmountDecisions).toEqual([]);
    expect(next.transactions.find((row) => row.id === incoming.id)?.fixedCost).toBe(fixedCost);
    expect(classify(next.transactions.find((row) => row.id === incoming.id)!)).toMatchObject({
      isFixedCost: fixedCost, includeInPlan: !fixedCost,
    });
  });

  it("keeps future merchant modes intact through unrelated fast-path approvals", () => {
    const draft = booking({ category: "Prüfen", categoryOverride: undefined });
    const state = fixture({ reviewQueue: [pending(draft)], merchantRules: [
      { key: "raiffeisen|anderer handyvertrag", category: "Telefon & Internet", fixedCost: true },
      { key: "raiffeisen|anderer laden", category: "Abonnements", fixedCost: false },
    ] });
    const selected = booking({ category: "Shopping", fixedCost: false });
    const fast = approveReviewedBooking(state, selected);
    const full = commitStatementImport(state, [selected]);
    expect(fast).toBeDefined();
    expect(fast).toEqual({ ...full, state: queueLedgerReview(full.state) });
    expect(fast!.state.merchantRules).toEqual([...state.merchantRules!, {
      key: merchantRuleKey(selected), category: selected.category, fixedCost: false,
    }]);
  });

  it("preserves sharing, holiday and reimbursement accounting with explicit markers", () => {
    const shared = booking({ fixedCost: true, sharedWithRaphael: true, amount: -100 });
    const repayment = booking({ id: "repayment", date: "2026-09-04", amount: 50, description: "Raphael Piber",
      category: "Einkommen", fixedCost: true });
    const state = fixture({ transactions: [shared, repayment], holidayRanges: [{ from: "2026-09-01", to: "2026-09-05" }] });
    expect(actualBookings(state).map((row) => classify(row).isFixedCost)).toEqual([true, false]);
    expect(calculateDashboard(state).current.actualSpending).toBe(50);
    expect(bufferActual(state)).toBe(0);
    expect(actualBookings(state)[0]).not.toHaveProperty("holidayRange");
    expect(classify(actualBookings(state)[1])).toMatchObject({ category: "Transfer", isTransfer: true });
  });

  it("persists true, false and legacy omission in schema and visible/hidden Excel data", async () => {
    const rows = [true, false, undefined].map((fixedCost, index) =>
      booking({ id: `excel-${index}`, date: `2026-09-0${index + 1}`, ...(fixedCost === undefined ? {} : { fixedCost }) }));
    const state = fixture({ transactions: rows, reviewQueue: rows.map(pending), fixedReceipts: [{
      key: statementFingerprint(rows[0]), date: rows[0].date, category: rows[0].category, amount: rows[0].amount, booking: rows[0],
    }] });
    expect(rows.map((row) => transactionSchema.parse(row).fixedCost)).toEqual([true, false, undefined]);
    const buffer = await exportWorkbook(state);
    const restored = await parseWorkbook(buffer);
    expect(restored.state.transactions.map((row) => row.fixedCost)).toEqual([true, false, undefined]);
    expect(restored.state.reviewQueue?.map((item) => item.kind === "booking" && item.draft.fixedCost)).toEqual([true, false, undefined]);
    expect(restored.state.fixedReceipts?.[0].booking?.fixedCost).toBe(true);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet("Umsätze")!;
    const column = (sheet.getRow(1).values as string[]).indexOf("Fixkosten");
    expect(column).toBeGreaterThan(0);
    expect([2, 3, 4].map((index) => sheet.getRow(index).getCell(column).value)).toEqual(["Ja", "Nein", ""]);
    sheet.getRow(2).getCell(column).value = "Nein";
    sheet.getRow(3).getCell(column).value = "Ja";
    const edited = await parseWorkbook(Uint8Array.from(new Uint8Array(await workbook.xlsx.writeBuffer())).buffer);
    expect(edited.state.transactions.map((row) => row.fixedCost)).toEqual([false, true, undefined]);
  });

  it("an explicitly normal ledger booking takes precedence over stale receipt metadata", () => {
    const original = booking({ fixedCost: true });
    const state = commitStatementImport(fixture({ financeRows: phonePlan }), [original]).state;
    state.transactions[0] = { ...state.transactions[0], fixedCost: false, includeInPlan: true };
    expect(actualBookings(state)).toHaveLength(1);
    expect(missingFixedCosts(state)).toEqual(["Telefon & Internet"]);
    expect(bufferActual(state)).toBe(24);
  });

  it("keeps refunds of explicitly ordinary phone payments in the same variable budget", () => {
    const debit = booking({ fixedCost: false });
    const initial = commitStatementImport(fixture(), [debit]).state;
    const refund = booking({
      id: "refund", date: "2026-09-04", amount: 12, category: "Prüfen", categoryOverride: undefined,
    });
    const prepared = prepareStatementImport([statement([refund])], initial);
    expect(prepared.automatic[0]).toMatchObject({
      amount: 12, category: "Telefon & Internet", fixedCost: false, includeInPlan: true,
    });
    const saved = commitStatementImport(initial, prepared.automatic, [], prepared.metadata).state;
    expect(bufferActual(saved)).toBe(12);
    expect(calculateDashboard(saved).current).toMatchObject({ actualSpending: 12, received: 0 });
    const matched = classifyStatementRows([{ ...refund, description: `${debit.description} Erstattung` }], [debit]);
    expect(matched[0]).toMatchObject({ category: debit.category, fixedCost: false, includeInPlan: true });
  });

  it("reports invalid Excel marking values instead of silently turning them into ordinary bookings", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Umsätze");
    sheet.addRow(["Datum", "Beschreibung", "Betrag", "Bank", "Kategorie", "Fixkosten"]);
    sheet.addRow(["2026-09-03", "Gültiger Vertrag", -24, "Testbank", "Telefon & Internet", "Ja"]);
    sheet.addRow(["2026-09-04", "Ungültige Markierung", -24, "Testbank", "Telefon & Internet", "Vielleicht"]);
    const result = await parseWorkbook(Uint8Array.from(new Uint8Array(await workbook.xlsx.writeBuffer())).buffer);
    expect(result.skipped).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.state.transactions).toHaveLength(1);
    expect(result.state.transactions[0]).toMatchObject({ description: "Gültiger Vertrag", fixedCost: true });
  });

  it.each([true, false])("keeps the mark when reconciling two representations of one leasing debit (%s)", (fixedCost) => {
    const legacy = booking({ id: "xlsx-42", category: "Leasing", description: "Porsche Bank Leasing S123AB",
      pocket: null, fixedCost });
    const imported = { ...legacy, id: "statement-42", pocket: "Giro", bankReference: "leasing-reference",
      fixedCost: undefined, description: "Porsche Bank Leasing S123AB Originalmandat" };
    const state = fixture({ transactions: [legacy, imported] });
    const actual = actualBookings(state);
    expect(actual).toHaveLength(1);
    expect(actual[0]).toMatchObject({ id: imported.id, fixedCost, amount: -24 });
    expect(classify(actual[0]).isFixedCost).toBe(fixedCost);
  });

  it("keeps ordinary false approvals on the fast path and preserves exact full-import equivalence", () => {
    const draft = booking({ category: "Prüfen", categoryOverride: undefined });
    const state = fixture({ reviewQueue: [pending(draft)] });
    const selected = booking({ fixedCost: false });
    const actual = approveReviewedBooking(state, selected);
    const full = commitStatementImport(state, [selected]);
    expect(actual).toBeDefined();
    expect(actual).toEqual({ ...full, state: queueLedgerReview(full.state) });
    expect(actual!.state.transactions[0].fixedCost).toBe(false);
    expect(approveReviewedBooking(state, { ...selected, fixedCost: true })).toBeUndefined();
  });

  it.each(["Shopping", "Telefon & Internet"] as const)("preserves an explicit normal mark on duplicate queued %s rows", (category) => {
    const first = booking({ id: "first", category: "Prüfen", categoryOverride: undefined, bankReference: "same-booking" });
    const second = { ...first, id: "second" };
    const state = fixture({ reviewQueue: [pending(first), pending(second)] });
    const selected = { ...first, category, categoryOverride: true, fixedCost: false };
    const full = commitStatementImport(state, [selected]);
    const fast = approveReviewedBooking(state, selected);
    expect(fast).toBeDefined();
    expect(fast).toEqual({ ...full, state: queueLedgerReview(full.state) });
    expect(fast!.state.transactions).toHaveLength(1);
    expect(fast!.state.transactions[0].fixedCost).toBe(false);
  });
});
