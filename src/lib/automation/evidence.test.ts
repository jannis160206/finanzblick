import { describe, expect, it } from "vitest";
import { transactionSchema } from "@/lib/types";
import { merchantEvidence } from "./evidence";
import { MerchantIndex, seedMerchants } from "./merchants";
import { enrichTransaction } from "./pipeline";

const index = new MerchantIndex(seedMerchants);
const row = (description: string, rawDetails?: string[]) =>
  transactionSchema.parse({
    id: "source-evidence",
    date: "2026-10-08",
    bank: "Amex",
    pocket: "Amex",
    description,
    rawDetails,
    category: "Prüfen",
    amount: -42,
    includeInPlan: true,
  });

describe("bounded authoritative merchant evidence", () => {
  it("uses explicit entry modes without hiding merchant or category contradictions", () => {
    const source = row("CONTACTLESS BILLA FILIALE 17");
    expect(enrichTransaction(source, index)).toMatchObject({
      merchantAlias: "BILLA",
      category: "Lebensmittel",
      requires_manual_review: false,
      description: source.description,
    });
    for (const source of [
      row("CONTACTLESS BILLA", ["Merchant Name: PENNY"]),
      row("Kontaktlos BILLA PENNY"),
      row("EC-Kartenzahlung Müller Apotheke"),
      row("MCC: 5411 Kontaktlos BILLA KINO"),
      row("Kontaktlos Muelller"),
    ]) {
      expect(enrichTransaction(source, index)).toMatchObject({
        category: "Prüfen",
        requires_manual_review: true,
      });
    }
    expect(
      enrichTransaction(
        { ...source, is_locked: true, category: "Shopping" },
        index,
      ),
    ).toEqual({ ...source, is_locked: true, category: "Shopping" });
  });
  it("recognizes matching named variants even while their purchase category is unknown", () => {
    expect(
      enrichTransaction(
        row("POS", ["Händler Name: Apple.com/bill", "Merchant Name: iTunes"]),
        index,
      ),
    ).toMatchObject({
      merchantAlias: "Apple",
      requires_manual_review: true,
      category: "Prüfen",
    });
  });
  it("recovers explicit merchant names without rewriting original transaction facts", () => {
    const source = row("POS 3,00 AT D1", ["Händler Name: H&M"]);
    const result = enrichTransaction(source, index);
    expect(result).toMatchObject({
      description: source.description,
      rawDetails: source.rawDetails,
      merchantAlias: "H&M",
      category: "Shopping",
      requires_manual_review: false,
    });
  });

  it("checks labeled source fields even when the primary description is not generic POS", () => {
    for (const description of ["BILLA", "POS BILLA"])
      expect(
        merchantEvidence(row(description, ["Merchant Name: PENNY"]), index),
      ).toEqual({ kind: "conflict" });
    expect(
      enrichTransaction(
        row("BILLA", ["Händler Name: BILLA", "Merchant Name: PENNY"]),
        index,
      ),
    ).toMatchObject({ requires_manual_review: true });
  });

  it("accepts repeated branch/name spelling variants only when they prove the same known identity", () => {
    expect(
      enrichTransaction(
        row("POS", [
          "Händler: Müller Filiale 0042",
          "Merchant Name: Mueller Filiale 87",
        ]),
        index,
      ),
    ).toMatchObject({ merchantAlias: "Müller", requires_manual_review: false });
  });

  it("does not turn unknown/fuzzy explicit source names into guesses", () => {
    for (const name of ["Muelller", "Unknown Named Shop"])
      expect(
        enrichTransaction(row("POS", [`Merchant Name: ${name}`]), index),
      ).toMatchObject({ requires_manual_review: true, category: "Prüfen" });
  });

  it("refuses category contradictions and unrelated same-name companies", () => {
    for (const text of [
      "BILLA KINO",
      "Müller Apotheke",
      "Müller & Partner Steuerberatung",
    ])
      expect(enrichTransaction(row(text), index)).toMatchObject({
        requires_manual_review: true,
        category: "Prüfen",
      });
  });

  it("uses precise table categories instead of broad legacy umbrella suggestions", () => {
    expect(enrichTransaction(row("ÖBB"), index)).toMatchObject({
      category: "Öffentliche Verkehrsmittel",
    });
    expect(enrichTransaction(row("IKEA"), index)).toMatchObject({
      category: "Möbel & Einrichtung",
    });
    expect(enrichTransaction(row("OMV", ["MCC: 5542"]), index)).toMatchObject({
      category: "Tanken",
    });
  });

  it("does not turn salary credits at a recognized company into refunds", () => {
    const source = {
      ...row("Gehalt Amazon Gutschrift"),
      amount: 100,
      category: "Gehalt" as const,
    };
    expect(enrichTransaction(source, index)).toEqual(source);
    expect(
      enrichTransaction(
        { ...row("Rueckerstattung Amazon"), amount: 42 },
        index,
      ),
    ).toMatchObject({ merchantAlias: "Amazon", category: "Rückerstattungen" });
  });
});
