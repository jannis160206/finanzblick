import { describe, expect, it } from "vitest";
import { actualBookings, actualPockets, classify, classifyStatementRows } from "@/lib/calc";
import { appStateSchema, categories, type AppState, type Transaction } from "@/lib/types";
import { canonicalCategory } from "@/lib/categories";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { createSeed } from "@/lib/seed";
import { personalAmount, reconcileSharedHoliday, type AccountedTransaction } from "@/lib/shared-holiday";
import { applyMerchantRules, isShopTransferRule, merchantRuleKey, rememberMerchants } from "./merchant-rules";
import { commitStatementImport, prepareStatementImport, queueLedgerReview, repairMerchantBookings } from "./review";
import { approveReviewedBooking } from "./approve-review";
import { statementFingerprint } from "./identity";

const booking = (patch: Partial<AccountedTransaction> = {}): AccountedTransaction => ({
  id: "selected", date: "2026-09-13", time: "21:00:00", description: "Amazon",
  bank: "Raiffeisen", pocket: "Raiffeisen Giro", amount: -24, category: "Shopping",
  includeInPlan: true, ...patch,
});
const manual = (patch: Partial<AccountedTransaction> = {}) => booking({
  categoryOverride: true, manualCategory: true, reviewed: true, ...patch,
});
const fixture = (transactions: Transaction[]): AppState => ({
  ...createSeed(), transactions, financeRows: [], fixedReceipts: [], reviewQueue: [], merchantRules: [],
});

describe("authoritative per-booking category selections", () => {
  it.each(categories)("accepts every selectable Amazon category: %s", (category) => {
    expect(classify(manual({ category })).category).toBe(canonicalCategory(category));
  });

  it.each<Partial<AccountedTransaction>>([
    { description: "Amazon", category: "Lebensmittel" },
    { description: "BIPA", category: "Shopping" },
    { description: "Hotspot", category: "Gesundheit" },
    { description: "Mensa", category: "Shopping" },
    { description: "Trafik", category: "Mittagessen" },
    { description: "BILLA", category: "Mittagessen" },
    { description: "Interne Überweisung", category: "Shopping" },
    { description: "AMEX Abrechnung", category: "Shopping" },
    { description: "Umgetauscht in USD", bank: "Revolut", sourceCategory: "Umtausch", category: "Shopping" },
    { description: "TTS Gehalt 8/2026", amount: 3400, category: "Geschenke & Spenden" },
    { description: "TTS Bonus", amount: 1500, category: "Gehalt" },
    { description: "Booking.com", category: "Shopping", sharedWithRaphael: true, holidayRange: true },
    { description: "Raphael Piber", amount: 12, category: "Einkommen", holidayReimbursementFor: "shared" },
  ])("does not replace deliberate category or derived plan category: %j", (patch) => {
    const selected = manual(patch);
    expect(classify(selected)).toMatchObject({
      category: selected.category, planCategory: selected.category, isTransfer: false,
    });
    expect(classify(selected).reason).toContain("Manuell");
    expect(classifyStatementRows([selected])[0].category).toBe(selected.category);
  });

  it.each([
    ["Amazon", "Shopping"], ["BIPA", "Mittagessen"], ["Interne Überweisung", "Transfer intern"],
  ] as const)("keeps mandatory automatic/learned protections for %s", (description, expected) => {
    for (const manualCategory of [undefined, false])
      expect(classify(booking({ description, date: "2026-09-14", category: "Gesundheit", categoryOverride: true, manualCategory })).category).toBe(expected);
  });

  it("keeps a learned Trafik rule instead of the Freizeit default", () => {
    expect(classify(booking({ description: "TRAFIK NORD", category: "Shopping", categoryOverride: true })).category).toBe("Shopping");
    expect(classify(booking({
      description: "TRAFIK NORD", category: "Shopping", categoryOverride: true,
      automaticCategoryEvidence: { method: "merchant", category: "Shopping" },
    })).category).toBe("Freizeit");
  });

  it("derives fixed, transfer and planning flags from the selected purpose, not bank wording", () => {
    expect(classify(manual({ category: "Lebensmittel" }))).toMatchObject({
      category: "Lebensmittel", planCategory: "Lebensmittel", includeInPlan: true, isFixedCost: false, isTransfer: false,
    });
    expect(classify(manual({ description: "Interne Überweisung", category: "Leasing" })))
      .toMatchObject({ category: "Leasing", includeInPlan: false, isFixedCost: true, isTransfer: false });
    expect(classify(manual({ category: "Transfer intern", fixedCost: true })))
      .toMatchObject({ planCategory: "Transfer intern", includeInPlan: false, isFixedCost: false, isTransfer: true, pocket: null });
    expect(classify(manual({ description: "Auszahlung bei Pocket", amount: -0.35, pocket: null, category: "Lebensmittel" })))
      .toMatchObject({ planCategory: "Lebensmittel", includeInPlan: true, isRoundUp: false, pocket: null });
    const selected = manual({ description: "Auszahlung bei Pocket", bank: "Revolut", pocket: "Sparkonto", amount: -0.35 });
    const state = fixture([selected]);
    state.settings.baselineDate = "2026-09-01";
    state.settings.asOf = "2026-09-18";
    state.settings.balances.Sparkonto = 10;
    expect(actualPockets(state).Sparkonto).toBe(9.65);
    expect(state.transactions[0]).toEqual(selected);
  });

  it.each(["Amazon", "BIPA", "Interne Überweisung", "Booking.com", "TTS Bonus"])(
    "keeps %s choices through repair, JSON, Excel and a duplicate statement", async (description) => {
      const original = booking({ description, bankReference: "bank-ref", rawDescription: `Original ${description}`,
        rawDetails: ["Verwendungszweck Bestellung ABC"], merchantAlias: "Bestätigter Händler" });
      const selected = { ...original, category: "Lebensmittel" as const, categoryOverride: true, manualCategory: true, reviewed: true };
      const state = queueLedgerReview(rememberMerchants(fixture([selected]), [selected]));
      for (const restored of [state, queueLedgerReview(appStateSchema.parse(JSON.parse(JSON.stringify(state)))),
        queueLedgerReview((await parseWorkbook(await exportWorkbook(state))).state)]) {
        expect(restored.transactions[0]).toEqual(selected);
        expect(restored.reviewQueue).toEqual([]);
        const prepared = prepareStatementImport([{ source: "Raiffeisen", file: "synthetic.csv", rows: [original], issues: [], skipped: 0 }], restored);
        const imported = queueLedgerReview(commitStatementImport(restored, prepared.automatic, [], prepared.metadata).state);
        expect(actualBookings(imported)).toHaveLength(1);
        expect(imported.transactions[0]).toEqual(selected);
      }
    },
  );

  it("never lets later merchant learning overwrite earlier choices or confer manual authority on twins", () => {
    const first = manual({ id: "first", category: "Gesundheit" });
    const second = manual({ id: "second", date: "2026-09-14", category: "Lebensmittel" });
    const twin = booking({ id: "twin", date: "2026-09-15" });
    const saved = repairMerchantBookings(rememberMerchants(fixture([first, second, twin]), [second]));
    expect(saved.transactions[0]).toEqual(first);
    expect(saved.transactions[1]).toEqual(second);
    expect(saved.transactions[2]).toMatchObject({ category: "Shopping", categoryOverride: true });
    expect(saved.transactions[2].manualCategory).toBeUndefined();
    expect(saved.transactions[2].reviewed).toBeUndefined();
    const future = classifyStatementRows(applyMerchantRules(saved, [{ ...twin, id: "future", categoryOverride: false }]))[0];
    expect(future.category).toBe("Shopping");
    expect(future.manualCategory).toBeUndefined();
  });

  it("reopens even a forced Amazon booking explicitly set to Prüfen without reopening its twins", () => {
    const other = manual({ id: "other", category: "Gesundheit" });
    const selected = manual({ category: "Prüfen", reviewed: false });
    const saved = queueLedgerReview(rememberMerchants(fixture([selected, other]), [selected]));
    expect(saved.transactions[0]).toMatchObject({ category: "Prüfen", manualCategory: true, reviewed: false });
    expect(saved.transactions[1]).toEqual(other);
    expect(saved.reviewQueue).toMatchObject([{ kind: "booking", draft: { id: selected.id, category: "Prüfen" } }]);
  });

  it("keeps direct choices in both import approval paths, protecting earlier manual twins", () => {
    const first = booking({ description: "Testladen", category: "Prüfen" });
    const earlier = manual({ id: "earlier", description: "Testladen", date: "2026-09-10", category: "Bildung" });
    const twin = booking({ id: "twin", description: "Testladen", date: "2026-09-15", category: "Prüfen" });
    const state = fixture([first, earlier, twin]);
    state.reviewQueue = [first, twin].map((draft) => ({ kind: "booking", id: draft.id, draft, message: "Kategorie wählen" }));
    const selected = { ...first, category: "Freizeit" as const, manualCategory: true, categoryOverride: true, reviewed: true };
    const full = queueLedgerReview(commitStatementImport(state, [selected]).state);
    const fast = approveReviewedBooking(state, selected)!;
    expect(fast).toBeDefined();
    expect(fast.state).toEqual(full);
    expect(full.transactions[0]).toEqual(selected);
    expect(full.transactions[1]).toEqual(earlier);
    expect(full.transactions[2]).toMatchObject({ category: "Freizeit" });
    expect(full.transactions[2].manualCategory).toBeUndefined();
    expect(full.transactions[2].reviewed).toBeUndefined();
  });

  it("does not lose the manual selection to duplicate pending source drafts", () => {
    const original = booking({ description: "Testladen", category: "Prüfen", bankReference: "same-reference" });
    const duplicate = { ...original, id: "duplicate" };
    const state = fixture([]);
    state.reviewQueue = [original, duplicate].map((draft) => ({ kind: "booking", id: draft.id, draft, message: "Kategorie wählen" }));
    const selected = { ...original, category: "Bildung" as const, manualCategory: true, categoryOverride: true, reviewed: true };
    for (const result of [commitStatementImport(state, [selected]), approveReviewedBooking(state, selected)!]) {
      expect(result.state.transactions).toHaveLength(1);
      expect(result.state.transactions[0]).toMatchObject(selected);
    }
  });

  it("preserves categories for receipt-only edits and subsequent merchant learning", () => {
    const selected = manual({ description: "Porsche Bank Leasing", category: "Shopping", bankReference: "receipt" });
    const key = statementFingerprint(selected);
    const state = fixture([]);
    state.fixedReceipts = [{ key, category: "Leasing", date: selected.date, amount: selected.amount, booking: selected,
      merchantKey: merchantRuleKey(selected) }];
    const saved = queueLedgerReview(rememberMerchants(state, [manual({ ...selected, id: "other", category: "Leasing" })]));
    expect(actualBookings(saved)[0]).toMatchObject({ ...selected, id: key });
    expect(classify(actualBookings(saved)[0])).toMatchObject({ category: "Shopping", includeInPlan: true });
  });

  it("retains a manual legacy payroll selection on its detailed source without duplicating income", () => {
    const legacy = manual({ id: "xlsx-10", description: "TTS Gehalt 8/2026", date: "2026-08-28", amount: 3000, category: "Geschenke & Spenden" });
    const detailed = booking({ id: "bank-payroll", description: "Team Talent Solutions Gehalt 8/2026",
      date: legacy.date, amount: legacy.amount, bankReference: "payroll", category: "Gehalt" });
    const state = fixture([legacy, detailed]);
    const result = actualBookings(queueLedgerReview(state));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ...detailed, category: legacy.category, manualCategory: true, reviewed: true, includeInPlan: true });
    expect(classify(result[0]).category).toBe(legacy.category);
    expect(state.transactions).toEqual([legacy, detailed]);
  });

  it("retains manual leasing purpose without losing or duplicating the actual bank debit", () => {
    const legacy = manual({ id: "xlsx-11", description: "Porsche Bank Leasing KL123AB", category: "Shopping", amount: -289.52 });
    const detailed = booking({ id: "bank-lease", description: "Porsche Bank Aktiengesellschaft Vertrag KL123AB",
      bankReference: "lease", category: "Leasing", amount: legacy.amount });
    const result = actualBookings(queueLedgerReview(fixture([legacy, detailed])));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ...detailed, category: "Shopping", manualCategory: true, reviewed: true });
    expect(personalAmount(result[0])).toBe(-289.52);
  });

  it("keeps explicit incoming income out of automatic partner matching while retaining explicit sharing", () => {
    const shared = manual({ id: "shared", description: "Booking.com", amount: -100, category: "Shopping", sharedWithRaphael: true });
    const incoming = manual({ id: "incoming", description: "Raphael Piber", amount: 50, category: "Einkommen" });
    const result = reconcileSharedHoliday([shared, incoming]);
    expect(result.receivables[0].status).toBe("Offen");
    expect(personalAmount(result.bookings[0])).toBe(-50);
    expect(personalAmount(result.bookings[1])).toBe(50);
    expect(classify(result.bookings[0]).category).toBe("Shopping");
    const transfer = reconcileSharedHoliday([shared, { ...incoming, category: "Transfer" }]);
    expect(transfer.receivables[0].status).toBe("Bezahlt");
    expect(personalAmount(transfer.bookings[1])).toBe(0);
  });
});

describe("transfer notes that name a shop", () => {
  const purchase = booking({
    id: "buy", bank: "Revolut", pocket: "Persönliches Konto", description: "BILLA", amount: -8.5,
    category: "Lebensmittel", categoryOverride: true, merchantAlias: "BILLA", merchantMatch: "alias",
    automaticCategoryEvidence: { method: "merchant", category: "Lebensmittel" },
  });

  it("does not learn that every purchase at the shop is a transfer", () => {
    const transfer = manual({
      id: "pocket", bank: "Revolut", pocket: "Sparen", amount: 10, category: "Transfer intern", merchantAlias: "BILLA",
      description: "Billa To EUR MB:1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d",
    });
    const saved = rememberMerchants(fixture([transfer, purchase]), [transfer]);
    expect(saved.merchantRules ?? []).not.toContainEqual(expect.objectContaining({ key: "revolut|billa" }));
    expect(saved.transactions.find((row) => row.id === "buy")?.category).toBe("Lebensmittel");
  });

  it("repairs purchases an earlier shop transfer rule misfiled", () => {
    const state = {
      ...fixture([{ ...purchase, category: "Transfer intern" }]),
      merchantRules: [{ key: "revolut|billa", category: "Transfer intern" as const }],
    };
    const repaired = repairMerchantBookings(state);
    expect(repaired.merchantRules).toEqual([]);
    expect(classify(repaired.transactions[0]).category).toBe("Lebensmittel");
    expect(isShopTransferRule({ key: "trade republic|trade republic", category: "Transfer" })).toBe(false);
  });
});

describe("automatic purposes at import", () => {
  it("do not settle open twins of the same merchant", () => {
    const atm = (id: string, amount: number, patch: Partial<Transaction> = {}): Transaction => ({
      id, date: "2026-02-03", time: "17:44:00", bank: "Raiffeisen", pocket: "Raiffeisen Giro", description: "BANKOMAT 00012345",
      amount, category: "Prüfen", includeInPlan: true, ...patch,
    });
    const rows = [
      atm("twenty", -20, { category: "Körperpflege", categoryOverride: true, requires_manual_review: false,
        automaticCategoryEvidence: { method: "purpose", category: "Körperpflege" } }),
      atm("thirty", -30, { date: "2026-02-10", requires_manual_review: true }),
    ];
    const state = fixture([]);
    const prepared = prepareStatementImport([{ source: null, file: "auszug.csv", rows, skipped: 0, issues: [] }], state);
    const saved = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
    expect(saved.reviewQueue).toContainEqual(expect.objectContaining({ draft: expect.objectContaining({ id: "thirty" }) }));
    expect(saved.transactions.find((row) => row.id === "thirty")).toBeUndefined();
  });
});
