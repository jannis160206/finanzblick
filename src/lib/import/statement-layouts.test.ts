import { describe, expect, it } from "vitest";
import { classify } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { parseAmexText } from "./amex-pdf";
import { commitStatementImport, prepareStatementImport } from "./review";
import { appendStatementRows, parseStatementCsv, prepareStatementPreview, type StatementResult } from "./statements";

// Synthetic values/references only; private original statements stay local.
const amex = (lines: string) => parseAmexText([
  `American Express\n10.09.26\nUmsatz vom Buchung am Details Betrag in EUR\n${lines}`,
], "Reise.pdf");
const euroAccount = [
  "Revolut",
  "Persönliches Konto (EUR)",
  "Kontoauszug zu Transaktionen",
  "Datum;Beschreibung;Kategorie;Geld ein-/ausgezahlt;Guthaben",
  "01.09.2026;Umgetauscht in USD;Umtausch;-90,00€;500,00€",
].join("\n");
const dollarHeader = [
  "Persönliches Konto (USD)",
  "Kontoauszug zu Transaktionen",
  "Datum;Beschreibung;Kategorie;Geld ein-/ausgezahlt;Geld ein-/ausgezahlt;Guthaben;Guthaben;Gebühren;Gebühren",
].join("\n");
const taxLots = [
  "---------",
  "Investment Services Transaktionsnachweise",
  "Einheiten, die verkauft wurden",
  "Datum (des Verkaufs);Datum (des Kaufs);Beschreibung, Symbol und ISIN;Units sold;Wert (des Verkaufs);Wert (des Kaufs);Kapitalerträge",
  "02.09.2026;01.08.2026;Beispiel ETF;2;€200;€180;€20",
  "02.09.2026;02.08.2026;Beispiel ETF;3;€300;€270;€30",
  "Andere Transaktionen Depotkonto",
  "Datum;Beschreibung und Symbol;ISIN;Anzahl;Land;Bruttowert;Einbehaltene Steuern;Andere Steuern;Gebühren;Nettowert",
  "01.09.2026;Beispiel ETF;TEST;2;IE;€180;€0;€0;€0;€180",
  "---------",
  "Rohstoff Transaktionsnachweise",
  "Transaktionsauszug (Nur Einheiten die verkauft wurden)",
  "Datum (des Verkaufs);Datum (des Kaufs);Rohstoffname;Verkaufte Einheiten;Wert (des Verkaufs);Wert (des Kaufs);Kapitalerträge",
  "03.09.2026;01.08.2026;XAG;1;+50,00$;-40,00$;10,00$",
  "03.09.2026;01.08.2026;XAU;0.01;+60,00$;-50,00$;10,00$",
].join("\n");

describe("Amex structured travel and FX details", () => {
  it.each(["25,00", "40,00"])("keeps an ÖBB ticket reference without rejecting the %s charge", (amount) => {
    const parsed = amex(`01.09 02.09 WWW.OEBB.AT TICKET FOR WIEN ${amount}\n111000111 OEBB TICKET 111000111`);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      description: "WWW.OEBB.AT TICKET FOR WIEN",
      amount: -Number(amount.replace(",", ".")),
      rawDetails: ["111000111 OEBB TICKET 111000111"],
    });
  });

  it("retains two equal flight charges and a rental charge without making their details extra bookings", () => {
    const flight = "01.09 02.09 SWISS Intl Air Lines WIEN 125,00\nFlugstrecke:Von: WIEN\nNach: ZURICH Fluglinie: LX Klasse: S";
    const lines = `${flight}\nTicketnummer: 111111 Passagiername: TEST/ONE\n${flight}\nTicketnummer: 222222 Passagiername: TEST/TWO\n03.09 04.09 RENTALMOTORBIKE WIEN 85,00\nAutovermietung Ort: WIEN Datum: 03/09/26\nRückgabe: WIEN Datum: 03/09/26\nKilometer Vertragsnummer:TEST_123`;
    const parsed = amex(lines);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows.map((row) => row.amount)).toEqual([-125, -125, -85]);
    expect(parsed.rows[2].rawDetails).toHaveLength(3);
    const preview = prepareStatementPreview([parsed, amex(lines)], []);
    expect(preview.rows).toHaveLength(3);
    expect(preview.duplicates).toBe(3);
    const state = createSeed();
    state.transactions = [];
    const first = appendStatementRows(state, preview.rows);
    expect(appendStatementRows(first.state, amex(lines).rows).added).toBe(0);
  });

  it.each(["", " CR"])("uses the EUR column including the fee, with refund suffix '%s'", (credit) => {
    const parsed = amex(`01.09 02.09 HOTEL EXAMPLE 1,200.00 1.020,00${credit}\nUNITED STATES DOLLAR\nReferenzwechselkurs 1.2000 + Entgelt in EUR 20,00\n03.09 03.09 BIPA 5,00`);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows.map((row) => row.amount)).toEqual([credit ? 1020 : -1020, -5]);
    expect(parsed.rows[0]).toMatchObject({
      description: "HOTEL EXAMPLE",
      rawDetails: expect.arrayContaining([
        "Originalbetrag: 1,200.00 UNITED STATES DOLLAR",
        "Referenzwechselkurs 1.2000 + Entgelt in EUR 20,00",
      ]),
    });
  });

  it.each([
    "01.09 02.09 HOTEL EXAMPLE 1,200.00 1.020,00",
    "01.09 02.09 HOTEL EXAMPLE 1,200.00 1.020,00\nUNITED STATES DOLLAR",
    "01.09 02.09 HOTEL EXAMPLE 1,200.00\nUNITED STATES DOLLAR\nReferenzwechselkurs 1.2000 + Entgelt in EUR 20,00",
    "01.09 02.09 HOTEL EXAMPLE 5,00 1,200.00 1.020,00\nUNITED STATES DOLLAR\nReferenzwechselkurs 1.2000 + Entgelt in EUR 20,00",
    "01.09 02.09 HOTEL EXAMPLE 1,200.00 1.020,00\nUNITED STATES DOLLAR\nReferenzwechselkurs 1.2000 + Entgelt in EUR 20,00\nUnbekannte Zusatzbuchung",
    "01.09 02.09 BIPA 5,00\n10,00",
    "01.09 02.09 SWISS Intl Air Lines WIEN\nFlugstrecke:Von: WIEN",
    "01.09 02.09 BIPA 5,00\nUnbekannter Abschnitt",
  ])("still reports ambiguous or missing facts: %s", (lines) => {
    const parsed = amex(`${lines}\n04.09 04.09 BILLA 12,00`);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toMatchObject({ file: "Reise.pdf", line: 4 });
    expect(parsed.rows.map((row) => row.amount)).toEqual([-12]);
  });
});

describe("Revolut tax export layouts", () => {
  it("uses explicitly labelled EUR movements, not USD values, balances or fees", () => {
    const result = parseStatementCsv(`${euroAccount}\n${dollarHeader}\n01.09.2026;Umgetauscht in USD;Umtausch;100,00$;89,80€;100,00$;89,80€;0,00$;0,00€\n02.09.2026;Beispielhändler;Händler;-95,00$;-85,20 EUR;5,00$;4,50€;1,00$;0,90€`);
    expect(result.issues).toEqual([]);
    expect(result.rows.map((row) => row.amount)).toEqual([-90, 89.8, -85.2]);
    expect(result.rows.map((row) => row.pocket)).toEqual([
      "Persönliches Konto", "Persönliches Konto (USD)", "Persönliches Konto (USD)",
    ]);
    expect(result.rows.slice(0, 2).every((row) => classify(row).isTransfer)).toBe(true);
    expect(classify(result.rows[2]).isTransfer).toBe(false);
    expect(result.rows[2].rawDetails).toEqual(expect.arrayContaining([
      "Originalbetrag (USD): -95,00$", "Eurogegenwert laut Auszug: -85,20 EUR",
    ]));
    expect(result.accountSnapshots).toEqual([
      expect.objectContaining({ name: "Persönliches Konto", balance: 500 }),
    ]);
  });

  it.each([
    "-100,00$;-90,00", // no currency label
    "-100,00$;", // no equivalent
    "-100,00$;-kaputt€", // unreadable equivalent
    "-100,00$;-90,00$", // two foreign amounts
    "-100,00€;-90,00€", // ambiguous pair
  ])("does not invent a EUR movement from %s or the EUR balance", (amounts) => {
    const result = parseStatementCsv(`${euroAccount}\n${dollarHeader}\n02.09.2026;Beispielhändler;Händler;${amounts};5,00$;4,50€;1,00$;0,90€`);
    expect(result.rows).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      message: expect.stringContaining("Fremdwährung USD"), draft: { amount: null },
    });
  });

  it("keeps zero EUR valuations out of the ledger and accepts a reversed labelled pair", () => {
    const result = parseStatementCsv(`${euroAccount}\n${dollarHeader}\n02.09.2026;Rundung;Händler;0,001$;0,00€;;;;\n03.09.2026;Beispielhändler;Händler;-9,00€;-10,00$;;;;`);
    expect(result.issues).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.rows.map((row) => row.amount)).toEqual([-90, -9]);
    expect(result.rows[1].rawDetails).toContain("Originalbetrag (USD): -10,00$");
  });

  it("ignores known security/depot/commodity tax details without changing account movements or balances", () => {
    const result = parseStatementCsv(`${euroAccount}\n${taxLots}`);
    const account = parseStatementCsv(euroAccount);
    expect(result.issues).toEqual([]);
    expect(result.rows.map((row) => row.amount)).toEqual([-90]);
    expect(result.skipped).toBe(6); // Five tax detail rows plus the existing account separator.
    expect(result.accountSnapshots).toEqual(account.accountSnapshots);
  });

  it("keeps identical EUR-valued movements on different currency accounts separate on repeat import", () => {
    const text = `${euroAccount}\n02.09.2026;BIPA;Händler;-9,00€;491,00€\n${dollarHeader}\n02.09.2026;BIPA;Händler;-10,00$;-9,00€;;;;`;
    const parsed = parseStatementCsv(text);
    expect(parsed.issues).toEqual([]);
    const preview = prepareStatementPreview([parsed, parseStatementCsv(text)], []);
    expect(preview.rows).toHaveLength(3);
    expect(preview.duplicates).toBe(3);
    expect(preview.rows.filter((row) => row.description === "BIPA").map((row) => row.pocket))
      .toEqual(["Persönliches Konto", "Persönliches Konto (USD)"]);
  });

  it("rejects more than two movement columns rather than selecting an arbitrary EUR amount", () => {
    const result = parseStatementCsv(`${euroAccount}\nPersönliches Konto (USD)\nKontoauszug zu Transaktionen\nDatum;Beschreibung;Geld ein-/ausgezahlt;Geld ein-/ausgezahlt;Geld ein-/ausgezahlt\n02.09.2026;BIPA;-10,00$;-9,00€;-8,00$`);
    expect(result.rows).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain("Fremdwährung USD");
  });

  it("resumes normal account sections and reports unknown layouts after tax details", () => {
    const result = parseStatementCsv(`${euroAccount}\n${taxLots}\n---------\nSparen (EUR)\nKontoauszug zu Transaktionen\nDatum;Beschreibung;Geld ein-/ausgezahlt\n04.09.2026;Einzahlung;10,00€\nDatum;Unbekanntes Layout\n05.09.2026;Nicht verstecken`);
    expect(result.rows.map((row) => row.amount)).toEqual([-90, 10]);
    expect(result.rows[1].pocket).toBe("Sparen");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain("Unbekannter Dateiabschnitt");
  });

  it("does not treat a merchant refund or another bank's text as a currency transfer", () => {
    const row = parseStatementCsv(euroAccount).rows[0];
    expect(classify({ ...row, sourceCategory: "Händler" }).isTransfer).toBe(true); // already classified row
    expect(classify({ ...row, category: "Prüfen", sourceCategory: "Händler" }).isTransfer).toBe(false);
    expect(classify({ ...row, category: "Prüfen", bank: "Amex" }).isTransfer).toBe(false);
    expect(classify({ ...row, category: "Prüfen", description: "Umtausch bei Beispielhändler" }).isTransfer).toBe(false);
  });
});
describe("file-scoped import error refresh", () => {
  const file = "Jahresauszug.csv";
  const existingIssues = [
    `${file}, Zeile 42: Alter Layoutfehler`,
    `${file}: Alter Dateifehler`,
    "Andere.csv, Zeile 42: Weiter prüfen",
    `${file}.backup.csv, Zeile 42: Weiter prüfen`,
    `${file}, Zeile Bericht.csv: Weiter prüfen`,
  ];
  const initial = () => {
    const state = createSeed();
    state.transactions = [];
    state.importStatus = { imported: 0, issues: existingIssues };
    return state;
  };

  it("replaces only reparsed file errors and does not duplicate bookings on re-drop", () => {
    const state = initial();
    const prepared = prepareStatementImport([parseStatementCsv(euroAccount, file)], state);
    const saved = commitStatementImport(state, prepared.automatic, [], prepared.metadata);
    expect(saved.state.importStatus?.issues).toEqual(existingIssues.slice(2));
    expect(saved.added).toBe(1);
    const again = prepareStatementImport([parseStatementCsv(euroAccount, file)], saved.state);
    const repeated = commitStatementImport(saved.state, again.automatic, [], again.metadata);
    expect(repeated.added).toBe(0);
    expect(repeated.state.importStatus).toEqual(saved.state.importStatus);
    expect(state.importStatus?.issues).toEqual(existingIssues);
  });

  it("replaces stale errors with remaining current errors", () => {
    const state = initial();
    const parsed = parseStatementCsv(`${euroAccount}\n${dollarHeader}\n02.09.2026;Beispielhändler;Händler;-10,00$;;;;;;;;`, file);
    const prepared = prepareStatementImport([parsed], state);
    const saved = commitStatementImport(state, prepared.automatic, [], prepared.metadata);
    expect(saved.state.importStatus?.issues).toEqual([...existingIssues.slice(2), ...prepared.issues]);
    expect(prepared.issues).toHaveLength(1);
  });

  it("preserves previous issues when the file could not be parsed", () => {
    const failed: StatementResult = {
      file, source: null, rows: [], skipped: 1,
      issues: [{ file, message: "Datei beschädigt" }],
    };
    const state = initial();
    const prepared = prepareStatementImport([failed], state);
    expect(prepared.metadata.reparsedFiles).toEqual([]);
    expect(commitStatementImport(state, [], [], prepared.metadata).state.importStatus?.issues)
      .toEqual([...existingIssues, `${file}: Datei beschädigt`]);
  });
});
