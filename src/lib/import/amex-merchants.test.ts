import { describe, expect, it } from "vitest";
import { classify } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { amexMerchantCategory } from "./amex-merchants";
import { parseAmexText } from "./amex-pdf";
import { prepareStatementImport } from "./review";

describe("unambiguous Amex merchant descriptions", () => {
  it("uses the same automatic rules for PDF descriptors and app screenshots", () => {
    const result = parseAmexText(["05.10.2026\nUmsatz vom Buchung am Betrag in EUR\nNeue Belastungen für HERRN JANNIS BRUEHL\n03.10 03.10 MUELLER 5635 VILLACH 15,43\n02.10 02.10 MOLLIE=TAPESO DRACHTEN 164,90\n01.10 01.10 Entertainment Gutschrift 11,00 CR"]);
    const prepared = prepareStatementImport([result], createSeed());
    expect(prepared.review).toEqual([]);
    expect(prepared.automatic.map((row) => [row.category, row.amount])).toEqual([
      ["Drogerie", -15.43], ["Wohnen & Haushalt", -164.9], ["Entertainment", 11],
    ]);
    expect(prepared.automatic.map((row) => classify({ ...row, pocket: "Amex" }).category))
      .toEqual(["Drogerie", "Wohnen & Haushalt", "Entertainment"]);
  });
  it("does not guess a category for a surname, payment processor, charge or unrelated bank", () => {
    for (const row of [
      { bank: "Amex", description: "MUELLER", amount: -20 },
      { bank: "Amex", description: "MOLLIE", amount: -20 },
      { bank: "Amex", description: "Entertainment Gutschrift", amount: -11 },
      { bank: "Raiffeisen", description: "MUELLER 5635 VILLACH", amount: -20 },
    ]) expect(amexMerchantCategory(row)).toBeUndefined();
  });
});
