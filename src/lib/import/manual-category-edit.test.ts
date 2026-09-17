import { describe, expect, it } from "vitest";
import { actualBookings, classify } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type Transaction } from "@/lib/types";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { rememberMerchants } from "./merchant-rules";
import { queueLedgerReview } from "./review";

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
      expect(restored.transactions[0]).toMatchObject({ ...selected, category: "Shopping" });
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
});
