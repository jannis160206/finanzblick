import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { exportWorkbook, parseWorkbook, sheetNames } from "@/lib/excel";
import { createSeed } from "@/lib/seed";
import { calculateDashboard } from "@/lib/calc";
import { emptyMonth } from "@/lib/types";
import { applyVariableBudgets } from "@/lib/variable-budgets";

describe("Excel import/export", () => {
  it("round-trips all settings, transactions, overrides, and calculated balances", async () => {
    const state = createSeed();
    state.financeRows[0].values = { "2026-10": 3000, "2027-01": 4000 };
    state.transactions = [
      {
        id: "tx-1",
        date: "2026-09-12",
        bank: "Bank",
        pocket: null,
        description: "BILLA",
        category: "Sonstiges",
        amount: -9.99,
        includeInPlan: false,
      },
    ];
    state.months["2026-10"] = {
      ...emptyMonth(),
      variableOverride: 450,
      bikeOverride: 1000,
      pocketOut: { Notgroschen: 0, Sparkonto: 123.45, Urlaub: 0, Motorrad: 0 },
    };
    const buffer = await exportWorkbook(state);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      ...sheetNames,
    ]);
    const result = await parseWorkbook(buffer);
    expect(result.skipped).toBe(0);
    expect(result.state.settings).toEqual(state.settings);
    expect(result.state.transactions).toEqual(state.transactions);
    expect(result.state.financeRows).toEqual(applyVariableBudgets(state).financeRows);
    expect(result.state.months["2026-10"]).toEqual({ ...state.months["2026-10"], variableOverride: null });
    expect(calculateDashboard(result.state).timeline).toEqual(
      calculateDashboard(state).timeline,
    );
  });
  it("rejects invalid and oversized files without partial data", async () => {
    await expect(
      parseWorkbook(new TextEncoder().encode("not a workbook").buffer),
    ).rejects.toThrow("XLSX");
    await expect(
      parseWorkbook(new ArrayBuffer(21 * 1024 * 1024)),
    ).rejects.toThrow("20 MB");
  });
  it("consolidates legacy workbook categories while preserving their original labels and bank facts", async () => {
    const choices = [
      ["Ausgehen", "Restaurants"], ["Kleidung & Schuhe", "Shopping"], ["Elektronik", "Shopping"],
      ["Bücher", "Bildung"], ["Unterkunft", "Urlaub"], ["Flugreisen", "Urlaub"],
      ["G2A / Apple-Guthaben", "Guthabenkarten"], ["Essen / Restaurant", "Restaurants"],
      ["Porto & Versand", "Porto & Versand"],
    ];
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Umsätze");
    sheet.addRow(["Datum", "Beschreibung", "Betrag", "Bank", "Kategorie", "Im Plan"]);
    for (const [category] of choices) sheet.addRow(["2026-09-02", `Original ${category}`, -12.5, "Testbank", category, "Nein"]);
    const loaded = await parseWorkbook(Uint8Array.from(new Uint8Array(await workbook.xlsx.writeBuffer())).buffer);
    expect(loaded.skipped).toBe(0);
    expect(loaded.state.transactions).toHaveLength(choices.length);
    choices.forEach(([sourceCategory, category], index) => expect(loaded.state.transactions[index]).toMatchObject({
      category, sourceCategory, description: `Original ${sourceCategory}`, date: "2026-09-02",
      amount: -12.5, bank: "Testbank", includeInPlan: false,
    }));
    const restored = await parseWorkbook(await exportWorkbook(loaded.state));
    expect(restored.state.transactions).toEqual(loaded.state.transactions);
  });
  it("imports edited visible cells instead of stale hidden state", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await exportWorkbook(createSeed()));
    workbook.getWorksheet("Pockets")!.getCell("B4").value = 2000;
    const data = await workbook.xlsx.writeBuffer();
    const result = await parseWorkbook(
      Uint8Array.from(new Uint8Array(data)).buffer,
    );
    expect(result.state.settings.balances.Sparkonto).toBe(2000);
  });
  const original = path.join(
    process.cwd(),
    "data",
    "Einnahmen_Ausgaben_2026_MotorradSparen.xlsx",
  );
  it.skipIf(!existsSync(original))(
    "loads the supplied workbook with its real inputs",
    async () => {
      const buffer = await readFile(original);
      const result = await parseWorkbook(Uint8Array.from(buffer).buffer);
      expect(result.skipped).toBe(1);
      expect(result.warnings).toEqual([]);
      expect(result.state.transactions.length).toBeGreaterThan(2000);
      expect(result.state.settings.balances).toEqual(
        createSeed().settings.balances,
      );
      expect(
        result.state.financeRows.find((row) => row.label === "Nettogehalt")
          ?.values["2026-09"],
      ).toBe(2576.43);
      const dashboard = calculateDashboard(result.state);
      expect(dashboard.current.income).toBe(2818.26);
      expect(dashboard.timeline[0].end).toMatchObject({
        Notgroschen: 1642,
        Urlaub: 1750,
        Sparkonto: 100,
      });
      expect(dashboard.timeline[7].end).toMatchObject({
        Notgroschen: 5380.43,
        Urlaub: 1628.86,
        Sparkonto: 2154.66,
      });
      expect(result.state.months["2027-04"].pocketOut.Motorrad).toBe(7875.49);
      const roundTrip = await parseWorkbook(await exportWorkbook(result.state));
      expect(calculateDashboard(roundTrip.state)).toEqual(dashboard);
    },
  );
});
