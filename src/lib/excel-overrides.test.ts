import ExcelJS from "exceljs";
import { expect, it } from "vitest";
import { exportWorkbook, parseWorkbook } from "./excel";
import { refreshPlanning } from "./planning";
import { createSeed } from "./seed";

it("rejects manual future variable overrides across both years, including zero and Auto", async () => {
  const state = createSeed();
  state.financeRows = [
    {
      id: "food",
      label: "Lebensmittel",
      kind: "variable",
      planCategory: "Lebensmittel",
      values: { "2026-10": 100, "2026-11": 100, "2026-12": 90, "2027-01": 100 },
      overrides: { "2026-12": 90 },
    },
  ];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await exportWorkbook(state));
  const first = workbook.getWorksheet("Finanzen 2026")!;
  first.getCell(2, 12).value = 300;
  first.getCell(2, 13).value = 0;
  first.getCell(2, 14).value = "Auto";
  workbook.getWorksheet("Finanzen 2027")!.getCell(2, 3).value = 1234;
  const buffer = await workbook.xlsx.writeBuffer();
  const restored = (
    await parseWorkbook(Uint8Array.from(new Uint8Array(buffer)).buffer)
  ).state;
  expect(restored.financeRows[0].overrides).toBeUndefined();
  const refreshed = refreshPlanning(restored, "2026-09-11");
  expect(refreshed.financeRows[0].values).toMatchObject({
    "2026-10": 250,
    "2026-11": 250,
    "2026-12": 250,
    "2027-01": 250,
  });
  const again = (await parseWorkbook(await exportWorkbook(refreshed))).state;
  expect(again.financeRows).toEqual(refreshed.financeRows);
});

it("does not turn unchanged automatically calculated Excel values into overrides", async () => {
  const state = refreshPlanning(createSeed(), "2026-09-11");
  const restored = (await parseWorkbook(await exportWorkbook(state))).state;
  expect(restored.financeRows).toEqual(state.financeRows);
  expect(restored.financeRows.every((row) => row.overrides === undefined)).toBe(
    true,
  );
  restored.transactions = ["05", "06", "07", "08"].map((month) => ({
    id: month,
    date: `2026-${month}-02`,
    bank: "Amex",
    pocket: null,
    description: "BILLA",
    category: "Lebensmittel",
    amount: -100,
    includeInPlan: true,
  }));
  const refreshed = refreshPlanning(restored, "2026-09-11");
  expect(
    refreshed.financeRows.find((row) => row.planCategory === "Lebensmittel")!
      .values["2026-10"],
  ).toBe(250);
});
