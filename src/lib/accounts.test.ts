import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { accountLabel, normalizeAccount, RAIFFEISEN_ACCOUNT } from "./accounts";
import { calculateDashboard } from "./calc";
import { reconcileLeasingSources } from "./leasing";
import { reconcilePayrollSources } from "./payroll";
import { exportWorkbook, parseWorkbook } from "./excel";
import { createSeed } from "./seed";
import { appStateSchema, transactionSchema, type Transaction } from "./types";
import { normalizeStatementKey, numberStatementRows, statementFingerprint } from "./import/identity";
import { commitStatementImport, prepareStatementImport } from "./import/review";
import { deduplicateStatements, parseStatementCsv, parseStatementFile, type StatementResult } from "./import/statements";

const booking = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: "stored-raiffeisen",
  date: "2026-09-14",
  time: "12:30:00",
  bank: "Raiffeisen",
  pocket: null,
  description: "BILLA",
  rawDescription: "BILLA Filiale 123",
  rawDetails: ["Händler: BILLA", "Originaldaten bleiben unverändert"],
  category: "Lebensmittel",
  amount: -12.34,
  bankReference: "reference-123",
  occurrence: 1,
  includeInPlan: true,
  ...overrides,
});
const csv = (currency = "EUR") =>
  `Raiffeisen\nDatum;Beschreibung;Betrag;Referenz;Währung\n14.09.2026;BILLA;-12,34;reference-123;${currency}`;
const source = (rows: Transaction[]): StatementResult => ({
  source: "Raiffeisen", file: "synthetic.csv", rows, skipped: 0, issues: [],
});
const oldKey = (row: Transaction) => JSON.stringify([
  row.date, row.bank.toLowerCase(), row.pocket ?? "", row.amount.toFixed(2),
  row.bankReference ? `ref:${row.bankReference}` : (row.rawDescription ?? row.description).toLowerCase(),
]) + `|${row.occurrence ?? 1}`;
const bufferFor = async (workbook: ExcelJS.Workbook) =>
  Uint8Array.from(new Uint8Array(await workbook.xlsx.writeBuffer())).buffer;

describe("one canonical Raiffeisen main account", () => {
  it.each([null, "Hauptkonto", "Raiffeisen Giro", " Girokonto ", "  hauptkonto  "])(
    "normalizes %s without changing booking facts",
    (pocket) => {
      const original = booking({ pocket });
      const normalized = transactionSchema.parse(original);
      expect(normalized).toEqual({ ...original, pocket: RAIFFEISEN_ACCOUNT });
      expect(normalizeAccount(normalized)).toBe(normalized);
      expect(accountLabel(original)).toBe("Raiffeisen · Girokonto");
      expect(original.pocket).toBe(pocket);
    },
  );

  it("normalizes bank aliases but never collapses named or currency accounts", () => {
    expect(normalizeAccount(booking({ bank: "Raiffeisen Giro" }))).toEqual({
      ...booking(), pocket: RAIFFEISEN_ACCOUNT,
    });
    for (const pocket of ["Raiffeisen Giro (USD)", "Hauptkonto (CHF)", "Sparkonto", "Girokonto 2"]) {
      const row = booking({ pocket });
      expect(normalizeAccount(row)).toBe(row);
      expect(statementFingerprint(row)).not.toBe(statementFingerprint(booking()));
      expect(accountLabel(row)).toBe(`Raiffeisen · ${pocket}`);
    }
    for (const bank of ["Revolut", "Amex", "Andere Bank"]) {
      for (const pocket of [null, "Hauptkonto", "Urlaub", "Persönliches Konto (USD)"]) {
        const row = booking({ bank, pocket });
        expect(normalizeAccount(row)).toBe(row);
        expect(accountLabel(row)).toBe(`${bank} · ${pocket ?? "Hauptkonto"}`);
      }
    }
  });

  it("migrates all persisted bookings and decision keys without touching balances or IDs", () => {
    const original = {
      ...createSeed(),
      transactions: [booking(), booking({ id: "second", pocket: "Hauptkonto", bankReference: "reference-456" })],
      ignoredStatementKeys: [oldKey(booking({ pocket: "Hauptkonto" }))],
      fixedReceipts: [{
        key: oldKey(booking()), date: "2026-09-14", category: "Lebensmittel",
        amount: -12.34, booking: booking(),
      }],
      reviewQueue: [
        { kind: "booking", id: "draft", draft: { ...booking({ id: "draft", pocket: "Hauptkonto" }), amount: null }, message: "Prüfen" },
        { kind: "fixed", id: "fixed", change: {
          id: "fixed", category: "Leasing", month: "2026-09", previous: 10, amount: 12.34,
          bookings: [booking({ id: "fixed-booking" })],
        } },
      ],
      accountSnapshots: [{ bank: "Revolut", name: "Persönliches Konto (USD)", date: "2026-09-14", balance: 25 }],
    };
    const restored = appStateSchema.parse(JSON.parse(JSON.stringify(original)));
    expect(restored.transactions).toEqual(original.transactions.map(normalizeAccount));
    expect(restored.fixedReceipts![0]).toEqual({
      ...original.fixedReceipts[0], key: statementFingerprint(booking()), booking: normalizeAccount(booking()),
    });
    expect(restored.ignoredStatementKeys).toEqual([statementFingerprint(booking())]);
    expect(restored.reviewQueue![0]).toMatchObject({ draft: { pocket: RAIFFEISEN_ACCOUNT, amount: null, id: "draft" } });
    expect(restored.reviewQueue![1]).toMatchObject({ change: { bookings: [{ pocket: RAIFFEISEN_ACCOUNT, id: "fixed-booking" }] } });
    expect(restored.settings).toEqual(original.settings);
    expect(restored.months).toEqual(original.months);
    expect(restored.accountSnapshots).toEqual(original.accountSnapshots);
    expect(appStateSchema.parse(restored)).toEqual(restored);
    expect(original.transactions[0].pocket).toBeNull();
  });

  it("matches old aliases on reimport while preserving separate references and repeated purchases", () => {
    for (const pocket of [null, "Hauptkonto", RAIFFEISEN_ACCOUNT]) {
      const existing = booking({ pocket });
      const incoming = parseStatementCsv(csv()).rows[0];
      expect(statementFingerprint(existing)).toBe(statementFingerprint(incoming));
      expect(deduplicateStatements([incoming], [existing])).toEqual({ rows: [], duplicates: 1 });
    }
    const repeated = [booking({ bankReference: undefined, occurrence: undefined }), booking({
      id: "second", pocket: "Hauptkonto", bankReference: undefined, occurrence: undefined,
    })];
    expect(numberStatementRows(repeated).map((row) => row.occurrence)).toEqual([1, 2]);
    const first = deduplicateStatements(repeated, []);
    expect(first.rows).toHaveLength(2);
    expect(deduplicateStatements(repeated, first.rows).duplicates).toBe(2);
    expect(deduplicateStatements([booking({ bankReference: "different" })], [booking()]).rows).toHaveLength(1);
  });

  it("does not let legacy POS matching cross real Raiffeisen accounts", () => {
    const old = booking({ description: "POS 12,34 14.09.2026 12:30", rawDescription: undefined, rawDetails: undefined, bankReference: undefined });
    const main = { ...old, id: "main", pocket: RAIFFEISEN_ACCOUNT };
    expect(deduplicateStatements([main], [old]).duplicates).toBe(1);
    for (const pocket of ["Raiffeisen Giro (USD)", "Hauptkonto (CHF)", "Sparkonto"]) {
      const incoming = { ...main, pocket };
      expect(deduplicateStatements([incoming], [old])).toEqual({ rows: [incoming], duplicates: 0 });
    }
  });

  it("preserves ignored and fixed-receipt decisions after alias migration and reimport", () => {
    const imported = parseStatementCsv(csv());
    for (const decision of [
      { ignoredStatementKeys: [oldKey(booking({ pocket: "Hauptkonto" }))] },
      { fixedReceipts: [{
        key: oldKey(booking()), date: "2026-09-14", category: "Lebensmittel", amount: -12.34, booking: booking(),
      }] },
    ]) {
      const state = appStateSchema.parse({ ...createSeed(), ...decision });
      const prepared = prepareStatementImport([imported], state);
      expect(prepared.duplicates).toBe(1);
      expect(prepared.automatic).toEqual([]);
      expect(prepared.review).toEqual([]);
    }
    const foreignKey = oldKey(booking({ pocket: "Raiffeisen Giro (USD)" }));
    expect(normalizeStatementKey(foreignKey)).toBe(foreignKey);
    expect(normalizeStatementKey("unrecognized-old-key")).toBe("unrecognized-old-key");
  });

  it("keeps balances and booking facts stable through persisted reload and repeated imports", () => {
    const original = { ...createSeed(), transactions: [booking({ pocket: "Hauptkonto" })] };
    const state = appStateSchema.parse(JSON.parse(JSON.stringify(original)));
    const prepared = prepareStatementImport([parseStatementCsv(csv())], state);
    const saved = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
    expect(saved.transactions).toEqual(state.transactions);
    expect(calculateDashboard(saved).actual).toEqual(calculateDashboard(original).actual);
    expect(saved.settings.balances).toEqual(original.settings.balances);
    const again = prepareStatementImport([source([booking({ pocket: RAIFFEISEN_ACCOUNT })])], saved);
    expect(again.duplicates).toBe(1);
    expect(again.automatic).toEqual([]);
  });

  it("keeps foreign-currency statement drafts separate instead of importing them as euros", () => {
    const result = parseStatementCsv(csv("USD"));
    expect(result.rows).toEqual([]);
    expect(result.issues[0]).toMatchObject({
      draft: { bank: "Raiffeisen", pocket: "Raiffeisen Giro (USD)", amount: null, bankReference: "reference-123" },
    });
  });

  it.each(["leasing", "payroll"] as const)("keeps %s source reconciliation stable without crossing accounts", (kind) => {
    const legacy = normalizeAccount(booking({
      id: "xlsx-123", bankReference: undefined,
      description: kind === "leasing" ? "Porsche Bank Leasing KL123AB" : "TTS TeamTalentSolutions Gehalt 9/2026",
      rawDescription: undefined, rawDetails: undefined,
      category: kind === "leasing" ? "Leasing" : "Gehalt",
      amount: kind === "leasing" ? -289.52 : 2576.43,
    }));
    const reconcile = (rows: Transaction[]) => kind === "leasing"
      ? reconcileLeasingSources(rows, (row) => row.category) : reconcilePayrollSources(rows);
    const detailed = { ...legacy, id: "statement", bankReference: "real-reference" };
    expect(reconcile([legacy])).toEqual([legacy]);
    expect(reconcile([legacy, detailed])).toEqual([detailed]);
    const foreign = { ...detailed, pocket: "Raiffeisen Giro (USD)" };
    expect(reconcile([legacy, foreign])).toEqual([legacy, foreign]);
    const second = { ...detailed, id: "second", bankReference: "second-reference" };
    expect(reconcile([legacy, detailed, second])).toEqual([detailed, second]);
  });

  it("uses the same account for CSV and XLSX statements", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Raiffeisen");
    sheet.addRow(["Datum", "Beschreibung", "Betrag", "Referenz"]);
    sheet.addRow(["14.09.2026", "BILLA", -12.34, "reference-123"]);
    const buffer = await bufferFor(workbook);
    const result = await parseStatementFile({ name: "synthetic.xlsx", size: buffer.byteLength, arrayBuffer: async () => buffer });
    expect(result.rows[0].pocket).toBe(RAIFFEISEN_ACCOUNT);
    expect(statementFingerprint(result.rows[0])).toBe(statementFingerprint(parseStatementCsv(csv()).rows[0]));
  });

  it("preserves named Raiffeisen accounts in legacy workbooks and normalizes only main aliases", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Umsätze");
    sheet.addRow(["Datum", "Beschreibung", "Betrag", "Bank", "Konto"]);
    for (const pocket of ["", "Hauptkonto", RAIFFEISEN_ACCOUNT, "Raiffeisen Giro (USD)", "Sparkonto"]) {
      sheet.addRow(["2026-09-14", "BILLA", -12.34, "Raiffeisen", pocket]);
    }
    sheet.addRow(["2026-09-14", "BILLA", -12.34, "Revolut", "Urlaub 2026"]);
    const result = await parseWorkbook(await bufferFor(workbook));
    expect(result.skipped).toBe(0);
    expect(result.state.transactions.map((row) => row.pocket)).toEqual([
      RAIFFEISEN_ACCOUNT, RAIFFEISEN_ACCOUNT, RAIFFEISEN_ACCOUNT, "Raiffeisen Giro (USD)", "Sparkonto", "Urlaub",
    ]);
  });

  it("round-trips canonical accounts and old decisions in native Excel without changing the source", async () => {
    const original = {
      ...createSeed(), transactions: [booking({ pocket: "Hauptkonto" }), booking({ id: "usd", pocket: "Raiffeisen Giro (USD)" })],
      ignoredStatementKeys: [oldKey(booking({ pocket: "Hauptkonto" }))],
    };
    const buffer = await exportWorkbook(original);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    expect(workbook.getWorksheet("Umsätze")!.getCell("C2").value).toBe(RAIFFEISEN_ACCOUNT);
    const loaded = (await parseWorkbook(buffer)).state;
    expect(loaded.transactions).toEqual(original.transactions.map(normalizeAccount));
    expect(loaded.settings).toEqual(original.settings);
    expect(loaded.ignoredStatementKeys).toEqual([statementFingerprint(booking())]);
    expect(original.transactions[0].pocket).toBe("Hauptkonto");
  });
});
