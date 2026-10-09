import { describe, expect, it } from "vitest";
import { actualBookings, classify, merchantName } from "@/lib/calc";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { statementFingerprint } from "@/lib/import/identity";
import { merchantRuleKey } from "@/lib/import/merchant-rules";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "@/lib/import/review";
import { confirmMerchantAlias, merchantLookupQuery, needsMerchantLookup } from "@/lib/merchant-lookup";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";

const original: Transaction = {
  id: "unknown", date: "2026-09-10", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
  description: "XQZ 9500 Villach", rawDescription: "POS XQZ 9500 Villach 3,50 AT D1 09.09. 11:53",
  rawDetails: ["Händler Ort: Villach", "PLZ: 9500", "Bankreferenz: privat-123456"],
  amount: -3.5, category: "Prüfen", includeInPlan: true,
};
const hit = { id: "123", name: "Blumenatelier", displayName: "Blumenatelier, Hauptplatz, Villach, 9500, Österreich" };
const fixture = (): AppState => ({ ...createSeed(), transactions: [original], fixedReceipts: [] });

describe("discreet merchant lookup", () => {
  it.each(["BILLA", "SPAR", "INTERSPAR", "Shell", "Martin Auer", "BIPA", "AMAZON", "OMV"])("does not offer lookup for known %s even with an open category or messy POS title", (name) => {
    expect(needsMerchantLookup({ ...original, description: name })).toBe(false);
    expect(needsMerchantLookup({ ...original, description: `POS ${name} 9500 Villach 3,50 AT D1` })).toBe(false);
  });

  it("offers lookup for weak, unresolved and unknown merchant titles, including recovered POS text", () => {
    expect(needsMerchantLookup(original)).toBe(true);
    expect(needsMerchantLookup({ ...original, description: original.rawDescription! })).toBe(true);
    expect(needsMerchantLookup({ ...original, description: "POS 3,50 AT D1 09.09. 11:53", rawDetails: [] })).toBe(true);
    expect(needsMerchantLookup({ ...original, description: "BANKOMAT/POS 3,50 AT D1 09.09. 11:53", rawDetails: [] })).toBe(true);
    expect(needsMerchantLookup({ ...original, description: "Händler unbekannt" })).toBe(true);
    expect(needsMerchantLookup({ ...original, description: "Normaler Laden", rawDescription: undefined })).toBe(false);
    expect(needsMerchantLookup({ ...original, description: "POS 3,50 AT D1", rawDetails: ["Händler Name: BILLA"] })).toBe(false);
  });

  it("excludes credits, zero amounts, reviewed bookings and confirmed names", () => {
    expect(needsMerchantLookup({ ...original, amount: 3.5 })).toBe(false);
    expect(needsMerchantLookup({ ...original, amount: 0 })).toBe(false);
    expect(needsMerchantLookup({ ...original, reviewed: true })).toBe(false);
    expect(needsMerchantLookup({ ...original, merchantAlias: hit.name })).toBe(false);
    expect(needsMerchantLookup({ ...original, reviewed: false })).toBe(true);
  });

  it.each(["BILLA", "SPAR", "INTERSPAR", "Shell", "Martin Auer", "BIPA", "AMAZON", "OMV", "Normaler Laden"])("builds a lookup query for known or ordinary merchant %s", (name) => {
    expect(merchantLookupQuery({ ...original, description: name })).toBe(`${name}, Villach, 9500, AT`);
  });

  it("searches a confirmed display name again while retaining the bank's location hints", () => {
    expect(merchantLookupQuery({ ...original, merchantAlias: hit.name })).toBe("Blumenatelier, 9500 Villach, AT");
  });

  it("builds a merchant-only Austrian query, adds explicit city/postcode and strips financial metadata", () => {
    expect(merchantLookupQuery(original)).toBe("XQZ 9500 Villach, AT");
    expect(merchantLookupQuery({ ...original, description: "XQZ" })).toBe("XQZ, Villach, 9500, AT");
    expect(merchantLookupQuery({ ...original, description: "XQZ", rawDescription: undefined, rawDetails: ["9500 Villach"] })).toBe("XQZ, 9500 Villach, AT");
    expect(merchantLookupQuery({ ...original, description: "XQZ IBAN AT12 3456 7890 1234 5678", rawDescription: undefined, rawDetails: [] })).toBe("XQZ, AT");
    expect(merchantLookupQuery({ ...original, description: "XQZ Bankreferenz: private-id", rawDescription: undefined, rawDetails: [] })).toBe("XQZ, AT");
    expect(merchantLookupQuery({ ...original, description: "XQZ 1234 1234 1234 1234", rawDescription: undefined, rawDetails: [] })).toBe("XQZ, AT");
    expect(merchantLookupQuery({ ...original, description: "POS 3,50 AT D1 09.09. 11:53", rawDescription: undefined, rawDetails: [] })).toBeUndefined();
  });

  it("writes a separate alias to the selected booking and open twins, never bank text or closed twins", () => {
    const twin = { ...original, id: "twin", date: "2026-09-11" };
    const closed = { ...original, id: "closed", category: "Shopping" as const, reviewed: true, categoryOverride: true };
    const unrelated = { ...original, id: "unrelated", description: "Anderer Kiosk" };
    const seed = fixture();
    const state = { ...seed, transactions: [original, twin, closed, unrelated] };
    const saved = confirmMerchantAlias(state, original, hit);
    expect(saved.transactions).toEqual([{ ...original, merchantAlias: hit.name, merchantNameConfirmed: true },
      { ...twin, merchantAlias: hit.name, merchantMatch: "rule", merchantNameConfirmed: undefined,
        requires_manual_review: true }, closed, unrelated]);
    expect(state.transactions[0]).toBe(original);
    expect(statementFingerprint(saved.transactions[0])).toBe(statementFingerprint(original));
    expect(merchantRuleKey(saved.transactions[0])).toBe("raiffeisen|blumenatelier");
    expect(merchantName(original.description, saved.transactions[0].merchantAlias)).toBe(hit.name);
    expect(classify(saved.transactions[0]).merchant).toBe(hit.name);
    expect(saved.merchantRules?.find(rule => rule.merchantAlias === hit.name))
      .toMatchObject({ identityOnly: true, category: "Prüfen" });
    expect(saved.financeRows).toBe(seed.financeRows);
    expect(saved.transactions[0].reviewed).toBeUndefined();
  });

  it("can recheck the selected name without overwriting protected aliases on other rows", () => {
    const selected = { ...original, description: "POS 3,50 AT D1", merchantAlias: "Alter Name",
      category: "Shopping" as const, categoryOverride: true, manualCategory: true, reviewed: true };
    const twin = { ...original, id: "open-twin", merchantAlias: selected.merchantAlias };
    const closed = { ...selected, id: "closed-twin" };
    const differentAlias = { ...original, id: "different-alias", merchantAlias: "Anderer Name" };
    const state = { ...fixture(), transactions: [selected, twin, closed, differentAlias] };
    const saved = confirmMerchantAlias(state, selected, hit);
    expect(saved.transactions).toEqual([
      { ...selected, merchantAlias: hit.name, merchantNameConfirmed: true }, twin, closed, differentAlias,
    ]);
    expect(statementFingerprint(saved.transactions[0])).toBe(statementFingerprint(selected));
    expect(merchantRuleKey(saved.transactions[0])).toBe("raiffeisen|blumenatelier");
  });

  it("updates pending and receipt-backed twins without replacing their original texts or keys", () => {
    const receiptBooking = { ...original, id: "receipt-booking", date: "2026-09-12" };
    const key = statementFingerprint(receiptBooking);
    const pending = { ...original, id: "pending", date: "2026-09-13" };
    const state: AppState = { ...fixture(),
      fixedReceipts: [{ key, booking: receiptBooking, category: "Prüfen", date: receiptBooking.date, amount: receiptBooking.amount }],
      reviewQueue: [
        { kind: "booking", id: pending.id, draft: pending, message: "Händler prüfen" },
        { kind: "booking", id: "no-amount", draft: { ...pending, id: "no-amount", amount: null }, message: "Betrag fehlt" },
      ],
    };
    const saved = confirmMerchantAlias(state, original, hit);
    expect(saved.fixedReceipts?.[0]).toMatchObject({ key, merchantKey: "raiffeisen|blumenatelier", booking: { ...receiptBooking, merchantAlias: hit.name } });
    expect(saved.reviewQueue?.[0]).toMatchObject({ draft: { ...pending, merchantAlias: hit.name } });
    expect(saved.reviewQueue?.[1]).toMatchObject({ draft: { ...pending, id: "no-amount", amount: null, merchantAlias: hit.name } });
    const selectedReceipt = actualBookings(state).find((row) => row.id === key)!;
    expect(confirmMerchantAlias(state, selectedReceipt, hit).fixedReceipts?.[0].booking)
      .toEqual({ ...receiptBooking, merchantAlias: hit.name, merchantNameConfirmed: true });
  });

  it("persists aliases in JSON, Excel and repeated imports while preserving original source fields", async () => {
    const saved = queueLedgerReview(confirmMerchantAlias(fixture(), original, hit));
    for (const restored of [
      appStateSchema.parse(JSON.parse(JSON.stringify(saved))),
      (await parseWorkbook(await exportWorkbook(saved))).state,
    ]) {
      const prepared = prepareStatementImport([{ source: "Raiffeisen", file: "same.csv", rows: [original], issues: [], skipped: 0 }], restored);
      expect(prepared.duplicates).toBe(1);
      const reimported = queueLedgerReview(commitStatementImport(restored, prepared.automatic, [], prepared.metadata).state);
      expect(reimported.transactions).toHaveLength(1);
      expect(reimported.transactions[0]).toEqual(saved.transactions[0]);
      expect(merchantRuleKey(reimported.transactions[0])).toBe("raiffeisen|blumenatelier");
    }
  });

  it("does not accept a stale or deleted selection", () => {
    expect(() => confirmMerchantAlias({ ...fixture(), transactions: [] }, original, hit)).toThrow("inzwischen geändert");
    expect(() => confirmMerchantAlias({ ...fixture(), transactions: [{ ...original, description: "Anderer Händler" }] }, original, hit)).toThrow("inzwischen geändert");
    expect(() => confirmMerchantAlias({ ...fixture(), transactions: [{ ...original, merchantAlias: "Bereits bestätigt" }] }, original, hit)).toThrow("inzwischen geändert");
    const selected = { ...original, merchantAlias: "Alter Name" };
    expect(() => confirmMerchantAlias({ ...fixture(), transactions: [{ ...selected, merchantAlias: "ALTER NAME" }] }, selected, hit)).toThrow("inzwischen geändert");
  });
});
