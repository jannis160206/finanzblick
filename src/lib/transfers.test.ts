import { describe, expect, it } from "vitest";
import { applyNamedTransfer, isNamedTransfer } from "./transfers";
import { actualBookings, calculateDashboard, classify, classifyStatementRows } from "./calc";
import { createSeed } from "./seed";
import { type AppState, type FixedChange, type Transaction } from "./types";
import { applyFixedDecisions, commitStatementImport, prepareStatementImport, queueLedgerReview } from "./import/review";
import { merchantRuleKey } from "./import/merchant-rules";
import { statementFingerprint } from "./import/identity";
import { reconcileSharedHoliday } from "./shared-holiday";
import { synchronizePlan } from "./planning";
import { exportWorkbook, parseWorkbook } from "./excel";

const row = (description: string, patch: Partial<Transaction> = {}): Transaction => ({
  id: description, description, amount: -65, date: "2026-10-01", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
  category: "Shopping", includeInPlan: true, categoryOverride: true, manualCategory: true, reviewed: true, ...patch,
});
const fixture = (transactions: Transaction[] = []): AppState => {
  const seed = createSeed();
  return { ...seed, transactions, financeRows: [], settings: { ...seed.settings, asOf: "2026-10-05" },
    reviewQueue: [], plannedOneOffs: [], plannedOneOffsSeeded: true, savingsGoals: [] };
};

describe("requested transfer names", () => {
  it.each([
    "Einzahlung", "BAREINZAHLUNG GELDAUTOMAT", "einzahlung auf Konto",
    "Transfer", "TRANSFER VON REVOLUT", "Airport Transfer",
    "JANNIS BRÜHL", "JANNIS BRUHL", "JANNIS BRUEHL", "Jannis Brühl",
    "Überweisung Jannis   Brühl", "Transfer Jannis Bruehl",
    "BRÜHL, JANNIS", "Bruehl Jannis", "Empfänger: Jannis Brühl",
  ])("classifies %s as Transfer for incoming and outgoing transactions, including old manual choices", (description) => {
    for (const amount of [-65, 65]) {
      const original = row(description, { amount, fixedCost: true, sharedWithRaphael: true, sharedPaidManually: true });
      expect(classify(original)).toMatchObject({ category: "Transfer", planCategory: "Transfer", isTransfer: true,
        isFixedCost: false, includeInPlan: false });
      const updated = applyNamedTransfer(original);
      expect(updated).toEqual({ ...original, category: "Transfer", includeInPlan: false,
        fixedCost: false, sharedWithRaphael: false, sharedPaidManually: false });
      expect(statementFingerprint(updated)).toBe(statementFingerprint(original));
      expect(original.category).toBe("Shopping");
      expect(applyNamedTransfer(updated)).toBe(updated);
      expect(classifyStatementRows([original])[0]).toEqual(updated);
    }
  });

  it("uses displayed and original booking names but not statement holder metadata or category names", () => {
    expect(isNamedTransfer(row("POS 123", { rawDescription: "Einzahlung am Schalter" }))).toBe(true);
    expect(isNamedTransfer(row("Sonstiges", { merchantAlias: "Transfer zum Sparkonto" }))).toBe(true);
    for (const description of ["BILLA", "Raphael Piber", "Jannis Mueller", "Jannismo Bruehl", "Jannis Bruehler"])
      expect(isNamedTransfer(row(description, { rawDetails: ["Karteninhaber JANNIS BRUEHL"], sourceCategory: "Transfer" }))).toBe(false);
    expect(classify(row("Amazon", { bank: "Amex", pocket: "AMEX Jannis", rawDetails: ["Neue Belastungen für JANNIS BRUEHL"] })).category).toBe("Shopping");
  });

  it("repairs existing ledger, learned rules and fixed receipts without changing bank facts or unrelated bookings", () => {
    const transfer = row("Einzahlung", { fixedCost: true, sharedWithRaphael: true });
    const receiptBooking = row("Jannis Brühl", { id: "receipt", category: "Versicherungen", fixedCost: true });
    const other = row("BILLA", { category: "Lebensmittel" });
    const state = fixture([transfer, other]);
    state.fixedReceipts = [{ key: statementFingerprint(receiptBooking), merchantKey: merchantRuleKey(receiptBooking),
      date: receiptBooking.date, category: receiptBooking.category, amount: receiptBooking.amount,
      booking: receiptBooking, rowId: "old-contract" }];
    state.merchantRules = [{ key: merchantRuleKey(transfer), category: "Shopping", fixedCost: true }];
    const repaired = queueLedgerReview(state);
    expect(repaired.transactions).toEqual([applyNamedTransfer(transfer), other]);
    expect(repaired.fixedReceipts?.[0]).toMatchObject({ category: "Transfer", rowId: undefined, booking: applyNamedTransfer(receiptBooking) });
    expect(repaired.merchantRules).toEqual([{ key: merchantRuleKey(transfer), category: "Transfer", fixedCost: false }]);
    expect(repaired.reviewQueue).toEqual([]);
    expect(actualBookings(repaired).filter((item) => classify(item).isTransfer)).toHaveLength(2);
    expect(reconcileSharedHoliday(repaired.transactions).receivables).toEqual([]);
    expect(calculateDashboard(repaired).current.actualSpending).toBe(65);
  });

  it("automatically promotes old fixed-cost and booking questions that are now transfers", () => {
    const first = row("Transfer vom Sparkonto", { category: "Versicherungen" });
    const second = row("JANNIS BRUEHL", { id: "pending", category: "Prüfen", categoryOverride: false, manualCategory: false });
    const state = fixture();
    state.reviewQueue = [
      { kind: "fixed", id: "old-rate", change: { id: "old-rate", category: "Versicherungen", month: "2026-10",
        previous: 63.25, amount: 65, bookings: [first] } },
      { kind: "booking", id: second.id, draft: second, message: "Händler noch nicht sicher zugeordnet." },
    ];
    const updated = queueLedgerReview(state);
    expect(updated.reviewQueue).toEqual([]);
    expect(updated.transactions.map((item) => item.category)).toEqual(["Transfer", "Transfer"]);
    expect(updated.financeRows).toEqual([]);
    expect(queueLedgerReview(updated).transactions).toEqual(updated.transactions);
  });

  it("keeps incomplete OCR transfers in review instead of treating an unknown amount as zero", () => {
    const state = fixture();
    state.reviewQueue = [{ kind: "booking", id: "ocr", message: "Betrag prüfen",
      draft: { ...row("Transfer"), id: "ocr", amount: null, bank: "Amex", rawDetails: ["Amex-Screenshot"] } }];
    const updated = queueLedgerReview(state);
    expect(updated.transactions).toEqual([]);
    expect(updated.reviewQueue).toHaveLength(1);
  });

  it("retains unrelated bookings from a mixed fixed-cost question while promoting only the transfer", () => {
    const transfer = row("Transfer von Jannis Brühl", { category: "Versicherungen" });
    const contract = row("Allianz Versicherung", { category: "Versicherungen" });
    const state = fixture();
    const change: FixedChange = {
      id: "mixed", category: "Versicherungen", month: "2026-10", previous: 63.25, amount: 65,
      bookings: [transfer, contract],
    };
    state.reviewQueue = [{ kind: "fixed", id: "mixed", change }];
    const updated = queueLedgerReview(state);
    expect(updated.transactions).toEqual([{ ...applyNamedTransfer(transfer), occurrence: 1 }]);
    expect(updated.reviewQueue).toEqual([{ kind: "fixed", id: "mixed", change: { ...change, bookings: [contract] } }]);
  });

  it("removes a generated fixed row when its source is reclassified as a transfer", () => {
    const original = row("Privater Betrag", { fixedCost: true });
    const state = synchronizePlan(queueLedgerReview(fixture([original])));
    expect(state.financeRows.some((item) => item.fixedSource)).toBe(true);
    state.transactions = [{ ...original, description: "Transfer privater Betrag" }];
    const updated = synchronizePlan(queueLedgerReview(state));
    expect(updated.transactions[0]).toMatchObject({ category: "Transfer", fixedCost: false });
    expect(updated.financeRows.some((item) => item.fixedSource)).toBe(false);
    expect(updated.financeRows.filter((item) => item.kind === "variable")).toEqual(
      state.financeRows.filter((item) => item.kind === "variable"));
  });

  it("imports future matching bookings automatically without fixed-price questions or misleading learned rules", () => {
    const booking = row("JANNIS BRUHL", { category: "Prüfen", categoryOverride: false, manualCategory: false, reviewed: false });
    const state = fixture();
    state.merchantRules = [{ key: merchantRuleKey(booking), category: "Versicherungen", fixedCost: true }];
    state.financeRows = [{ id: "contract", label: "Versicherungen", kind: "fixed", values: { "2026-10": 63.25 } }];
    const prepared = prepareStatementImport([{ source: "Raiffeisen", file: "new.csv", rows: [booking], issues: [], skipped: 0 }], state);
    expect(prepared.automatic).toHaveLength(1);
    expect(prepared.review).toEqual([]);
    const result = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
    expect(result.transactions[0]).toMatchObject({ category: "Transfer", includeInPlan: false });
    expect(result.financeRows).toEqual(state.financeRows);
    expect(commitStatementImport(result, prepared.automatic).state.transactions).toHaveLength(1);
  });

  it("ignores stale rate approvals for named transfers but retains the bank booking", () => {
    const booking = row("Einzahlung", { category: "Versicherungen" });
    const change: FixedChange = { id: "stale", category: "Versicherungen", month: "2026-10", previous: 63.25,
      amount: 65, bookings: [booking], rowId: "insurance" };
    const state = fixture();
    state.financeRows = [{ id: "insurance", kind: "fixed", label: "Versicherungen", values: { "2026-10": 63.25 } }];
    expect(applyFixedDecisions(state, [{ change, accept: true }]).financeRows).toEqual(state.financeRows);
    const result = commitStatementImport(state, [], [{ change, accept: true }]).state;
    expect(result.financeRows).toEqual(state.financeRows);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].category).toBe("Transfer");
  });

  it("keeps the reclassification after JSON and Excel roundtrip without touching unrelated categories", async () => {
    const state = synchronizePlan(queueLedgerReview(fixture([row("Transfer"), row("BILLA", { category: "Lebensmittel" })])));
    expect(queueLedgerReview(JSON.parse(JSON.stringify(state))).transactions).toEqual(state.transactions);
    const restored = (await parseWorkbook(await exportWorkbook(state))).state;
    expect(restored.transactions).toEqual(state.transactions);
    expect(queueLedgerReview(restored).transactions).toEqual(state.transactions);
  });
});
