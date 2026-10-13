import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { appStateSchema, type Transaction } from "@/lib/types";
import { exportWorkbook, parseWorkbook } from "./excel";

async function bytes(workbook: ExcelJS.Workbook): Promise<ArrayBuffer> {
  return Uint8Array.from(new Uint8Array(await workbook.xlsx.writeBuffer())).buffer;
}

describe("non-destructive workbook restoration", () => {
  it("rejects the duplicate 1000/2000 income IDs before export rather than losing one", async () => {
    const state = createEmptyAccountState();
    state.financeRows = [
      { id: "same", label: "Einkommen A", kind: "income", values: { "2026-10": 1000 } },
      { id: "same", label: "Einkommen B", kind: "income", values: { "2026-10": 2000 } },
    ];
    const original = JSON.stringify(state);
    expect(appStateSchema.safeParse(state).success).toBe(false);
    await expect(exportWorkbook(state)).rejects.toThrow("Doppelte Finanzzeilen-ID");
    expect(JSON.stringify(state)).toBe(original);
  });

  it("rejects duplicate rows inside a yearly sheet but combines one identity across the two years", async () => {
    const state = createEmptyAccountState();
    state.financeRows = [{ id: "salary", label: "Gehalt", kind: "income", values: { "2026-10": 1000, "2027-01": 2000 } }];
    const exported = await exportWorkbook(state);
    const restored = await parseWorkbook(exported);
    expect(restored.kind).toBe("backup");
    expect(restored.state.financeRows.find((row) => row.id === "salary")?.values).toMatchObject({ "2026-10": 1000, "2027-01": 2000 });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported);
    const sheet = workbook.getWorksheet("Finanzen 2026")!;
    sheet.addRow(sheet.getRow(2).values);
    await expect(parseWorkbook(await bytes(workbook))).rejects.toThrow("Doppelte Finanzzeilen-ID");
  });

  it("classifies transaction-only files separately and never supplies personal seed balances", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Umsätze");
    sheet.addRow(["Datum", "Beschreibung", "Betrag", "Bank"]);
    sheet.addRow(["2026-10-01", "Testkauf", -10, "Testbank"]);
    const parsed = await parseWorkbook(await bytes(workbook));
    expect(parsed.kind).toBe("transactions");
    expect(Object.values(parsed.state.settings.balances)).toEqual([0, 0, 0, 0]);
    expect(parsed.state.transactions).toHaveLength(1);
    expect(parsed.warnings.join(" ")).toContain("keine vollständige Sicherung");
  });

  it("rejects a truncated native backup or missing documented balances", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await exportWorkbook(createEmptyAccountState()));
    workbook.removeWorksheet(workbook.getWorksheet("Finanzen 2027")!.id);
    await expect(parseWorkbook(await bytes(workbook))).rejects.toThrow("Unvollständige Sicherung");
    const valid = new ExcelJS.Workbook();
    await valid.xlsx.load(await exportWorkbook(createEmptyAccountState()));
    valid.getWorksheet("Pockets")!.getCell("B2").value = null;
    await expect(parseWorkbook(await bytes(valid))).rejects.toThrow("belegten Startstand");
  });

  it("rejects invalid native booking rows instead of restoring a silently reduced backup", async () => {
    const state = createEmptyAccountState();
    state.transactions = [{ id: "purchase", date: "2026-10-01", bank: "Testbank", pocket: null,
      description: "Testkauf", amount: -10, category: "Shopping", includeInPlan: true }];
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await exportWorkbook(state));
    workbook.getWorksheet("Umsätze")!.getCell("A2").value = "kein Datum";
    await expect(parseWorkbook(await bytes(workbook))).rejects.toThrow("Umsätze, Zeile");
    workbook.getWorksheet("Umsätze")!.getCell("A2").value = "2026-10-01";
    workbook.getWorksheet("Umsätze")!.getCell("J2").value = null;
    await expect(parseWorkbook(await bytes(workbook))).rejects.toThrow("ID fehlt");
  });

  it("preserves settlement links, import results and metadata beyond one Excel cell", async () => {
    const state = createEmptyAccountState();
    state.transactions = [
      { id: "purchase", date: "2026-10-01", bank: "Testbank", pocket: null,
        description: "Geteilter Testkauf", amount: -100, category: "Shopping", includeInPlan: true, sharedWithRaphael: true },
      { id: "refund", date: "2026-10-02", bank: "Testbank", pocket: null,
        description: "Erstattung", amount: 100, category: "Shopping", includeInPlan: true, sharedRefundFor: "purchase" },
      { id: "payment", date: "2026-10-03", bank: "Testbank", pocket: null,
        description: "Partnerzahlung", amount: 50, category: "Transfer", includeInPlan: false, sharedRepaymentFor: "purchase" },
    ];
    state.merchantNameRules = Array.from({ length: 400 }, (_, index) => ({
      key: `synthetic-${index}`, merchantAlias: `Testname ${index} ${"x".repeat(100)}`,
    }));
    state.importResults = [{
      uploadId: "8b16a778-33c2-4d75-9e23-4b9d18944c94", name: "Test.csv", completedAt: Date.now(),
      status: "imported", inserted: 3, updated: 0, duplicates: 0, review: 0, skipped: 0, issues: [],
    }];
    const exported = await exportWorkbook(state);
    const restored = await parseWorkbook(exported);
    expect(restored.state.transactions).toEqual(appStateSchema.parse(state).transactions);
    expect(restored.state.importResults).toEqual(state.importResults);
    expect(restored.state.merchantNameRules).toEqual(state.merchantNameRules);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported);
    const metadata = workbook.getWorksheet("Import-Abgleich")!;
    expect(metadata.rowCount).toBeGreaterThan(2);
    metadata.eachRow((row, index) => { if (index > 1) expect(String(row.getCell(2).value).length).toBeLessThanOrEqual(30_000); });
    metadata.spliceRows(metadata.rowCount, 1);
    await expect(parseWorkbook(await bytes(workbook))).rejects.toThrow("Unvollständige Metadaten");
  });

  it("detects a removed metadata sheet and continues to accept existing entry-based backups", async () => {
    const state = createEmptyAccountState();
    state.merchantNameRules = [{ key: "synthetic", merchantAlias: "Testname" }];
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await exportWorkbook(state));
    workbook.removeWorksheet(workbook.getWorksheet("Import-Abgleich")!.id);
    await expect(parseWorkbook(await bytes(workbook))).rejects.toThrow("Sicherungsmetadaten fehlen");
    const dashboard = workbook.getWorksheet("Dashboard")!;
    dashboard.getCell("E1").value = null;
    dashboard.getCell("F1").value = null;
    const legacy = workbook.addWorksheet("Import-Abgleich");
    legacy.addRow(["Typ", "Auszugsdaten"]);
    legacy.addRow(["merchant-name", JSON.stringify(state.merchantNameRules[0])]);
    const restored = await parseWorkbook(await bytes(workbook));
    expect(restored.state.merchantNameRules).toEqual(state.merchantNameRules);
  });

  it("does not silently trim otherwise valid IDs or settlement references", async () => {
    const state = createEmptyAccountState();
    state.financeRows = [{ id: " salary ", label: "Gehalt", kind: "income", values: { "2026-10": 3000 } }];
    state.transactions = [
      { id: " purchase ", date: "2026-10-01", bank: "Testbank", pocket: null,
        description: "Testkauf", amount: -10, category: "Shopping", includeInPlan: true, sharedWithRaphael: true },
      { id: " refund ", date: "2026-10-02", bank: "Testbank", pocket: null,
        description: "Erstattung", amount: 10, category: "Shopping", includeInPlan: true, sharedRefundFor: " purchase " },
    ];
    const restored = await parseWorkbook(await exportWorkbook(state));
    expect(restored.state.financeRows.find((row) => row.id === " salary ")).toBeDefined();
    expect(restored.state.transactions).toEqual(appStateSchema.parse(state).transactions);
  });

  it("creates missing budget rows without colliding with or rewriting existing income IDs", async () => {
    const state = createEmptyAccountState();
    state.financeRows = [
      { id: "budget-food", label: "Gehalt A", kind: "income", values: { "2026-10": 1000 } },
      { id: "budget-food-1", label: "Gehalt B", kind: "income", values: { "2026-10": 2000 } },
    ];
    const original = JSON.stringify(state);
    const restored = await parseWorkbook(await exportWorkbook(state));
    expect(appStateSchema.safeParse(restored.state).success).toBe(true);
    expect(restored.state.financeRows.filter((row) => row.kind === "income")).toEqual(state.financeRows);
    expect(restored.state.financeRows.some((row) => row.id === "budget-food-2" && row.kind === "variable")).toBe(true);
    expect(JSON.stringify(state)).toBe(original);
  });

  it("preserves independent pocket openings and explicitly unknown core balances", async () => {
    const state = createEmptyAccountState();
    state.settings.unknownBalances = ["Sparkonto"];
    state.savingsGoals = [];
    state.pocketOpeningBalances = [{
      pocket: "Kamera", date: "2026-10-01", amount: 1000,
      includedTransactionIds: ["included-transfer"], ignoreEmptySnapshot: false,
    }];
    const exported = await exportWorkbook(state);
    const restored = await parseWorkbook(exported);
    expect(restored.state.settings.unknownBalances).toEqual(["Sparkonto"]);
    expect(restored.state.pocketOpeningBalances).toEqual(state.pocketOpeningBalances);
    expect(restored.state.savingsGoals).toEqual([]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported);
    const pocket = workbook.getWorksheet("Pockets")!.getRow(4);
    expect(pocket.getCell(1).value).toBe("Sparkonto");
    expect(pocket.getCell(3).value).toBeNull();
    expect(pocket.getCell(4).value).toBe("Unbekannt");
    expect(pocket.getCell(5).value).toBe("Unbekannt");
  });

  it("preserves confirmed reduced partner payments and per-booking upload provenance", async () => {
    const state = createEmptyAccountState();
    const first: Transaction = {
      id: "shared-a", date: "2026-10-01", bank: "Testbank", pocket: null,
      description: "Testversicherung", amount: -100, category: "Versicherungen", includeInPlan: true,
      sharedWithRaphael: true, sharedPaidManually: true, sharedPaidAmount: 20,
    };
    const second = { ...first, id: "shared-b", sharedPaidAmount: 0 };
    state.transactions = [first, second];
    state.reviewQueue = [{
      kind: "fixed", id: "fixed-review",
      change: { id: "test", category: "Versicherungen", month: "2026-10", previous: 0, amount: 100, bookings: [first, second] },
      importUploadIds: {
        "shared-a": "8b16a778-33c2-4d75-9e23-4b9d18944c94",
        "shared-b": "9b16a778-33c2-4d75-9e23-4b9d18944c94",
      },
    }];
    const normalized = appStateSchema.parse(state);
    const restored = await parseWorkbook(await exportWorkbook(state));
    expect(restored.state.transactions).toEqual(normalized.transactions);
    expect(restored.state.reviewQueue).toEqual(normalized.reviewQueue);
  });
});
