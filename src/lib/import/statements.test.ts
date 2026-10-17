import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { actualPockets, classify, classifyStatementRows } from "@/lib/calc";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { createSeed } from "@/lib/seed";
import { type Transaction } from "@/lib/types";
import { MAX_IMPORT_BYTES, MAX_STATEMENT_ROWS } from "./limits";
import {
  appendStatementRows,
  deduplicateStatements,
  detectStatementSource,
  parseStatementAmount,
  parseStatementCsv,
  parseStatementDate,
  parseStatementFile,
  prepareStatementPreview,
} from "./statements";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.csv`, import.meta.url), "utf8");
const transaction = (
  description: string,
  amount = -10,
  date = "2026-09-12",
): Transaction => ({
  id: crypto.randomUUID(),
  date,
  bank: "Revolut",
  pocket: "Persönliches Konto",
  description,
  category: "Prüfen",
  amount,
  includeInPlan: true,
});
const file = (name: string, data: string | ArrayBuffer) => {
  const buffer =
    typeof data === "string" ? new TextEncoder().encode(data).buffer : data;
  return { name, size: buffer.byteLength, arrayBuffer: async () => buffer };
};

describe("statement amounts and dates", () => {
  it.each([
    ["1.339,54", 1339.54],
    ["-0,47", -0.47],
    ["-1.529,58", -1529.58],
    ["2.576,43", 2576.43],
    ["−12,30 €", -12.3],
    ["(12,30)", -12.3],
    ["12,30-", -12.3],
    ["1339.54", 1339.54],
    ["1.339", 1339],
    ["0,00", 0],
  ] as const)("reads %s", (input, expected) =>
    expect(parseStatementAmount(input)).toBe(expected),
  );
  it.each(["", "Guthaben", "1.23,45", "1,2,3", "12,345", "NaN"])(
    "rejects malformed amount %s",
    (input) => expect(parseStatementAmount(input)).toBeNull(),
  );
  it("validates real dates, leap years and calendar-date timestamps", () => {
    expect(parseStatementDate("11.09.2026")).toBe("2026-09-11");
    expect(parseStatementDate("1.9.2026")).toBe("2026-09-01");
    expect(parseStatementDate("2026-09-11T23:45:00+02:00")).toBe("2026-09-11");
    expect(parseStatementDate("31.02.2026")).toBeNull();
    expect(parseStatementDate("29.02.2024")).toBe("2024-02-29");
  });
});

describe("Raiffeisen CSV", () => {
  it("sniffs semicolon headers, preserves Giro and parses German amounts", () => {
    const result = parseStatementCsv(fixture("raiffeisen"));
    expect(result.source).toBe("Raiffeisen");
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]).toMatchObject({
      bank: "Raiffeisen",
      pocket: "Raiffeisen Giro",
      date: "2026-09-12",
      amount: 2576.43,
      category: "Gehalt",
      includeInPlan: false,
    });
    expect(result.rows[1]).toMatchObject({
      amount: -1529.58,
      category: "Leasing",
    });
    expect(result.rows[2]).toMatchObject({
      amount: -0.47,
      // 13.09.2026 is a Sunday: BIPA is lunch on working days only.
      category: "Drogerie",
      includeInPlan: true,
    });
    expect(result.rows[3]).toMatchObject({
      category: "Prüfen",
      includeInPlan: false,
    });
    expect(result.skipped).toBe(2);
    expect(result.issues).toHaveLength(1);
  });
  it("handles BOM, CRLF, quoted delimiters, escaped quotes and multiline descriptions", () => {
    const result = parseStatementCsv(
      '\uFEFFBuchungsdatum;Verwendungszweck/Text;Valuta;Betrag;EUR;timestamp\r\n12.09.2026;"BIPA; Filiale ""Mitte""\r\nKartenzahlung";12.09.2026;-4,50;EUR;\r\n',
    );
    expect(result.rows[0]).toMatchObject({
      description: 'BIPA; Filiale "Mitte" Kartenzahlung',
      amount: -4.5,
    });
  });
  it("does not guess malformed quoted CSV", () =>
    expect(() =>
      parseStatementCsv(
        'Buchungsdatum;Verwendungszweck/Text;Valuta;Betrag\n12.09.2026;"BIPA;12.09.2026;-3,20',
      ),
    ).toThrow("Anführungszeichen"));
});

describe("Revolut consolidated CSV", () => {
  it("preserves multi-pocket sections and ignores headers, totals, separators and zero movement", () => {
    const result = parseStatementCsv(fixture("revolut"));
    expect(result.source).toBe("Revolut");
    expect(result.rows).toHaveLength(6);
    expect(result.rows.map((row) => row.pocket)).toEqual([
      "Persönliches Konto",
      "Mittagessen",
      "Mittagessen",
      "Sparen",
      "Urlaub 2026",
      "Amex Rückzahlung",
    ]);
    expect(result.rows[0]).toMatchObject({
      category: "Lebensmittel",
      amount: -10,
    });
    expect(classify(result.rows[2])).toMatchObject({
      planCategory: "Round-up Sparkonto",
      includeInPlan: false,
      pocket: "Sparkonto",
    });
    expect(result.rows[3]).toMatchObject({
      category: "Transfer intern",
      amount: 0.47,
      includeInPlan: false,
    });
    expect(result.rows[4].includeInPlan).toBe(false);
    expect(result.skipped).toBe(4);
    expect(result.issues).toEqual([]);
  });
  it("reads separate incoming/outgoing columns and uses movement, not balance", () => {
    const result = parseStatementCsv(
      "Revolut\nSparen (EUR)\nKontoauszug zu Transaktionen\nDatum;Beschreibung;Kategorie;Geld eingezahlt;Geld ausgezahlt;Guthaben\n12.09.2026;Einzahlung;Transfer intern;1.339,54;;8.000,00\n13.09.2026;BIPA;;;-0,47;7.999,53",
    );
    expect(result.rows.map((row) => row.amount)).toEqual([1339.54, -0.47]);
  });
  it("does not import summary tables before transaction blocks or non-EUR spend", () => {
    const result = parseStatementCsv(
      "Revolut\nPersönliches Konto (EUR)\nDatum;Beschreibung;Geld ein-/ausgezahlt\n12.09.2026;Nicht importieren;-50,00\nKontoauszug zu Transaktionen\nDatum;Beschreibung;Geld ein-/ausgezahlt\n12.09.2026;BIPA;-2,00\nPersönliches Konto (USD)\nKontoauszug zu Transaktionen\nDatum;Beschreibung;Geld ein-/ausgezahlt\n12.09.2026;BIPA;-3,00",
    );
    expect(result.rows).toHaveLength(1);
    expect(result.issues[0].message).toContain("Fremdwährung USD");
  });
});

describe("Amex", () => {
  it("maps positive card charges to spend, refunds to income, and distinguishes holders", () => {
    const result = parseStatementCsv(fixture("amex"));
    expect(result.source).toBe("Amex");
    expect(result.rows[0]).toMatchObject({
      bank: "Amex",
      pocket: "AMEX Jannis",
      description: "Pizzeria, Zentrum",
      amount: -24.9,
    });
    expect(result.rows[1]).toMatchObject({
      pocket: "AMEX Raphael",
      amount: -40,
    });
    expect(result.rows[2]).toMatchObject({
      amount: 10,
      description: 'Erstattung "Bestellung"',
    });
  });
  it("sniffs typical EU headers without a brand line", () => {
    expect(
      detectStatementSource([
        ["Date", "Description", "Card Member", "Account #", "Amount"],
      ]),
    ).toBe("Amex");
    expect(
      parseStatementCsv(
        "Date,Description,Card Member,Account #,Amount\n12/09/2026,BIPA,Jannis,XXXX,3.50",
      ).rows[0].amount,
    ).toBe(-3.5);
  });
  it("accepts already extracted text saved as CSV, but not binary PDFs", () => {
    const result = parseStatementCsv(
      "American Express\n12.09.2026 Pizzeria Zentrum 24,90\n13.09.2026 Erstattung -10,00",
    );
    expect(result.rows.map((row) => row.amount)).toEqual([-24.9, 10]);
    expect(() => parseStatementCsv("%PDF-1.7 binary")).toThrow("PDF-Dateien");
  });
});

describe("classification uses the existing engine", () => {
  it.each([
    ["BIPA", -25, "Mittagessen"],
    ["Trafik", -8, "Shopping"],
    ["INTERSPAR", -10, "Mittagessen"],
    ["SPAR", -10.01, "Lebensmittel"],
    ["dm drogerie", -4, "Drogerie"],
    ["Burgschenke", -20, "Restaurants"],
    ["BANKOMAT", -20, "Körperpflege"],
    ["TeamTalentSolutions", 400, "Rufbereitschaft"],
    ["Gehalt", 2576.43, "Gehalt"],
    ["Porsche Bank", -289, "Leasing"],
    ["Allianz", -50, "Versicherungen"],
    ["Vollkasko Dauerauftrag", -63, "Versicherungen"],
    ["A1 Telekom", -25, "Telefon & Internet"],
  ] as const)("classifies %s centrally", (description, amount, category) =>
    expect(
      classifyStatementRows([{ ...transaction(description, amount, "2026-09-14"), time: "12:00:00" }])[0].category,
    ).toBe(category),
  );
  it.each([
    "Eventim",
    "Magazin Salzburg",
    "Salzburger Verkehr",
    "Sky Chefs",
    "LSG",
    "Roof Burger",
    "Filomena",
    "Bravofly",
    "Urlaub",
    "Führerschein",
  ])("excludes %s even after manual categorization", (description) =>
    expect(
      classify({
        ...transaction(description),
        category: "Ausgehen",
        categoryOverride: true,
      }).includeInPlan,
    ).toBe(false),
  );
  it("uses strict round-up threshold and recognizes internal transfers", () => {
    expect(classify(transaction("Auszahlung bei Pocket", -1.99))).toMatchObject(
      {
        isRoundUp: true,
        category: "Transfer intern",
        planCategory: "Round-up Sparkonto",
        includeInPlan: false,
      },
    );
    expect(classify(transaction("Auszahlung bei Pocket", -2))).toMatchObject({
      isRoundUp: false,
      category: "Transfer intern",
      includeInPlan: false,
    });
    expect(classify(transaction("AMZ Marketplace", -25))).toMatchObject({
      pocket: null,
      includeInPlan: false,
    });
  });
  it("does not infer a merchant or subscription from repeating provider amounts", () => {
    const one = transaction("PayPal Europe", -2.99, "2026-09-03");
    expect(classifyStatementRows([one])[0].category).toBe("Prüfen");
    expect(
      classifyStatementRows(
        [one],
        [transaction("PayPal Europe", -2.99, "2026-08-03")],
      )[0],
    ).toMatchObject({ category: "Prüfen", includeInPlan: false });
  });
  it("preserves preview category/pocket edits and plan choice", () => {
    const edited = {
      ...transaction("dm drogerie"),
      category: "Shopping" as const,
      categoryOverride: true,
      pocket: "AMEX Jannis",
      includeInPlan: true,
    };
    expect(classify(edited)).toMatchObject({
      category: "Shopping",
      includeInPlan: true,
      pocket: null,
    });
    expect(classifyStatementRows([edited])[0].pocket).toBe("AMEX Jannis");
  });
  it("maps savings aliases without treating Giro or spending budgets as savings assets", () => {
    const state = createSeed();
    state.settings.asOf = "2026-09-12";
    state.transactions = [
      {
        ...transaction("Einzahlung", 100),
        pocket: "Sparen",
        category: "Transfer intern",
      },
      transaction("Mensa", -5),
      {
        ...transaction("Gehalt", 2500),
        pocket: "Raiffeisen Giro",
        bank: "Raiffeisen",
      },
    ];
    expect(actualPockets(state)).toEqual({
      ...state.settings.balances,
      Sparkonto: 1882.59,
    });
  });
});

describe("dedupe and append", () => {
  it("keeps different pockets and full descriptions distinct", () => {
    const row = transaction("Ein Händler mit langem Namen Referenz A", -12.34);
    const same = {
      ...row,
      id: "other",
      pocket: "Anderes Pocket",
      description: "Ein Händler mit langem Namen Referenz B",
      amount: -12.34001,
    };
    expect(
      deduplicateStatements(
        [
          same,
          { ...same, bank: "Amex" },
          { ...same, date: "2026-09-13" },
          { ...same, amount: -12.35 },
        ],
        [row],
      ),
    ).toMatchObject({ duplicates: 0, rows: expect.any(Array) });
    expect(
      deduplicateStatements(
        [
          same,
          { ...same, bank: "Amex" },
          { ...same, date: "2026-09-13" },
          { ...same, amount: -12.35 },
        ],
        [row],
      ).rows,
    ).toHaveLength(4);
  });
  it("handles mixed files, repeated drops, and already imported rows", () => {
    const raiffeisen = parseStatementCsv(fixture("raiffeisen"));
    const revolut = parseStatementCsv(fixture("revolut"));
    const preview = prepareStatementPreview(
      [raiffeisen, revolut, raiffeisen],
      [raiffeisen.rows[0]],
    );
    expect(preview.rows).toHaveLength(9);
    expect(preview.duplicates).toBe(5);
    const state = createSeed();
    state.transactions = [raiffeisen.rows[0], revolut.rows[0]];
    const result = appendStatementRows(state, preview.rows);
    expect(result.added).toBe(8);
    expect(result.duplicates).toBe(1);
    expect(result.state.transactions).toHaveLength(10);
    expect(state.transactions).toHaveLength(2);
    expect(result.state.settings).toEqual(state.settings);
    expect(result.state.financeRows).toEqual(state.financeRows);
    expect(appendStatementRows(result.state, preview.rows).added).toBe(0);
  });
  it("respects the ledger limit without partial append", () => {
    const state = createSeed();
    state.transactions = Array(MAX_STATEMENT_ROWS).fill(
      transaction("Existing"),
    );
    expect(() => appendStatementRows(state, [transaction("New")])).toThrow(
      "100.000",
    );
    expect(state.transactions).toHaveLength(MAX_STATEMENT_ROWS);
  });
});

describe("file handling and Excel compatibility", () => {
  it("reports unknown, unsupported, too-large and broken files in German", async () => {
    expect(() => parseStatementCsv("foo;bar\n1;2")).toThrow(
      "Dateityp nicht erkannt",
    );
    await expect(parseStatementFile(file("test.pdf", "text"))).rejects.toThrow(
      "PDF-Datei konnte nicht gelesen werden",
    );
    await expect(parseStatementFile(file("test.txt", "text"))).rejects.toThrow(
      "CSV-, XLSX- oder PDF-Format oder einen Amex-Screenshot (PNG, JPEG, WebP)",
    );
    await expect(
      parseStatementFile({
        name: "test.csv",
        size: MAX_IMPORT_BYTES + 1,
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    ).rejects.toThrow("20 MB");
    await expect(
      parseStatementFile(file("test.xlsx", "broken")),
    ).rejects.toThrow("XLSX-Datei");
  });
  it("decodes old Windows-1252 CSV exports", async () => {
    const text =
      "Buchungsdatum;Verwendungszweck/Text;Valuta;Betrag\n12.09.2026;Händler;12.09.2026;-0,47";
    const bytes = Uint8Array.from(
      [...text].map((letter) => letter.charCodeAt(0)),
    ).buffer;
    expect(
      (await parseStatementFile(file("giro.csv", bytes))).rows[0].description,
    ).toBe("Händler");
  });
  it("reads XLSX statement cells with dates and numeric amounts", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Raiffeisen");
    sheet.addRow([
      "Buchungsdatum",
      "Verwendungszweck/Text",
      "Valuta",
      "Betrag",
    ]);
    sheet.addRow([
      new Date("2026-09-12T00:00:00Z"),
      "BIPA",
      "12.09.2026",
      -0.47,
    ]);
    const buffer = await workbook.xlsx.writeBuffer();
    expect(
      (
        await parseStatementFile(
          file("konto.xlsx", Uint8Array.from(new Uint8Array(buffer)).buffer),
        )
      ).rows[0],
    ).toMatchObject({
      amount: -0.47,
      date: "2026-09-12",
      pocket: "Raiffeisen Giro",
    });
  });
  it("round-trips original accounts and manual review fields through existing Excel backup", async () => {
    const state = createSeed();
    state.transactions = prepareStatementPreview(
      [
        parseStatementCsv(fixture("raiffeisen")),
        parseStatementCsv(fixture("revolut")),
        parseStatementCsv(fixture("amex")),
      ],
      [],
    ).rows;
    state.transactions[0] = {
      ...state.transactions[0],
      category: "Sonstiges",
      categoryOverride: true,
      includeInPlan: false,
    };
    const buffer = await exportWorkbook(state);
    const restored = await parseWorkbook(buffer);
    expect(restored.state.transactions).toEqual(state.transactions);
    expect(restored.state.settings).toEqual(state.settings);
    await expect(
      parseStatementFile(file("sicherung.xlsx", buffer)),
    ).rejects.toThrow("Finanzblick-Sicherung");
  });
});
