import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { createSeed } from "@/lib/seed";

async function withTextAmount(text: string) {
  const state = createSeed();
  state.transactions = [{
    id: "tx-1", date: "2026-09-12", bank: "Bank", pocket: null, description: "Miete",
    category: "Sonstiges", amount: -1, includeInPlan: false,
  }];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await exportWorkbook(state));
  for (const sheet of workbook.worksheets) {
    let amountCell: ExcelJS.Cell | undefined;
    sheet.eachRow((row) => row.eachCell((cell) => {
      if (cell.value === "Betrag" && !amountCell) amountCell = sheet.getCell(Number(row.number) + 1, Number(cell.col));
    }));
    if (amountCell && amountCell.value === -1) {
      amountCell.value = text;
      return parseWorkbook(await workbook.xlsx.writeBuffer() as ArrayBuffer);
    }
  }
  throw new Error("Betrag column not found");
}

describe("Excel amount text", () => {
  it.each([["-1.500", -1500], ["-1.500,50", -1500.5], ["-1,5", -1.5]])(
    "reads the text cell %s as %s euros",
    async (text, amount) => {
      const result = await withTextAmount(text);
      expect(result.state.transactions[0].amount).toBe(amount);
    },
  );
});
