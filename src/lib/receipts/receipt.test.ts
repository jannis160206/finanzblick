import { describe, expect, it } from "vitest";
import { classifyReceiptItem, parseReceiptText, receiptSplitPreview } from "./receipt";

// Synthetic receipt, no real purchase data.
const BILLA = `BILLA AG
Musterstraße 1, 1010 Wien
EUR
Bio Vollmilch 3,5%          1,49 A
Gurken                      0,99 A
Naturjoghurt
2 x 1,99                    3,98 A
Bananen 0,512 kg x 1,99 EUR/kg  1,02 A
Rabatt -25%                -0,26 A
Pfand Flasche               0,25 C
Zahnpasta Clever            1,79 B
Duschgel Nivea              2,99 B
Katzenfutter Whiskas        4,49 B
Spülmittel                  1,29 B
Zweigelt Rotwein            6,90 B
Leergut                    -0,75 C
Unbekanntes XYZ             2,10 A
Zwischensumme              26,28
SUMME EUR                  26,28
Bankomat                   26,28
MwSt A 10%  1,23
Rückgeld                    0,00`;

describe("parseReceiptText", () => {
  it("reads items, quantities, discounts, deposit and total", () => {
    const receipt = parseReceiptText(BILLA);
    expect(receipt.items.map((item) => [item.name, item.amount, item.category])).toEqual([
      ["Bio Vollmilch 3,5%", 1.49, "Lebensmittel"],
      ["Gurken", 0.99, "Lebensmittel"],
      ["Naturjoghurt", 3.98, "Lebensmittel"],
      ["Bananen", 0.76, "Lebensmittel"],
      ["Pfand Flasche", 0.25, "Lebensmittel"],
      ["Zahnpasta Clever", 1.79, "Drogerie"],
      ["Duschgel Nivea", 2.99, "Drogerie"],
      ["Katzenfutter Whiskas", 4.49, "Haustiere"],
      ["Spülmittel", 1.29, "Wohnen & Haushalt"],
      ["Zweigelt Rotwein", 6.9, "Lebensmittel"],
      ["Leergut", -0.75, "Lebensmittel"],
      ["Unbekanntes XYZ", 2.1, "Lebensmittel"],
    ]);
    expect(receipt.items[2]).toMatchObject({ quantity: 2, unitPrice: 1.99 });
    expect(receipt.items[3].discount).toBe(-0.26);
    expect(receipt.items[9].note).toBe("Alkohol");
    expect(receipt.items[11].known).toBe(false);
    expect(receipt.total).toBe(26.28);
    expect(receipt.itemsTotal).toBe(26.28);
    expect(receipt.totalMatches).toBe(true);
  });

  it("attaches a quantity line below an item and handles OCR spacing", () => {
    const receipt = parseReceiptText("Semmel  1, 50 A\n3 x 0,50\nSUMME 1,50");
    expect(receipt.items).toEqual([expect.objectContaining({ name: "Semmel", amount: 1.5, quantity: 3, unitPrice: 0.5 })]);
    expect(receipt.totalMatches).toBe(true);
  });

  it("flags a mismatching total", () => {
    const receipt = parseReceiptText("Milch 1,49\nBrot 2,00\nSUMME 4,49");
    expect(receipt.totalMatches).toBe(false);
    expect(receipt.itemsTotal).toBe(3.49);
  });
});

describe("classifyReceiptItem", () => {
  it.each([
    ["KATZENMILCH", "Haustiere"],
    ["Weintrauben hell", "Lebensmittel"],
    ["Ottakringer Bier 0,5", "Lebensmittel"],
    ["Marlboro Gold", "Shopping"],
    ["Ibuprofen 400", "Gesundheit"],
    ["Persil Color", "Wohnen & Haushalt"],
    ["Toilettenpapier 8 Rollen", "Drogerie"],
  ])("%s → %s", (name, category) => {
    expect(classifyReceiptItem(name).category).toBe(category);
  });

  it("keeps the fallback for unknown items", () => {
    expect(classifyReceiptItem("QWZ 123", "Drogerie")).toEqual({ category: "Drogerie", known: false });
  });
});

describe("receiptSplitPreview", () => {
  it("groups by category and scales to the booking", () => {
    const preview = receiptSplitPreview(parseReceiptText(BILLA), -26.28);
    expect(preview.bookingDifference).toBe(0);
    expect(preview.splits.reduce((sum, part) => sum + Math.round(part.amount * 100), 0)).toBe(-2628);
    expect(preview.splits.find((part) => part.category === "Drogerie")?.amount).toBe(-4.78);
    expect(preview.splits.find((part) => part.category === "Haustiere")?.amount).toBe(-4.49);
  });

  it("shows the difference when the booking differs from the receipt", () => {
    const preview = receiptSplitPreview(parseReceiptText(BILLA), -30);
    expect(preview.bookingDifference).toBe(-3.72);
    expect(preview.splits.reduce((sum, part) => sum + Math.round(part.amount * 100), 0)).toBe(-3000);
  });
});
