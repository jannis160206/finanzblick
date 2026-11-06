import { describe, expect, it, vi } from "vitest";
import { classifyStatementRows } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, transactionSchema } from "@/lib/types";
import { parseAmexScreenshotLines, screenshotAmount, screenshotDate, type ScreenshotLine } from "./amex-screenshot";
import { deduplicateStatements, parseStatementFile, prepareStatementPreview } from "./statements";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "./review";
import { parseAmexText } from "./amex-pdf";
import { recognizeAmexScreenshot, localOcrOptions } from "./amex-ocr";
import type { Worker } from "tesseract.js";

const line = (text: string, y: number, x = 40): ScreenshotLine =>
  ({ text, confidence: 95, bbox: { x0: x, x1: x + (x > 400 ? 130 : 280), y0: y, y1: y + 20 } });
const header = [
  line("09:41", 5), line("01.09.2026 - Aktuell", 50), line("Kartennummer -12345", 80), line("Filtern", 50, 480),
];
const booking = (merchant: string, y: number, date = "4 Okt 2026", amount = "€ 12,34") =>
  [line(merchant, y), line(date, y + 30), line(amount, y + 15, 500)];
const parse = (rows: ScreenshotLine[], file = "screen.png") => parseAmexScreenshotLines([...header, ...rows], file);
const groupedHeader = [line("American Express® Platinum Card", 40), line("••••61002", 70)];
const groupedParse = (rows: ScreenshotLine[], file = "Screenshot 2026-10-06.png") =>
  parseAmexScreenshotLines([...groupedHeader, ...rows], file);

describe("grouped Amex screenshot facts", () => {
  it("inherits date headers in scroll order, wraps merchants, attaches pending markers and ignores navigation", () => {
    const result = groupedParse([
      line("5 Okt", 120), line("SPAR", 180), line("€ 6,56", 180, 500), line("Vorgemerkt", 210, 500),
      line("Entertainment Gutschrift", 270), line("-€ 15,00", 270, 500),
      line("4 Okt", 340), line("Merchant", 400), line("City", 430), line("€ 13,20", 415, 500),
      line("Startseite", 700), line("Konto", 700, 500), line("Cropped", 650), line("€ 99,99", 650, 500),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.rows.map((row) => [row.date, row.description, row.amount, row.amexStatus])).toEqual([
      ["2026-10-05", "SPAR", -6.56, "pending"], ["2026-10-05", "Entertainment Gutschrift", 15, "posted"],
      ["2026-10-04", "Merchant City", -13.2, "posted"],
    ]);
    expect(result.rows.every((row) => row.amexSource === "screenshot" && row.amexCapturedAt === "2026-10-06" &&
      row.rawDetails?.[0] === "Amex-Screenshot")).toBe(true);
  });
  it("uses only Gesamtsaldo, not due payments or reward points, and leaves the billing cutoff to the batch", () => {
    const result = groupedParse([
      line("Gesamtsaldo", 110), line("€ 1.489,69", 140), line("Fällige Zahlung", 180), line("€ 0,00", 180, 500),
      line("Membership Rewards", 220), line("32.982", 220, 500),
      line("5 Okt", 300), line("Merchant", 380), line("€ 10,00", 380, 500),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.amexBalanceSnapshots).toBeUndefined();
    expect(result.amexScreenshot).toMatchObject({
      layout: "grouped", capturedAt: "2026-10-06", balance: 1489.69, balanceIncludesPending: false, card: "61002",
    });
  });
  it("records safe rows and review drafts interleaved in scroll order, excluding repayments and header errors", () => {
    const result = groupedParse([
      line("Gesamtsaldo", 110), line("€ 148969", 140), line("Fällige Zahlung", 180),
      line("5 Okt", 260), line("SPAR", 320), line("€ 6,56", 320, 500),
      line("Missing amount", 410),
      line("Other merchant", 500), line("€ 10,00", 500, 500),
      line("ZAHLUNG/ÜBERWEISUNG ERH...", 590), line("-€ 500,00", 590, 500),
      line("4 Okt", 680), line("Last merchant", 740), line("€ 4,00", 740, 500),
    ]);
    const drafts = result.issues.flatMap((issue) => issue.draft ? [issue.draft] : []);
    expect(result.issues[0].draft).toBeUndefined();
    expect(drafts).toHaveLength(1);
    expect(result.rows).toHaveLength(3);
    expect(result.amexScreenshot?.bookingOrder).toEqual([
      result.rows[0].id, drafts[0].id, result.rows[1].id, result.rows[2].id,
    ]);
    expect(result.skipped).toBe(2);
  });
  it("places cropped orphan-amount drafts before later safe rows in the source order", () => {
    const result = groupedParse([
      line("€ 12,34", 120, 500), line("5 Okt", 210), line("SPAR", 270), line("€ 6,56", 270, 500),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.issues[0].draft).toMatchObject({ date: "", description: "", amount: -12.34 });
    expect(result.amexScreenshot?.bookingOrder).toEqual([result.issues[0].draft?.id, result.rows[0].id]);
  });
  it.each([
    { text: "€ 148969", confidence: 95 }, { text: "€ 1.489,69", confidence: 30 },
    { text: "€ 1.489,69", confidence: 95, uncertain: true },
  ])("reports uncertain grouped balances without substituting the payment due ($text)", (amount) => {
    const result = groupedParse([
      line("Gesamtsaldo", 110), { ...line(amount.text, 140), ...amount }, line("Fällige Zahlung", 180),
      line("€ 0,00", 180, 500), line("5 Okt", 300), line("Merchant", 380), line("€ 10,00", 380, 500),
    ]);
    expect(result.amexScreenshot?.balance).toBeUndefined();
    expect(result.issues[0].message).toContain("Amex-Saldo");
    expect(result.rows).toHaveLength(1);
  });
  it("bounds inferred years by capture date and descends across December/January", () => {
    const result = groupedParse([
      line("2 Jan", 120), line("A shop", 180), line("€ 1,00", 180, 500),
      line("31 Dez", 270), line("B shop", 330), line("€ 2,00", 330, 500),
      line("30 Dez", 420), line("C shop", 480), line("€ 3,00", 480, 500),
    ], "Screenshot 2027-01-03.png");
    expect(result.rows.map((row) => row.date)).toEqual(["2027-01-02", "2026-12-31", "2026-12-30"]);
    expect(screenshotDate("31 Dez", "2027-01-03")).toBe("2026-12-31");
    expect(screenshotDate("29 Feb", "2026-03-01")).toBeNull();
  });
  it("does not interpret a wrapped numeric city as a date or propagate an invalid date", () => {
    const result = groupedParse([
      line("25 Sep", 120), line("Merchant", 180), line("29 MALAGA", 210), line("€ 6,10", 195, 500),
      line("32 Sep", 290), line("Other merchant", 350), line("€ 4,00", 350, 500),
    ]);
    expect(result.rows[0]).toMatchObject({ date: "2026-09-25", description: "Merchant 29 MALAGA", amount: -6.1 });
    expect(result.issues[0].draft).toMatchObject({ date: "", description: "Other merchant", amount: -4 });
  });
  it("keeps rows above the first visible date and rows without amounts in ordinary review", () => {
    const result = groupedParse([
      line("Cropped merchant", 120), line("€ 8,00", 120, 500),
      line("5 Okt", 210), line("Missing amount", 270),
    ]);
    expect(result.rows).toEqual([]);
    expect(result.issues.map((issue) => [issue.draft?.description, issue.draft?.date, issue.draft?.amount])).toEqual([
      ["Cropped merchant", "", -8], ["Missing amount", "2026-10-05", null],
    ]);
  });
  it("recognizes explicit additional holders and ignores cropped incoming card repayments", () => {
    const result = groupedParse([
      line("20 Sep", 120), line("McDonalds", 180), line("RAPHAEL PIBER", 210), line("€ 3,30", 195, 500),
      line("17 Sep", 290), line("ZAHLUNG/", 350), line("ÜBERWEISUNG ERH...", 380), line("-€ 500,00", 365, 500),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ pocket: "AMEX Raphael", description: "McDonalds" });
    expect(result.skipped).toBe(1);
    expect(result.issues).toEqual([]);
  });
  it("requires branded header plus masked card evidence, not dates and amounts alone", () => {
    for (const header of [[], [groupedHeader[0]], [groupedHeader[1]], [{ ...groupedHeader[0], confidence: 30 }, groupedHeader[1]]])
      expect(parseAmexScreenshotLines([...header, line("5 Okt", 120), line("SPAR", 180), line("€ 6,56", 180, 500)]).source).toBeNull();
  });
  it("recognizes combined branded/masked headers and compact grouped dates", () => {
    const result = parseAmexScreenshotLines([
      line("American Express® Platinum Card ••••61002", 40), line("5Okt", 120), line("SPAR", 180), line("€ 6,56", 180, 500),
    ], "2026-10-06.png");
    expect(result.source).toBe("Amex");
    expect(result.rows[0]).toMatchObject({ date: "2026-10-05", amount: -6.56 });
    expect(result.amexScreenshot?.card).toBe("61002");
  });
  it("deduplicates grouped overlap and subsequent PDF rows without changing merchant identity", () => {
    const rows = [line("3 Okt", 120), line("AIRBNB * ABC123", 180), line("LONDON", 210), line("€ 126,00", 195, 500)];
    const result = groupedParse(rows);
    expect(prepareStatementPreview([result, result], []).rows).toHaveLength(1);
    const pdf = parseAmexText(["06.10.2026\nUmsatz vom Buchung am Betrag in EUR\nNeue Belastungen für HERRN JANNIS BRUEHL\n03.10 03.10 AIRBNB * ABC123 LONDON 126,00"]);
    expect(deduplicateStatements(pdf.rows, result.rows).rows).toEqual([]);
  });
});

describe("Amex app screenshot facts", () => {
  it("stores the current total separately from bookings and repairs a duplicate-only import", () => {
    const screenshot = parseAmexScreenshotLines([
      line("11.09.2026 - Aktuell", 50), line("Kartennummer -12345", 80),
      line("€ 1.619,19", 150), line("45 Transaktionen", 180),
      ...booking("IKEA", 280),
    ], "WhatsApp Image 2026-10-05 at 09.43.39.jpeg");
    expect(screenshot.amexBalanceSnapshots).toEqual([{ periodStart: "2026-09-11", date: "2026-10-05", balance: 1619.19 }]);
    expect(screenshot.rows).toHaveLength(1);
    const seed = createSeed();
    seed.transactions = screenshot.rows;
    const prepared = prepareStatementImport([screenshot, screenshot], seed);
    expect(prepared.automatic).toEqual([]);
    expect(prepared.duplicates).toBe(2);
    const saved = commitStatementImport(seed, [], [], prepared.metadata).state;
    expect(saved.transactions).toHaveLength(1);
    expect(saved.amexBalanceSnapshots).toEqual(screenshot.amexBalanceSnapshots);
    const again = prepareStatementImport([screenshot], saved);
    expect(commitStatementImport(saved, [], [], again.metadata).state.amexBalanceSnapshots).toEqual(saved.amexBalanceSnapshots);
  });

  it.each([
    { text: "€ 161919", confidence: 95 },
    { text: "€ 1.619,19", confidence: 20 },
    { text: "€ 1.619,19", confidence: 95, uncertain: true },
  ])("never uses an uncertain header total as a saved balance ($text, $confidence)", (total) => {
    const result = parse([ { ...line(total.text, 150), ...total }, line("45 Transaktionen", 180), ...booking("IKEA", 280) ]);
    expect(result.amexBalanceSnapshots).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.issues[0].message).toContain("Amex-Saldo");
  });

  it.each([["€ 12,34", -12.34], ["-€ 12,34", 12.34], ["−€ 1.234,56", 1234.56], ["€ -12,34", 12.34]])("reads ledger sign for %s", (text, expected) => {
    expect(screenshotAmount(text)).toBe(expected);
  });
  it.each(["€ 1234", "€ 1,2", "€ I2,34", "€ 1.23,45", "12,34", "€ --12,34"])("does not invent missing cents for %s", (text) => {
    expect(screenshotAmount(text)).toBeNull();
  });
  it("validates German month names and real dates", () => {
    expect(screenshotDate("4 Okt 2026")).toBe("2026-10-04");
    expect(screenshotDate("3 März 2026")).toBe("2026-03-03");
    expect(screenshotDate("29 Feb 2026")).toBeNull();
    expect(screenshotDate("4 Okt 2O26")).toBeNull();
  });
  it.each(["•", "·", "-", "–", "+", "*"])("separates the date and named additional cardholder (%s)", (separator) => {
    const result = parse(booking("McDonalds Filiale", 140, `20 Sep 2026 ${separator} RAPHAEL PIBER`, "€ 3,30"));
    expect(result.issues).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      description: "McDonalds Filiale", date: "2026-09-20", pocket: "AMEX Raphael", amount: -3.3,
    });
    expect(result.rows[0].rawDetails).toContain(`20 Sep 2026 ${separator} RAPHAEL PIBER`);
  });
  it("does not silently assign an unknown cardholder to the primary card", () => {
    const result = parse(booking("SPAR", 140, "20 Sep 2026 • ANDERE PERSON"));
    expect(result.rows).toEqual([]);
    expect(result.issues[0].draft).toMatchObject({ date: "2026-09-20", pocket: "AMEX ungeklärt" });
  });
  it("skips card repayments with an unreadable date but keeps genuine credits and expenses", () => {
    const result = parse([
      line("ZAHLUNG/ÜBERWEISUNG", 140), line("ERHALTEN BESTEN DANK", 170),
      line("WAS AS", 200), line("-€ 1.234,56", 155, 500),
      ...booking("Entertainment Gutschrift", 300, "15 Sep 2026", "-€ 4,00"),
      ...booking("ZAHLUNG/ÜBERWEISUNG ERHALTEN", 410, "14 Sep 2026", "€ 3,00"),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.rows.map((row) => row.amount)).toEqual([4, -3]);
  });
  it("ignores chrome/totals and retains wrapped merchants, pending charges, order and credit signs", () => {
    const result = parse([
      line("Kürzliche Transaktionen", 110), line("€ 9.876,54", 150), line("87 Transaktionen", 180),
      line("Sortieren nach: Aktuellste zuerst", 220),
      line("PAYPAL *PLAYSTATION", 280), line("02000000000", 310), line("4 Okt 2026", 340), line("€ 9,99", 310, 500),
      line("Vorgemerkt", 385),
      ...booking("SPAR", 420),
      ...booking("Entertainment Gutschrift", 530, "3 Okt 2026", "-€ 8,00"),
      ...booking("AMZN MKTP DE AMZN.COM/BILL", 640, "3 Okt 2026", "-€ 22,00"),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.rows.map((row) => row.amount)).toEqual([-9.99, -12.34, 8, 22]);
    expect(result.rows[0].description).toBe("PAYPAL *PLAYSTATION 02000000000");
    expect(result.rows.every((row) => row.bank === "Amex" && row.pocket === "Amex")).toBe(true);
    expect(result.rows).toEqual(classifyStatementRows(result.rows));
  });
  it("keeps incomplete/cropped rows as editable review drafts, never invents a date or amount", () => {
    const result = parse([
      line("SPAR", 140), line("4 Okt 2026", 170), line("€ 1234", 155, 500),
      line("BIPA", 260), line("€ 5,55", 275, 500),
      line("DM DROGERIE", 380), line("32 Okt 2026", 410), line("€ 8,99", 395, 500),
    ]);
    expect(result.rows).toEqual([]);
    expect(result.issues.map((issue) => [issue.draft?.description, issue.draft?.date, issue.draft?.amount])).toEqual([
      ["SPAR", "2026-10-04", null], ["BIPA", "", -5.55], ["DM DROGERIE", "", -8.99],
    ]);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      "Amex-Screenshot: Betrag prüfen.",
      "Amex-Screenshot: Datum fehlt – bitte ergänzen.",
      "Amex-Screenshot: Datum fehlt – bitte ergänzen.",
    ]);
    const state = createSeed();
    const prepared = prepareStatementImport([result], state);
    expect(prepared.automatic).toEqual([]);
    expect(prepared.review).toHaveLength(3);
    const saved = queueLedgerReview(commitStatementImport(state, [], [], prepared.metadata).state);
    expect(saved.transactions).toEqual([]);
    expect(saved.reviewQueue).toHaveLength(3);
    expect(appStateSchema.safeParse(saved).success).toBe(true);
    expect(prepareStatementImport([result], saved).review).toEqual([]);
    const draft = result.issues[0].draft!;
    const corrected = transactionSchema.parse({ ...draft, amount: -12.34, category: "Lebensmittel", categoryOverride: true });
    const accepted = commitStatementImport(saved, [corrected]).state;
    expect(accepted.transactions).toHaveLength(1);
    expect(accepted.reviewQueue).toHaveLength(2);
  });
  it("never imports a non-Amex image based on arbitrary amounts", () => {
    expect(parseAmexScreenshotLines(booking("SPAR", 140)).source).toBeNull();
  });
  it("holds genuinely low-confidence names for confirmation even when they resemble a known merchant", () => {
    const source = booking("SPAR", 140);
    source[0].confidence = 12;
    const result = parse(source);
    expect(result.rows).toEqual([]);
    expect(result.issues[0].draft?.rawDetails).toContain("OCR-Händler unklar");
    const seed = createSeed();
    const prepared = prepareStatementImport([result], seed);
    let saved = queueLedgerReview(commitStatementImport(seed, prepared.automatic, [], prepared.metadata).state);
    expect(saved.transactions).toEqual([]);
    expect(saved.reviewQueue).toHaveLength(1);
    const draft = result.issues[0].draft!;
    saved = queueLedgerReview(commitStatementImport(saved, [transactionSchema.parse({
      ...draft, category: "Lebensmittel", categoryOverride: true, manualCategory: true, reviewed: true,
    })]).state);
    expect(saved.transactions).toHaveLength(1);
    expect(saved.reviewQueue).toEqual([]);
  });
  it("does not confuse low-confidence phone, order or website continuations with the merchant name", () => {
    const result = parse([
      line("AMAZON.DE*ABC123", 140),
      { ...line("02000000000", 170), confidence: 0 },
      { ...line("ABC123XYZ", 200), confidence: 0 },
      { ...line("WWW. AMAZON.DE", 230), confidence: 0 },
      line("4 Okt 2026", 260), line("€ 12,34", 185, 500),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(1);
  });
  it("routes valid PNG/JPEG/WebP extensions to image validation and rejects renamed non-images", async () => {
    for (const name of ["receipt.png", "receipt.JPG", "receipt.jpeg", "receipt.webp"])
      await expect(parseStatementFile({ name, size: 4, arrayBuffer: async () => new ArrayBuffer(4) })).rejects.toThrow("Ungültiges Screenshot");
  });
});

describe("overlapping screenshots and later Amex statements", () => {
  it("deduplicates scroll overlap but preserves genuinely different rows and same-file occurrences", () => {
    const one = parse([...booking("SPAR", 140), ...booking("BIPA", 260)]);
    const two = parse([...booking("BIPA", 140), ...booking("IKEA", 260), ...booking("IKEA", 380)]);
    expect(prepareStatementPreview([one, two], []).rows.map((row) => row.description)).toEqual(["SPAR", "BIPA", "IKEA", "IKEA"]);
    const saved = prepareStatementPreview([one, two], []).rows;
    expect(prepareStatementPreview([one, two], saved).rows).toEqual([]);
  });
  it.each([true, false])("matches PDF and screenshot regardless of import order (%s)", (pdfFirst) => {
    const screenshot = parse(booking("AMAZON.DE*ABC123 WWW. AMAZON.DE", 140));
    const pdf = parseAmexText(["05.10.2026\nUmsatz vom Buchung am Betrag in EUR\nNeue Belastungen für HERRN JANNIS BRUEHL\n04.10 04.10 AMAZON.DE*ABC123 WWW.AMAZON.DE 12,34"]);
    const first = pdfFirst ? pdf : screenshot;
    const second = pdfFirst ? screenshot : pdf;
    expect(deduplicateStatements(second.rows, first.rows).rows).toEqual([]);
    expect(deduplicateStatements([{ ...second.rows[0], amount: -99 }], first.rows).rows).toHaveLength(1);
    expect(deduplicateStatements([{ ...second.rows[0], description: "Different merchant" }], first.rows).rows).toHaveLength(1);
  });
  it("keeps separate PDF holders distinct when there is no screenshot", () => {
    const row = parse(booking("SPAR", 140)).rows[0];
    expect(deduplicateStatements([{ ...row, pocket: "AMEX Raphael", rawDetails: [] }],
      [{ ...row, pocket: "AMEX Jannis", rawDetails: [] }]).rows).toHaveLength(1);
  });
  it("matches OCR-prone order codes but keeps two equal purchases from the same screenshot", () => {
    const screenshot = parse([
      ...booking("AIRBNB * ABC123 LONDON", 140), ...booking("AIRBNB * DEF456 LONDON", 260),
    ]);
    expect(deduplicateStatements(screenshot.rows, []).rows).toHaveLength(2);
    const pdf = parseAmexText(["05.10.2026\nUmsatz vom Buchung am Betrag in EUR\nNeue Belastungen für HERRN JANNIS BRUEHL\n04.10 04.10 AIRBNB * ABCI23 LONDON 12,34\n04.10 04.10 AIRBNB * DEF456 LONDON 12,34"]);
    expect(deduplicateStatements(pdf.rows, screenshot.rows).rows).toEqual([]);
    expect(deduplicateStatements(pdf.rows, screenshot.rows.slice(0, 1)).rows).toHaveLength(1);
  });
  it.each(["AMAZON.DE", "AIRBNB"])("keeps distinct equal-price %s orders across different screenshots", (merchant) => {
    const one = parse(booking(`${merchant}*ABC123 CITY`, 140));
    const two = parse(booking(`${merchant}*DEF456 CITY`, 140));
    expect(prepareStatementPreview([one, two], []).rows).toHaveLength(2);
    expect(deduplicateStatements(two.rows, one.rows).rows).toHaveLength(1);
    expect(deduplicateStatements(one.rows, one.rows).rows).toEqual([]);
  });
  it("preserves PDF-only identities when different equal-price order codes are reimported separately", () => {
    const header = "05.10.2026\nUmsatz vom Buchung am Betrag in EUR\nNeue Belastungen für HERRN JANNIS BRUEHL\n";
    const first = "04.10 04.10 AMAZON.DE*ABC123 CITY 12,34";
    const second = "04.10 04.10 AMAZON.DE*DEF456 CITY 12,34";
    const together = parseAmexText([`${header}${first}\n${second}`]);
    expect(together.rows.map((row) => row.occurrence)).toEqual([1, 1]);
    expect(deduplicateStatements(parseAmexText([`${header}${second}`]).rows, together.rows).rows).toEqual([]);
  });
  it.each([true, false])("never matches primary-card screenshots to Raphael's PDF (%s)", (pdfFirst) => {
    const screenshot = parse(booking("SPAR", 140));
    const partner = parseAmexText(["05.10.2026\nUmsatz vom Buchung am Betrag in EUR\nNeue Belastungen für HERRN RAPHAEL PIBER\n04.10 04.10 SPAR 12,34"]);
    const first = pdfFirst ? partner : screenshot;
    const second = pdfFirst ? screenshot : partner;
    expect(deduplicateStatements(second.rows, first.rows).rows).toHaveLength(1);
  });
  it.each([true, false])("deduplicates additional-card screenshots against that holder's PDF (%s)", (pdfFirst) => {
    const screenshot = parse(booking("McDonalds Filiale", 140, "20 Sep 2026 • RAPHAEL PIBER", "€ 3,30"));
    const pdf = parseAmexText(["05.10.2026\nUmsatz vom Buchung am Betrag in EUR\nNeue Belastungen für HERRN RAPHAEL PIBER\n20.09 20.09 McDonalds Filiale 3,30"]);
    const first = pdfFirst ? pdf : screenshot;
    const second = pdfFirst ? screenshot : pdf;
    expect(deduplicateStatements(second.rows, first.rows).rows).toEqual([]);
    const primary = parse(booking("McDonalds Filiale", 140, "20 Sep 2026", "€ 3,30"));
    expect(prepareStatementPreview([primary, screenshot, screenshot], []).rows).toHaveLength(2);
    expect(deduplicateStatements(primary.rows, first.rows).rows).toHaveLength(1);
  });
  it("does not rebook screenshot subscriptions already represented by PDF receipts", () => {
    const parsed = parse(booking("PAYPAL *SPOTIFY", 140));
    const bookingRow = { ...parsed.rows[0], pocket: "AMEX Jannis", rawDetails: [] };
    const state = createSeed();
    state.fixedReceipts = [{ key: "existing", date: bookingRow.date, amount: bookingRow.amount, category: bookingRow.category, booking: bookingRow }];
    const result = prepareStatementImport([parsed], state);
    expect(result.automatic).toEqual([]);
    expect(result.review).toEqual([]);
    expect(result.duplicates).toBe(1);
  });
});

describe("local-only OCR safety", () => {
  it("pins worker, engine and language URLs to the application origin", () => {
    expect([localOcrOptions.workerPath, localOcrOptions.corePath, localOcrOptions.langPath].every((url) => url.startsWith("/api/ocr"))).toBe(true);
    expect(localOcrOptions.workerBlobURL).toBe(false);
    expect(localOcrOptions.cacheMethod).toBe("none");
  });
  it("flags disagreements between otherwise valid OCR amount readings", async () => {
    const lines = [...header, ...booking("SPAR", 140)];
    const recognize = vi.fn().mockResolvedValueOnce({ data: { blocks: [{ paragraphs: [{ lines }] }] } })
      .mockResolvedValueOnce({ data: { text: "€ 72,34", confidence: 95 } });
    const worker = { setParameters: vi.fn(), reinitialize: vi.fn(), recognize } as unknown as Worker;
    const result = parseAmexScreenshotLines(await recognizeAmexScreenshot(worker, "local-image"));
    expect(result.rows).toEqual([]);
    expect(result.issues[0].draft?.amount).toBeNull();
  });
  it.each([["€ 9,68", -9.68], ["€ 8,68", null]] as const)(
    "retries low-confidence dark-mode amounts without ignoring disagreement (%s)", async (retry, expected) => {
      const rows = booking("SPAR", 140, "15 Sep 2026", "€ 9,68");
      rows[2].confidence = 0;
      const recognize = vi.fn().mockResolvedValueOnce({ data: { blocks: [{ paragraphs: [{ lines: [...header, ...rows] }] }] } })
        .mockResolvedValueOnce({ data: { text: "SE)", confidence: 15 } })
        .mockResolvedValueOnce({ data: { text: retry, confidence: 86 } });
      const setParameters = vi.fn();
      const worker = { setParameters, reinitialize: vi.fn(), recognize } as unknown as Worker;
      const result = parseAmexScreenshotLines(await recognizeAmexScreenshot(worker, "local-image"));
      expect(setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: "13" });
      expect(setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: "7" });
      if (expected === null) {
        expect(result.rows).toEqual([]);
        expect(result.issues[0].draft?.amount).toBeNull();
      } else {
        expect(result.issues).toEqual([]);
        expect(result.rows[0].amount).toBe(expected);
      }
    },
  );
  it("retains the cardholder suffix when a date retry only reads the date", async () => {
    const rows = booking("SPAR", 140, "20 Sep 2026 • RAPHAEL PIBER", "€ 3,30");
    rows[1].confidence = 60;
    const recognize = vi.fn().mockResolvedValueOnce({ data: { blocks: [{ paragraphs: [{ lines: [...header, ...rows] }] }] } })
      .mockResolvedValueOnce({ data: { text: "20 Sep 2026", confidence: 95 } })
      .mockResolvedValueOnce({ data: { text: "€ 3,30", confidence: 95 } });
    const worker = { setParameters: vi.fn(), reinitialize: vi.fn(), recognize } as unknown as Worker;
    const result = parseAmexScreenshotLines(await recognizeAmexScreenshot(worker, "local-image"));
    expect(result.issues).toEqual([]);
    expect(result.rows[0]).toMatchObject({ date: "2026-09-20", pocket: "AMEX Raphael", amount: -3.3 });
  });
});
