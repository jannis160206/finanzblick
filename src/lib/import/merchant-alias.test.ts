import { describe, expect, it } from "vitest";
import { actualBookings, classify } from "@/lib/calc";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type FixedChange, type Transaction } from "@/lib/types";
import { approveReviewedBooking } from "./approve-review";
import { statementFingerprint } from "./identity";
import { applyMerchantRules, merchantRuleKey, rememberMerchants } from "./merchant-rules";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "./review";
import type { StatementResult } from "./statements";

const booking = (patch: Partial<Transaction> = {}): Transaction => ({
  id: "original", bank: "Raiffeisen", pocket: "Raiffeisen Giro", date: "2026-09-01",
  description: "Sonstiges IBAN Empfaenger: AT000000000000000001 BIC Empfaenger: TESTATXX Empfaenger: Musterstrasse 15 9020 Klagenfurt",
  category: "Sonstiges", amount: -3, includeInPlan: true, ...patch,
});
const pending = (draft: Transaction) => ({
  kind: "booking" as const, id: draft.id, draft, message: "Haendler noch nicht sicher zugeordnet.",
});
const fixture = (patch: Partial<AppState> = {}): AppState => appStateSchema.parse({
  ...createSeed(), transactions: [], financeRows: [], reviewQueue: [], fixedReceipts: [],
  merchantRules: [], holidayRanges: [], ...patch,
});
const statement = (rows: Transaction[]): StatementResult => ({
  file: "synthetic.csv", source: "Raiffeisen", rows, issues: [], skipped: 0,
});
const choose = (row = booking(), patch: Partial<Transaction> = {}): Transaction => ({
  ...row, merchantAlias: "Hausverwaltung", category: "Miete", categoryOverride: true,
  manualCategory: true, reviewed: true, fixedCost: true, ...patch,
});
const approve = (state: AppState, selected = choose()) =>
  queueLedgerReview(commitStatementImport(state, [selected]).state);

describe("remembered review merchant names", () => {
  it.each([false, true])("saves a name on a pending or stored booking without changing its bank identity (stored=%s)", (stored) => {
    const original = booking({
      rawDescription: "Unveraenderter synthetischer Banktext",
      rawDetails: ["Synthetische Details"], bankReference: "synthetic-reference", occurrence: 1,
    });
    const state = fixture({ transactions: stored ? [original] : [], reviewQueue: [pending(original)] });
    const before = structuredClone(state);
    const selected = choose(original);
    expect(approveReviewedBooking(state, selected)).toBeUndefined();
    const saved = approve(state, selected);
    expect(state).toEqual(before);
    expect(saved.transactions).toEqual([{ ...selected, includeInPlan: false }]);
    expect(saved.reviewQueue).toEqual([]);
    expect(saved.financeRows).toEqual(before.financeRows);
    expect(statementFingerprint(saved.transactions[0])).toBe(statementFingerprint(original));
    expect(classify(saved.transactions[0]).merchant).toBe("Hausverwaltung");
    expect(saved.merchantRules).toContainEqual({
      key: merchantRuleKey(original), category: "Miete", fixedCost: true, merchantAlias: "Hausverwaltung",
    });
    const reimport = prepareStatementImport([statement([{ ...original, id: "reimport" }])], saved);
    expect(reimport.automatic).toEqual([]);
    expect(reimport.review).toEqual([]);
    expect(reimport.duplicates).toBe(1);
    const repeated = commitStatementImport(saved, reimport.automatic, [], reimport.metadata).state;
    expect(repeated.transactions).toEqual(saved.transactions);
  });

  it.each([true, false])("learns name, category and future fixed mode across JSON and Excel (%s)", async (fixedCost) => {
    const original = booking();
    const selected = choose(original, { fixedCost });
    const state = approve(fixture({ reviewQueue: [pending(original)] }), selected);
    const json = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    const excel = (await parseWorkbook(await exportWorkbook(json))).state;
    expect(excel.merchantRules).toEqual(state.merchantRules);
    expect(excel.transactions[0].merchantAlias).toBe(selected.merchantAlias);
    for (const loaded of [json, excel]) {
      const future = booking({ id: "future", date: "2026-10-01", amount: -7 });
      const prepared = prepareStatementImport([statement([future])], loaded);
      expect(prepared.review).toEqual([]);
      expect(prepared.automatic).toHaveLength(1);
      expect(prepared.automatic[0]).toMatchObject({
        ...future, category: "Miete", merchantAlias: "Hausverwaltung", categoryOverride: true, fixedCost, includeInPlan: !fixedCost,
      });
      expect(prepared.automatic[0].manualCategory).toBeUndefined();
      expect(prepared.automatic[0].reviewed).toBeUndefined();
      const saved = queueLedgerReview(commitStatementImport(loaded, prepared.automatic, [], prepared.metadata).state);
      expect(saved.transactions).toHaveLength(2);
      expect(saved.financeRows).toEqual(loaded.financeRows);
      expect(classify(saved.transactions[1]).isFixedCost).toBe(fixedCost);
    }
  });

  it("resolves open twins without overwriting historical manual choices or fixed markers", () => {
    const first = booking();
    const twin = booking({ id: "twin", date: "2026-09-02", fixedCost: false });
    const manual = booking({ id: "manual", date: "2026-09-03", merchantAlias: "Bestaetigter Name",
      category: "Shopping", categoryOverride: true, manualCategory: true, reviewed: true });
    const queued = booking({ id: "queued", date: "2026-09-04" });
    const saved = approve(fixture({
      transactions: [first, twin, manual], reviewQueue: [pending(first), pending(queued)],
    }));
    expect(saved.transactions.find((row) => row.id === twin.id)).toMatchObject({
      merchantAlias: "Hausverwaltung", category: "Miete", fixedCost: false,
    });
    expect(saved.transactions.find((row) => row.id === manual.id)).toEqual(manual);
    expect(saved.transactions.find((row) => row.id === queued.id)).toMatchObject({
      merchantAlias: "Hausverwaltung", category: "Miete",
    });
    expect(saved.reviewQueue).toEqual([]);
  });

  it("keeps the original-name link when the name and category are changed again", () => {
    const original = booking();
    let saved = approve(fixture({ transactions: [original], reviewQueue: [pending(original)] }));
    const second = choose(saved.transactions[0], { merchantAlias: "Wohnservice", category: "Sonstiges", fixedCost: false });
    saved = approve(saved, second);
    const future = applyMerchantRules(saved, [booking({ id: "future", date: "2026-10-01" })])[0];
    expect(future).toMatchObject({ merchantAlias: "Wohnservice", category: "Sonstiges", fixedCost: false });
    expect(saved.transactions[0].merchantAlias).toBe("Wohnservice");
  });

  it("retains alias rules when an unrelated booking uses incremental approval", () => {
    const state = approve(fixture({ reviewQueue: [pending(booking())] }));
    const unrelated = booking({ id: "unrelated", description: "Nordlicht Laden" });
    const next = queueLedgerReview({ ...state, reviewQueue: [pending(unrelated)] });
    const result = approveReviewedBooking(next, {
      ...unrelated, category: "Shopping", categoryOverride: true, fixedCost: false,
    });
    expect(result).toBeDefined();
    expect(result!.state.merchantRules).toEqual(expect.arrayContaining(state.merchantRules!));
    expect(applyMerchantRules(result!.state, [booking({ id: "future" })])[0].merchantAlias).toBe("Hausverwaltung");
  });

  it("does not rename credits, another recipient, another bank or explicit manual choices", () => {
    const state = approve(fixture({ reviewQueue: [pending(booking())] }));
    const others = [
      booking({ id: "credit", amount: 3 }),
      booking({ id: "recipient", description: booking().description.replace("AT000000000000000001", "AT000000000000000002") }),
      booking({ id: "bank", bank: "Revolut", pocket: "Giro" }),
      booking({ id: "manual", category: "Shopping", categoryOverride: true, manualCategory: true }),
    ];
    expect(applyMerchantRules(state, others)).toEqual(others);
  });

  it.each(["POS 3,00 AT D1", "POS Zahlung 8,40", "POS 8,40", "8,40", "Terminal 7,90", "PayPal", "SumUp", "Stripe"])("only renames the selected booking for non-specific source %s", (description) => {
    const original = booking({ description });
    const saved = approve(fixture({ reviewQueue: [pending(original)] }), choose(original));
    expect(saved.transactions[0].merchantAlias).toBe("Hausverwaltung");
    const future = applyMerchantRules(saved, [{ ...original, id: "future", date: "2026-10-01" }])[0];
    expect(future.merchantAlias).toBeUndefined();
    expect(saved.merchantRules?.some((rule) => rule.key === merchantRuleKey(original))).toBe(false);
  });

  it("keeps conflicting alias history unresolved instead of choosing by order", () => {
    const rows = [choose(), choose(booking({ id: "second" }), { merchantAlias: "Anderer Name" })];
    for (const transactions of [rows, rows.toReversed()]) {
      const state = fixture({ transactions });
      expect(applyMerchantRules(state, [booking({ id: "future" })])[0].merchantAlias).toBeUndefined();
      expect(rememberMerchants(fixture(), transactions).merchantRules?.some((rule) =>
        rule.key === merchantRuleKey(booking()))).toBe(false);
    }
  });

  it("preserves the renamed booking when approving a receipt-only review", () => {
    const original = booking();
    const key = statementFingerprint(original);
    const state = fixture({ fixedReceipts: [{
      key, merchantKey: merchantRuleKey(original), booking: original,
      date: original.date, category: original.category, amount: original.amount,
    }] });
    const selected = choose(actualBookings(state)[0]);
    const saved = approve(state, selected);
    expect(actualBookings(saved)).toHaveLength(1);
    expect(actualBookings(saved)[0]).toMatchObject({ merchantAlias: "Hausverwaltung", category: "Miete" });
    expect(statementFingerprint(actualBookings(saved)[0])).toBe(key);
  });

  it.each([true, false])("keeps fixed-rate twins linked when an alias changes and survives Excel (accept=%s)", async (accept) => {
    const original = booking({ description: "ALLIANZ Vertrag SYNTHETIC", category: "Versicherungen", categoryOverride: true });
    const earlier = { ...original, id: "earlier", date: "2026-08-01" };
    const other = { ...original, id: "other", description: "Andere Versicherung SYNTHETIC" };
    const change: FixedChange = {
      id: "current", category: "Versicherungen", month: "2026-09", previous: 5, amount: 3,
      rowId: "insurance", bookings: [original],
    };
    const earlierChange = { ...change, id: "earlier-change", month: "2026-08", bookings: [earlier] };
    const otherChange = { ...change, id: "other-change", rowId: "other-plan", bookings: [other] };
    const state = fixture({
      financeRows: [{ id: "insurance", label: "Haftpflicht", kind: "fixed", planCategory: "Versicherungen",
        values: { "2026-07": 5, "2026-08": 5, "2026-09": 5 } }],
      reviewQueue: [change, earlierChange, otherChange].map((change) => ({ kind: "fixed", id: change.id, change })),
    });
    const saved = queueLedgerReview(commitStatementImport(state, [], [{
      accept, change: { ...change, bookings: [{ ...original, merchantAlias: "Meine Versicherung", reviewed: true }] },
    }]).state);
    expect(saved.reviewQueue).toEqual([{ kind: "fixed", id: otherChange.id, change: otherChange }]);
    expect(actualBookings(saved)).toHaveLength(2);
    expect(actualBookings(saved).map((row) => row.merchantAlias)).toEqual(["Meine Versicherung", "Meine Versicherung"]);
    expect(saved.financeRows[0].values).toMatchObject({ "2026-07": 5, "2026-08": accept ? 3 : 5, "2026-09": accept ? 3 : 5 });
    const restored = (await parseWorkbook(await exportWorkbook(saved))).state;
    expect(restored.merchantRules).toEqual(saved.merchantRules);
    expect(actualBookings(restored).map((row) => row.merchantAlias)).toEqual(["Meine Versicherung", "Meine Versicherung"]);
    const repeat = prepareStatementImport([statement([{ ...original, id: "reimport" }])], restored);
    expect(repeat.automatic).toEqual([]);
    expect(repeat.review).toEqual([]);
    expect(repeat.duplicates).toBe(1);
  });
});
