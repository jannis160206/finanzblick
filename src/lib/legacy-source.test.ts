import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { calculateDashboard, calculatePlan, classify } from "@/lib/calc";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { restoreLegacySourceCategories } from "@/lib/legacy-source";
import { refreshPlanning } from "@/lib/planning";
import { createSeed } from "@/lib/seed";
import { personalAmount, reconcileSharedHoliday } from "@/lib/shared-holiday";
import { type AppState, type Transaction } from "@/lib/types";

const transaction = (id: string, sourceCategory?: string): Transaction => ({
  id,
  date: "2026-08-03",
  bank: "Raiffeisen",
  pocket: null,
  amount: -2000,
  description: "Sammellastschrift",
  category: "Sonstiges",
  includeInPlan: true,
  ...(sourceCategory ? { sourceCategory } : {}),
});
function legacyState(reference: AppState) {
  return {
    ...reference,
    transactions: reference.transactions.map((row): Transaction => {
      return {
        ...row,
        sourceCategory: undefined,
        category:
          row.category === "Abonnements" ||
          row.category === "Bankgebühren" ||
          row.sourceCategory === "AMEX Abrechnung (Sammel)"
            ? "Sonstiges"
            : row.category,
      };
    }),
  };
}

describe("legacy Excel source categories", () => {
  it("retains original categories even when Im Plan is an uncached formula", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Umsätze");
    sheet.addRow([
      "Datum",
      "Bank",
      "Beschreibung",
      "Kategorie",
      "Betrag",
      "Im Plan",
    ]);
    for (const [bank, description, category, amount] of [
      ["Raiffeisen", "Sammellastschrift", "AMEX Abrechnung (Sammel)", -2000],
      ["Amex", "HOTEL ON BOOKING.COM Amsterdam", "Urlaub / Hotel", -500],
      ["Amex", "Monatsgebühr", "AMEX Monatsgebühr", -57.5],
      ["Amex", "PAYPAL *SPOTIFY", "Spotify", -12.99],
      ["Raiffeisen", "ATM", "Bargeld", -100],
      ["Raiffeisen", "ATM", "Bargeld", -20],
      ["Raiffeisen", "Regelmäßiger anderer Einkauf", "Sonstiges", -10],
    ] as const)
      sheet.addRow([
        "03.08.2026",
        bank,
        description,
        category,
        amount,
        { formula: 'IF(1=1,"Nein","Ja")' },
      ]);
    const state = (
      await parseWorkbook(
        Uint8Array.from(new Uint8Array(await book.xlsx.writeBuffer())).buffer,
      )
    ).state;
    const results = state.transactions.map(classify);
    expect(state.transactions[0].sourceCategory).toBe(
      "AMEX Abrechnung (Sammel)",
    );
    expect(results[0]).toMatchObject({
      category: "Transfer intern",
      includeInPlan: false,
    });
    expect(results[1]).toMatchObject({
      category: "Urlaub",
      includeInPlan: false,
      reason: "Ausgeschlossen",
    });
    expect(personalAmount(state.transactions[1])).toBe(-500);
    expect(reconcileSharedHoliday(state.transactions).receivables).toEqual([]);
    expect(results[2]).toMatchObject({
      category: "Bankgebühren",
      includeInPlan: false,
      isTransfer: false,
    });
    expect(results[3]).toMatchObject({
      category: "Abonnements",
      includeInPlan: false,
    });
    expect(results[4]).toMatchObject({
      isTransfer: true,
      includeInPlan: false,
    });
    expect(results[5]).toMatchObject({ category: "Körperpflege", isTransfer: false });
    expect(results[6].includeInPlan).toBe(true);
  });
  it("restores only exact unedited legacy rows and is idempotent", () => {
    const reference = createSeed();
    reference.transactions = [
      transaction("xlsx-2", "AMEX Abrechnung (Sammel)"),
    ];
    const state = legacyState(reference);
    const repaired = restoreLegacySourceCategories(state, reference);
    expect(repaired.transactions[0].sourceCategory).toBe(
      "AMEX Abrechnung (Sammel)",
    );
    expect(repaired.transactions[0].amount).toBe(-2000);
    expect(repaired.transactions).toHaveLength(1);
    expect(restoreLegacySourceCategories(repaired, reference)).toBe(repaired);
    for (const change of [
      { categoryOverride: true },
      { sourceCategory: "Manuell" },
      { amount: -1999 },
      { description: "Geänderter Text" },
      { bank: "Andere Bank" },
      { date: "2026-08-04" },
      { pocket: "Urlaub" },
      { id: "new-statement-id" },
      { category: "Shopping" as const },
    ]) {
      const edited = {
        ...state,
        transactions: [{ ...state.transactions[0], ...change }],
      };
      expect(restoreLegacySourceCategories(edited, reference)).toBe(edited);
    }
  });
  it("recalculates stale Sonstiges while preserving genuine recurring spending and explicit overrides", () => {
    const reference = createSeed();
    reference.transactions = ["07", "08"].flatMap((month) => [
      {
        ...transaction(`xlsx-${Number(month) * 2}`, "AMEX Abrechnung (Sammel)"),
        date: `2026-${month}-03`,
      },
      {
        ...transaction(`xlsx-${Number(month) * 2 + 1}`, "Sonstiges"),
        date: `2026-${month}-03`,
        description: "Anderer Einkauf",
        amount: -10,
      },
    ]);
    const state = legacyState(reference);
    state.financeRows.push({
      id: "auto-Sonstiges",
      kind: "variable",
      label: "Sonstiges",
      planCategory: "Sonstiges",
      values: { "2026-09": 2000 },
      overrides: { "2026-10": 123 },
    });
    const repaired = refreshPlanning(
      restoreLegacySourceCategories(state, reference),
      "2026-09-12",
    );
    const other = repaired.financeRows.find(
      (row) => row.id === "auto-Sonstiges",
    )!;
    expect(other.values["2026-09"]).toBe(6.5);
    expect(other.values["2026-10"]).toBe(123);
    expect(
      calculatePlan(repaired.transactions, repaired.settings.asOf).rows,
    ).toHaveLength(1);
  });
  it("fixes the supplied workbook's inflated Sonstiges and survives Excel backup", async () => {
    const buffer = readFileSync(
      new URL(
        "../../data/Einnahmen_Ausgaben_2026_MotorradSparen.xlsx",
        import.meta.url,
      ),
    );
    const reference = (await parseWorkbook(Uint8Array.from(buffer).buffer))
      .state;
    const state = legacyState(reference);
    // Reproduce the old catch-all row already stored by the plan engine.
    state.financeRows.push({
      id: "auto-Sonstiges",
      kind: "variable",
      label: "Sonstiges",
      planCategory: "Sonstiges",
      values: { "2026-09": 2000.89 },
    });
    const restoredSources = restoreLegacySourceCategories(state, reference);
    const repaired = refreshPlanning(restoredSources, "2026-09-12");
    const dashboard = calculateDashboard(repaired);
    expect(
      dashboard.plan.rows.some((row) =>
        /deutatww|hotel on booking|monatsgeb|spotify/i.test(row.merchant),
      ),
    ).toBe(false);
    expect(
      dashboard.plan.byCategory.find((row) => row.category === "Sonstiges")!
        .total,
    ).toBeLessThan(100);
    expect(dashboard.current.surplus).toBeGreaterThan(1000);
    expect(repaired.transactions.map((row) => [row.id, row.amount])).toEqual(
      state.transactions.map((row) => [row.id, row.amount]),
    );
    const restored = (await parseWorkbook(await exportWorkbook(repaired)))
      .state;
    expect(calculateDashboard(restored).current.surplus).toBe(
      dashboard.current.surplus,
    );
    expect(restored.transactions.map((row) => row.sourceCategory)).toEqual(
      repaired.transactions.map((row) => row.sourceCategory),
    );
  });
});
