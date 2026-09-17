import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { actualBookings, classify } from "@/lib/calc";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type Transaction } from "@/lib/types";
import { parseAmexText } from "./amex-pdf";
import { statementFingerprint } from "./identity";
import { merchantRuleKey } from "./merchant-rules";
import { ambiguousMerchant, recoverMerchant, unresolvedTerminal } from "./merchant-description";
import { commitStatementImport, openReviewCount, prepareStatementImport, queueLedgerReview } from "./review";
import { parseStatementCsv, parseStatementFile, type StatementResult } from "./statements";

const noise = "POS 8,40 AT D1 04.09. 16:55 Kartenfolge-Nr.: 1";
const merchant = "MARTIN AUER ATRIOVIL VILLACH 9500";
const csv = (details = merchant, date = "04.09.2026", terminal = noise) => parseStatementCsv(
  `Raiffeisen\nBuchungsdatum;Buchungstext;Valuta;Betrag;Verwendungszweck;Währung\n${date};${terminal};${date};-8,40;${details};EUR`,
);
const legacy = (): Transaction => ({ id: "old-pos", date: "2026-09-04", bank: "Raiffeisen", pocket: "Raiffeisen Giro", description: noise, amount: -8.4, category: "Sonstiges", includeInPlan: true });
const importAll = (state: ReturnType<typeof createSeed>, results: StatementResult[]) => {
  const prepared = prepareStatementImport(results, state);
  return queueLedgerReview(commitStatementImport(state, prepared.automatic, [], prepared.metadata).state);
};

describe("POS merchant recovery", () => {
  const paymentReference = "POS 3,50 AT D1 09.09. 11:53 Kartenfolge-Nr.: 1";
  const namedSource = (label = "Händler Name", first = false) => [
    "Raiffeisen",
    `Buchungsdatum;${first ? `${label};` : ""}Buchungstext;Betrag;Zahlungsreferenz;${first ? "" : `${label};`}Referenz`,
    `10.09.2026;${first ? "BILLA;" : ""}${paymentReference};-3,50;Beleg TEST-350;${first ? "" : "BILLA;"}synthetic-reference`,
  ].join("\n");

  it.each(["Händler Name", "Händlername", "Haendler Name", "Merchant Name"])("prefers the explicit %s column over payment references in any column order", (label) => {
    for (const first of [false, true]) {
      const parsed = parseStatementCsv(namedSource(label, first));
      expect(parsed.issues).toEqual([]);
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0]).toMatchObject({
        description: "BILLA", rawDescription: paymentReference, amount: -3.5,
        date: "2026-09-10", time: "11:53:00", bankReference: "synthetic-reference",
      });
      expect(parsed.rows[0].rawDetails).toEqual(expect.arrayContaining(["BILLA", "Beleg TEST-350"]));
    }
  });

  it("accepts Zahlungsreferenz as the source text when no booking-text column exists", () => {
    const parsed = parseStatementCsv(`Raiffeisen\nBuchungsdatum;Zahlungsreferenz;Betrag;Händler Name\n10.09.2026;${paymentReference};-3,50;BILLA`);
    expect(parsed.rows[0]).toMatchObject({ description: "BILLA", rawDescription: paymentReference, amount: -3.5, date: "2026-09-10" });
  });

  it("shares named-column precedence with Raiffeisen XLSX statements", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Raiffeisen");
    namedSource().split("\n").slice(1).forEach((row) => sheet.addRow(row.split(";")));
    const buffer = await workbook.xlsx.writeBuffer() as ArrayBuffer;
    const parsed = await parseStatementFile({ name: "synthetic-raiffeisen.xlsx", size: buffer.byteLength, arrayBuffer: async () => buffer });
    expect(parsed.rows[0]).toMatchObject({ description: "BILLA", rawDescription: paymentReference, bankReference: "synthetic-reference", amount: -3.5 });
  });

  it.each(["Händler Name", "Händlername", "Haendler Name", "Merchant Name"])("recovers persisted labelled %s without changing any original bank facts", (label) => {
    const row = {
      ...legacy(), date: "2026-09-10", amount: -3.5, description: paymentReference,
      rawDescription: paymentReference, bankReference: "synthetic-reference",
      rawDetails: [`Zahlungsreferenz: ${paymentReference}`, `Verwendungszweck: Kartenzahlung`, `${label}: BILLA`],
    };
    expect(recoverMerchant(row)).toEqual({ ...row, description: "BILLA" });
    expect(recoverMerchant({ ...row, description: "Pizzeria" }).description).toBe("Pizzeria");
  });

  it("separates an embedded merchant label from payment and card metadata", () => {
    const row = {
      description: `Zahlungsreferenz: ${paymentReference} Händler Name: BILLA IBAN: AT000000000000000000 BIC: TESTAT00`,
    };
    expect(recoverMerchant(row)).toEqual({ description: "BILLA", rawDescription: row.description });
  });

  it("prefers named merchants over conflicting purpose text and detects conflicts within one raw field", () => {
    const row = {
      description: paymentReference,
      rawDetails: ["Verwendungszweck: SPAR Zahlungsreferenz: Beleg TEST-350 Händler Name: BILLA"],
    };
    expect(recoverMerchant(row).description).toBe("BILLA");
    const conflicting = { ...row, rawDetails: ["Händler Name: BILLA Merchant Name: SPAR"] };
    expect(ambiguousMerchant(conflicting)).toBe(true);
    expect(recoverMerchant(conflicting)).toBe(conflicting);
  });

  it("keeps a Raiffeisen POS payment reference without a merchant in review", () => {
    const parsed = parseStatementCsv(`Raiffeisen\nBuchungsdatum;Zahlungsreferenz;Betrag;Händler Name\n10.09.2026;${paymentReference};-3,50;`);
    expect(parsed.rows[0]).toMatchObject({ description: paymentReference, amount: -3.5, date: "2026-09-10" });
    expect(prepareStatementImport([parsed], createSeed()).review).toHaveLength(1);
  });

  it("does not choose between conflicting named merchants or invent one from empty labelled fields", () => {
    const conflicting = { description: paymentReference, rawDetails: ["Händler Name: BILLA", "Merchant Name: SPAR"] };
    expect(ambiguousMerchant(conflicting)).toBe(true);
    expect(recoverMerchant(conflicting)).toBe(conflicting);
    for (const name of ["", paymentReference]) {
      const row = { ...legacy(), description: paymentReference, rawDetails: [`Händler Name: ${name}`, `Zahlungsreferenz: ${paymentReference}`] };
      expect(recoverMerchant(row)).toBe(row);
      expect(openReviewCount(queueLedgerReview({ ...createSeed(), transactions: [row] }).reviewQueue ?? [])).toBe(1);
    }
  });

  it("repairs saved named metadata and re-dropped imports without duplicate ledger rows", async () => {
    const row = {
      ...legacy(), date: "2026-09-10", amount: -3.5, description: paymentReference,
      bankReference: "synthetic-reference", rawDetails: [`Händler Name: BILLA`, `Zahlungsreferenz: ${paymentReference}`],
    };
    const state = { ...createSeed(), transactions: [row] };
    const restored = (await parseWorkbook(await exportWorkbook(state))).state;
    const repaired = queueLedgerReview(restored);
    expect(repaired.transactions[0]).toMatchObject({
      id: row.id, date: row.date, amount: row.amount, bank: row.bank, pocket: row.pocket,
      bankReference: row.bankReference, rawDetails: row.rawDetails, description: "BILLA", rawDescription: paymentReference,
    });
    expect(importAll(repaired, [parseStatementCsv(namedSource())]).transactions).toHaveLength(1);
    const withoutDetails = { ...state, transactions: [{ ...row, rawDetails: undefined }] };
    const reimported = importAll(withoutDetails, [parseStatementCsv(namedSource())]);
    expect(reimported.transactions).toHaveLength(1);
    expect(reimported.transactions[0]).toMatchObject({ id: row.id, description: "BILLA", rawDescription: paymentReference, bankReference: row.bankReference, amount: row.amount, date: row.date });
  });

  it.each([false, true])("recovers named PDF continuation fields regardless of order (merchant first: %s)", (first) => {
    const details = ["Händler Name: BILLA", `Zahlungsreferenz: ${paymentReference}`];
    if (!first) details.reverse();
    const parsed = parseAmexText([`American Express\n30.09.2026\nUmsatz vom Buchung am Betrag in EUR\n10.09 10.09 ${paymentReference} 3,50\n${details.join("\n")}`]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({ description: "BILLA", rawDescription: paymentReference, rawDetails: details, amount: -3.5 });
  });

  it.each([
    { description: noise, rawDetails: [], ambiguous: false },
    { description: noise, rawDetails: ["BILLA"], ambiguous: false },
    { description: noise, rawDetails: ["BILLA", "  billa  "], ambiguous: false },
    { description: noise, rawDetails: ["BILLA", "SPAR"], ambiguous: true },
    { description: "Verwendungszweck: BILLA", rawDetails: ["Verwendungszweck: SPAR"], ambiguous: true },
    { description: noise, rawDetails: ["Verwendungszweck: BILLA", "Zahlungsreferenz: SPAR"], ambiguous: false },
    { description: "Pizzeria", rawDetails: ["BILLA", "SPAR"], ambiguous: false },
  ])("detects merchant ambiguity without treating noise or repeated evidence as a conflict: %j", ({ ambiguous, ...source }) => {
    expect(ambiguousMerchant(source)).toBe(ambiguous);
    if (ambiguous) expect(recoverMerchant(source)).toBe(source);
  });
  it("uses Verwendungszweck rather than POS and retains bank facts and identity", () => {
    const booking = csv().rows[0];
    expect(booking).toMatchObject({ description: "Martin Auer", rawDescription: noise, time: "16:55:00", amount: -8.4, date: "2026-09-04" });
    expect(booking.rawDetails).toContain(merchant);
    expect(classify(booking).merchant).toBe("Martin Auer");
    expect(statementFingerprint(booking)).toBe(statementFingerprint({ ...booking, description: noise, rawDescription: undefined }));
    expect(merchantRuleKey(booking)).toBe("raiffeisen|martin auer");
  });
  it.each(["POS 16:55", "Bancomat/POS 8,40 AT D1", "Terminal 123456", "Terminal-ID: ABC123", "POS Zahlung 8,40", "Kartenfolge-Nr.: 1", "AT D1 04.09. 16:55"])("does not learn %s as a merchant", (description) => {
    expect(unresolvedTerminal(description)).toBe(true);
    expect(recoverMerchant({ description, rawDetails: ["EUR", "04.09.2026", "123456", merchant] }).description).toBe("Martin Auer");
    expect(classify({ ...legacy(), description }).merchant).toBe("Händler unbekannt");
  });
  it("reads extended headerless rows, unknown extra text fields and embedded merchant names", () => {
    const headerless = parseStatementCsv(`04.09.2026;${noise};04.09.2026;-8,40;EUR;04.09.2026 16:55:00:000;${merchant}`);
    expect(classify(headerless.rows[0]).merchant).toBe("Martin Auer");
    const extra = parseStatementCsv(`Raiffeisen\nDatum;Beschreibung;Betrag;Notiz\n04.09.2026;${noise};-8,40;${merchant}`);
    expect(classify(extra.rows[0]).merchant).toBe("Martin Auer");
    expect(classify(csv("", "04.09.2026", `${noise} ${merchant}`).rows[0]).merchant).toBe("Martin Auer");
    expect(recoverMerchant({ description: "Pizzeria", rawDetails: [merchant] }).description).toBe("Pizzeria");
  });
  it("resolves PDF continuation details through the same merchant parser", () => {
    const pdf = parseAmexText([`American Express\n30.09.2026\nUmsatz vom Buchung am Betrag in EUR\n04.09 05.09 ${noise} 8,40\nVerwendungszweck: ${merchant}`]);
    expect(pdf.issues).toEqual([]);
    expect(pdf.rows).toHaveLength(1);
    expect(classify(pdf.rows[0]).merchant).toBe("Martin Auer");
    expect(pdf.rows[0]).toMatchObject({ rawDescription: noise, amount: -8.4, time: "16:55:00" });
  });
  it("keeps the richer duplicate in a multi-file drop regardless of order", () => {
    for (const results of [[csv(""), csv()], [csv(), csv("")]]) {
      const prepared = prepareStatementImport(results, createSeed());
      expect(prepared.review).toEqual([]);
      expect(prepared.duplicates).toBe(1);
      expect(prepared.automatic).toHaveLength(1);
      expect(prepared.automatic[0]).toMatchObject({ description: "Martin Auer", category: "Cafés & Snacks" });
    }
  });
  it("rescans persisted detail fields and enriches legacy rows on re-drop without duplicates", () => {
    const state = createSeed(); state.transactions = [legacy()];
    const restored = appStateSchema.parse(JSON.parse(JSON.stringify({ ...state, transactions: [{ ...legacy(), rawDetails: [merchant] }] })));
    expect(queueLedgerReview(restored).transactions[0].description).toBe("Martin Auer");
    const repaired = importAll(state, [csv()]);
    expect(repaired.transactions).toHaveLength(1);
    expect(repaired.transactions[0]).toMatchObject({ id: "old-pos", amount: -8.4, description: "Martin Auer", rawDescription: noise });
    expect(openReviewCount(repaired.reviewQueue ?? [])).toBe(0);
    expect(importAll(repaired, [csv()]).transactions).toHaveLength(1);
    const other = importAll({ ...state, transactions: [{ ...legacy(), date: "2026-09-03" }] }, [csv()]);
    expect(other.transactions[0].description).toBe(noise);
  });
  it("leaves conflicting recovery candidates and unresolved manually categorized POS rows open", () => {
    const state = createSeed(); state.transactions = [{ ...legacy(), category: "Freizeit", categoryOverride: true }];
    expect(openReviewCount(queueLedgerReview(state).reviewQueue ?? [])).toBe(1);
    const ambiguous = importAll(state, [csv(), csv("ANDERER LADEN")]);
    expect(ambiguous.transactions[0].description).toBe(noise);
  });
  it("repairs legacy POS rows with missing pocket or reference without changing their identity", () => {
    for (const booking of [{ ...legacy(), pocket: null }, { ...legacy(), bankReference: "existing-reference" }]) {
      const state = createSeed(); state.transactions = [booking];
      const repaired = importAll(state, [csv()]);
      expect(repaired.transactions).toHaveLength(1);
      expect(repaired.transactions[0]).toMatchObject({ id: booking.id, pocket: booking.pocket, description: "Martin Auer", amount: booking.amount });
      expect(importAll(repaired, [csv()]).transactions).toHaveLength(1);
    }
  });
});

describe("durable merchant choices", () => {
  it.each([merchant, "NEUER LOKALER LADEN"])("remembers %s for later statements and through Excel restore", async (name) => {
    let state = importAll(createSeed(), [csv(name)]);
    const review = state.reviewQueue![0];
    if (name === merchant) expect(review).toBeUndefined();
    else expect(review?.kind).toBe("booking");
    const choice = review?.kind === "booking" ? review.draft : state.transactions[0];
    state = queueLedgerReview(commitStatementImport(state, [{ ...choice, amount: -8.4, category: "Shopping", categoryOverride: true }]).state);
    expect(state.reviewQueue).toEqual([]);
    state = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    state = (await parseWorkbook(await exportWorkbook(state))).state;
    const nextName = name === merchant ? "Martin Auer KLAGENFURT 9020" : name.toLowerCase();
    const later = csv(nextName, "05.09.2026", "POS 8,40 AT D2 05.09. 10:15 Kartenfolge-Nr.: 2");
    const pdf = parseAmexText(["American Express\n30.09.2026\nUmsatz vom Buchung am Betrag in EUR\n06.09 06.09 BIPA 5,00"]);
    const prepared = prepareStatementImport([later, pdf], state);
    expect(prepared.review).toEqual([]);
    expect(prepared.automatic.find((row) => row.bank === "Raiffeisen")?.category).toBe("Shopping");
    state = importAll(state, [later, pdf]);
    expect(actualBookings(state)).toHaveLength(3);
    expect(state.transactions[0].rawDescription).toBe(noise);
    expect(importAll(state, [later, pdf]).transactions).toHaveLength(3);
  });
  it("honors a rule learned before merchant-key normalization", () => {
    const state = createSeed();
    state.merchantRules = [{ key: "raiffeisen|martin auer atriovil villach 9500", category: "Freizeit" }];
    expect(prepareStatementImport([csv()], state).automatic[0].category).toBe("Freizeit");
  });
});
