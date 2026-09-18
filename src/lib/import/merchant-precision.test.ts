import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import type { AppState, Transaction } from "@/lib/types";
import { applyMerchantRules, isSpecificMerchantKey, merchantRuleKey, rememberMerchants } from "./merchant-rules";
import { prepareStatementImport, queueLedgerReview } from "./review";

const booking = (patch: Partial<Transaction> = {}): Transaction => ({
  id: "new", date: "2026-09-12", description: "Testladen Nordlicht", amount: -12,
  bank: "Raiffeisen", pocket: "Raiffeisen Giro", category: "Prüfen", includeInPlan: true, ...patch,
});
const fixture = (patch: Partial<AppState> = {}): AppState => ({
  ...createSeed(), transactions: [], merchantRules: [], fixedReceipts: [], reviewQueue: [], ...patch,
});

describe("conservative merchant learning", () => {
  it("retains learned choices under old Raiffeisen bank aliases", () => {
    const state = fixture({ merchantRules: [
      { key: "Raiffeisen Hauptkonto|Testladen Nordlicht", category: "Bildung" },
    ] });
    expect(applyMerchantRules(state, [booking()])[0].category).toBe("Bildung");
    expect(merchantRuleKey(booking({ bank: "Raiffeisen Giro" }))).toBe(merchantRuleKey(booking()));
  });

  it.each([false, true])("does not choose a conflicting historical category by array order (reverse=%s)", (reverse) => {
    const rows = [
      booking({ id: "first", category: "Shopping", categoryOverride: true }),
      booking({ id: "second", category: "Bildung", categoryOverride: true }),
    ];
    const state = fixture({ transactions: reverse ? rows.toReversed() : rows });
    expect(applyMerchantRules(state, [booking()])[0]).toMatchObject({ category: "Prüfen" });
    expect(rememberMerchants(fixture(), rows).merchantRules).toEqual([]);
    const prepared = prepareStatementImport([{ source: "Raiffeisen", file: "test.csv", rows: [booking({ date: "2026-09-13" })], issues: [], skipped: 0 }], state);
    expect(prepared.automatic).toEqual([]);
    expect(prepared.review).toHaveLength(1);
  });

  it("retains conflicting stored rules across unrelated updates and resolves only an explicit decision", () => {
    const row = booking();
    const key = merchantRuleKey(row);
    const state = fixture({ transactions: [row], merchantRules: [
      { key, category: "Shopping" }, { key, category: "Bildung" },
    ] });
    expect(applyMerchantRules(state, [row])[0].category).toBe("Prüfen");
    const unchanged = rememberMerchants(state, []);
    expect(unchanged.merchantRules).toEqual(state.merchantRules);
    expect(queueLedgerReview(unchanged).reviewQueue).toHaveLength(1);
    const unrelated = booking({ id: "other", description: "Anderer Laden", category: "Freizeit", categoryOverride: true });
    expect(rememberMerchants(state, [unrelated]).merchantRules?.filter((rule) => rule.key === key)).toEqual(state.merchantRules);
    const resolved = rememberMerchants(state, [{ ...row, category: "Bildung", categoryOverride: true }]);
    expect(resolved.merchantRules).toEqual([{ key, category: "Bildung" }]);
    expect(queueLedgerReview(resolved).reviewQueue).toEqual([]);
    expect(applyMerchantRules(resolved, [booking({ id: "next" })])[0].category).toBe("Bildung");
  });

  it("lets a unique saved decision override inconsistent historical inference", () => {
    const state = fixture({
      transactions: [booking({ category: "Shopping", categoryOverride: true }), booking({ category: "Bildung", categoryOverride: true })],
      merchantRules: [{ key: merchantRuleKey(booking()), category: "Freizeit" }],
    });
    expect(applyMerchantRules(state, [booking()])[0].category).toBe("Freizeit");
    const manual = booking({ category: "Geschenke & Spenden", categoryOverride: true });
    expect(applyMerchantRules(state, [manual])[0]).toEqual(manual);
  });

  it("does not infer a category from conflicting old fixed receipts", () => {
    const key = merchantRuleKey(booking());
    const state = fixture({ fixedReceipts: [
      { key: "a", merchantKey: key, category: "Versicherungen", amount: 12, date: "2026-08-12" },
      { key: "b", merchantKey: key, category: "Telefon & Internet", amount: 12, date: "2026-09-12" },
    ] });
    expect(applyMerchantRules(state, [booking()])[0].category).toBe("Prüfen");
  });

  it.each(["SumUp", "Stripe", "Adyen", "Klarna", "Mollie", "Worldline"])("never learns a blanket %s payment-provider rule", (provider) => {
    const row = booking({ description: provider, category: "Shopping", categoryOverride: true });
    expect(isSpecificMerchantKey(merchantRuleKey(row))).toBe(false);
    expect(rememberMerchants(fixture(), [row]).merchantRules).toEqual([]);
    expect(isSpecificMerchantKey(merchantRuleKey({ ...row, description: `${provider} * Testladen Nordlicht` }))).toBe(true);
  });
});
