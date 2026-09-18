import { describe, expect, it } from "vitest";
import { actualBookings, classify } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type Transaction } from "@/lib/types";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { normalizeAccount } from "@/lib/accounts";
import { applyMerchantRules, merchantRuleKey, rememberMerchants } from "./merchant-rules";
import { bookingReviewReason, commitStatementImport, openReviewCount, prepareStatementImport, queueLedgerReview } from "./review";
import { statementFingerprint } from "./identity";
import ExcelJS from "exceljs";

const row = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: "manual-pos", date: "2026-09-10", bank: "Raiffeisen", pocket: "Hauptkonto",
  description: "POS 3,50 AT D1 09.09. 11:53 Kartenfolge-Nr.: 1", amount: -3.5,
  category: "Prüfen", includeInPlan: false, ...overrides,
});

describe("explicit category edits", () => {
  it.each([
    row(),
    row({ rawDetails: ["BILLA", "SPAR"] }),
  ])("preserves a manual category on unresolved or ambiguous source text", async (original) => {
    const state = { ...createSeed(), transactions: [original], fixedReceipts: [] };
    const selected = { ...original, category: "Shopping" as const, categoryOverride: true, includeInPlan: true };
    const saved = queueLedgerReview(rememberMerchants({ ...state, transactions: [selected] }, [selected]));
    expect(saved.transactions[0]).toMatchObject({ ...selected, category: "Shopping" });
    expect(saved.merchantRules ?? []).toEqual([]);
    for (const restored of [
      queueLedgerReview(appStateSchema.parse(JSON.parse(JSON.stringify(saved)))),
      queueLedgerReview((await parseWorkbook(await exportWorkbook(saved))).state),
    ]) {
      expect(restored.transactions[0]).toMatchObject({ ...normalizeAccount(selected), category: "Shopping" });
      expect(actualBookings(restored)).toHaveLength(1);
    }
    expect(classify(original).category).toBe("Prüfen");
  });

  it("still protects actual internal transfers and compulsory lunch classification", () => {
    expect(classify(row({ description: "Interne Überweisung", category: "Shopping", categoryOverride: true })))
      .toMatchObject({ category: "Transfer intern", isTransfer: true });
    expect(classify(row({ description: "BIPA", category: "Shopping", categoryOverride: true })))
      .toMatchObject({ category: "Mittagessen", isTransfer: false });
  });

  it.each([
    row(),
    row({ rawDetails: ["BILLA", "SPAR"] }),
    row({ description: "Testladen" }),
  ])("keeps explicit review completion after queue repair, JSON, Excel and reimport", async (original) => {
    const selected = { ...normalizeAccount(original), category: "Shopping" as const, categoryOverride: true, includeInPlan: true, reviewed: true };
    const other = row({ id: "other", amount: -9, date: "2026-09-11" });
    const state = { ...createSeed(), transactions: [selected, other], fixedReceipts: [],
      merchantRules: [{ key: merchantRuleKey(selected), category: "Bildung" as const }],
      reviewQueue: [{ kind: "booking" as const, id: selected.id, draft: original, message: "POS-Händler fehlt." }],
    };
    const saved = queueLedgerReview(state);
    expect(saved.transactions[0]).toMatchObject(selected);
    expect(saved.reviewQueue).toHaveLength(1);
    expect(saved.reviewQueue?.[0]).toMatchObject({ draft: { id: "other" } });
    expect(openReviewCount(saved.reviewQueue ?? [])).toBe(1);
    expect(bookingReviewReason(saved, selected)).toBeUndefined();
    expect(saved.transactions[1].reviewed).toBeUndefined();
    const workbook = await exportWorkbook(saved);
    for (const restored of [
      queueLedgerReview(appStateSchema.parse(JSON.parse(JSON.stringify(saved)))),
      queueLedgerReview((await parseWorkbook(workbook)).state),
    ]) {
      expect(restored.transactions[0]).toEqual(saved.transactions[0]);
      expect(restored.reviewQueue).toHaveLength(1);
      const result = { source: "Raiffeisen" as const, file: "reviewed.csv", rows: [original], issues: [], skipped: 0 };
      const prepared = prepareStatementImport([result], restored);
      expect(prepared.duplicates).toBe(1);
      expect(prepared.review).toEqual([]);
      const imported = queueLedgerReview(commitStatementImport(restored, prepared.automatic, [], prepared.metadata).state);
      expect(imported.transactions).toEqual(restored.transactions);
      expect(imported.reviewQueue).toHaveLength(1);
    }
  });

  it("never inherits a review acknowledgement from another booking of the same merchant", () => {
    const selected = row({ description: "Testladen", category: "Shopping", categoryOverride: true, includeInPlan: true, reviewed: true });
    const twin = { ...selected, id: "twin", reviewed: undefined, category: "Prüfen" as const, categoryOverride: undefined };
    const state = rememberMerchants({ ...createSeed(), transactions: [selected, twin] }, [selected]);
    expect(state.transactions[0].reviewed).toBe(true);
    expect(state.transactions[1].reviewed).toBeUndefined();
    expect(applyMerchantRules(state, [{ ...twin, id: "future" }])[0]).toMatchObject({ category: "Shopping", categoryOverride: true });
    expect(applyMerchantRules(state, [{ ...twin, id: "future" }])[0].reviewed).toBeUndefined();
  });

  it("does not acknowledge missing or still invalid categories, and supports explicitly reopening a booking", () => {
    const selected = row({ category: "Shopping", categoryOverride: true, reviewed: true });
    for (const reopened of [
      { ...selected, reviewed: false },
      { ...selected, category: "Prüfen" as const },
      { ...selected, categoryOverride: false },
      { ...selected, description: "Unbekannte Kantine", category: "Mittagessen" as const, date: "2026-09-13" },
    ]) {
      const state = queueLedgerReview({ ...createSeed(), transactions: [reopened] });
      expect(state.reviewQueue).toHaveLength(1);
    }
  });

  it("removes only the reviewed booking from a fixed-cost decision without changing plans", () => {
    const selected = row({ category: "Leasing", categoryOverride: true, reviewed: true });
    const twin = { ...selected, id: "second-payment", reviewed: undefined };
    const seed = createSeed();
    const change = { id: "fixed", category: "Leasing" as const, month: "2026-09", previous: 3, amount: 3.5, bookings: [selected, twin] };
    const state = queueLedgerReview({ ...seed, transactions: [selected, twin],
      reviewQueue: [{ kind: "fixed", id: change.id, change }],
    });
    expect(state.reviewQueue?.find((item) => item.kind === "fixed")).toEqual({ kind: "fixed", id: change.id, change: { ...change, bookings: [twin] } });
    expect(state.financeRows).toEqual(seed.financeRows);
    expect(state.fixedAmountDecisions).toEqual(seed.fixedAmountDecisions);
    expect(state.transactions).toHaveLength(2);
    expect(state.transactions[0].amount).toBe(selected.amount);
  });

  it.each([true, false])("recognizes a receipt-backed review with original booking details=%s", async (hasOriginalBooking) => {
    const selected = normalizeAccount(row({ category: "Leasing", categoryOverride: true, reviewed: true }));
    const key = statementFingerprint(selected);
    const booking = hasOriginalBooking ? selected : { ...selected, id: key, bank: "Auszugsbeleg", pocket: null, description: "Leasing" };
    const change = { id: "fixed", category: "Leasing" as const, month: "2026-09", previous: 3, amount: 3.5, bookings: [row()] };
    const state = queueLedgerReview({ ...createSeed(), transactions: [],
      fixedReceipts: [{ key, booking, category: selected.category, amount: selected.amount, date: selected.date }],
      reviewQueue: [{ kind: "fixed", id: change.id, change }],
    });
    expect(state.reviewQueue).toEqual([]);
    expect(actualBookings(state)).toHaveLength(1);
    expect(actualBookings(state)[0]).toMatchObject({ id: key, reviewed: true });
    const restored = queueLedgerReview((await parseWorkbook(await exportWorkbook(state))).state);
    expect(restored.reviewQueue).toEqual([]);
    expect(actualBookings(restored)[0].reviewed).toBe(true);
  });

  it("round-trips true, false and legacy omission visibly in Excel and rejects invalid review flags", async () => {
    const original = { ...createSeed(), transactions: [
      normalizeAccount(row({ id: "reviewed", category: "Shopping", categoryOverride: true, reviewed: true })),
      normalizeAccount(row({ id: "open", reviewed: false })),
      normalizeAccount(row({ id: "legacy" })),
    ] };
    const buffer = await exportWorkbook(original);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet("Umsätze")!;
    let column = 0;
    sheet.getRow(1).eachCell((cell, index) => { if (cell.value === "Geprüft") column = index; });
    expect(column).toBeGreaterThan(0);
    expect([2, 3, 4].map((index) => sheet.getRow(index).getCell(column).value)).toEqual(["Ja", "Nein", ""]);
    expect((await parseWorkbook(buffer)).state.transactions).toEqual(original.transactions);
    sheet.getRow(2).getCell(column).value = "vielleicht";
    const invalid = await parseWorkbook(Uint8Array.from(new Uint8Array(await workbook.xlsx.writeBuffer())).buffer);
    expect(invalid.skipped).toBe(1);
    expect(invalid.state.transactions.some((row) => row.id === "reviewed")).toBe(false);
  });
});
