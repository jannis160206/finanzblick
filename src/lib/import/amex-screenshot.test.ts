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

describe("Amex app screenshot facts", () => {
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
});
