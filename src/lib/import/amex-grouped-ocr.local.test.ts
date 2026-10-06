import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { createWorker, OEM, type Worker } from "tesseract.js";
import { GET } from "@/app/api/ocr/[asset]/route";
import { createSeed } from "@/lib/seed";
import { localOcrLanguages, recognizeAmexScreenshot } from "./amex-ocr";
import { parseAmexScreenshotLines, type ScreenshotLine } from "./amex-screenshot";
import { prepareStatementPreview } from "./statements";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "./review";

const directory = process.env.AMEX_GROUPED_SCREENSHOT_DIR;
async function withLocalWorker(run: (worker: Worker) => Promise<void>) {
  const resources = createServer(async (request, response) => {
    try {
      const asset = request.url?.split("/").at(-1) ?? "";
      const result = await GET(new Request(`http://localhost${request.url}`), { params: Promise.resolve({ asset }) });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(new Uint8Array(await result.arrayBuffer()));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => resources.listen(0, "127.0.0.1", resolve));
  const address = resources.address();
  if (!address || typeof address === "string") throw new Error("Local OCR resources not listening");
  let worker: Worker | undefined;
  try {
    worker = await createWorker(localOcrLanguages, OEM.LSTM_ONLY, {
      langPath: `http://127.0.0.1:${address.port}/api/ocr`, cacheMethod: "none",
    });
    await run(worker);
  } finally {
    await worker?.terminate();
    await new Promise<void>((resolve, reject) => resources.close((error) => error ? reject(error) : resolve()));
  }
}

it.skipIf(!directory || !existsSync(directory))("recognizes all eight private grouped scrolls using local OCR only", async () => {
  await withLocalWorker(async (worker) => {
    const files = readdirSync(directory!).filter((file) => /\.jpe?g$/i.test(file)).sort();
    expect(files).toHaveLength(8);
    const results = [];
    const captures: { file: string; lines: ScreenshotLine[] }[] = [];
    for (const file of files) {
      const lines = await recognizeAmexScreenshot(worker, readFileSync(path.join(directory!, file)));
      captures.push({ file, lines });
      const result = parseAmexScreenshotLines(lines, file);
      if (process.env.AMEX_GROUPED_OCR_DEBUG) {
        console.log(file, JSON.stringify({ lines: lines.filter((line) => line.uncertain || line.text.length < 12)
          .map((line) => [line.text, line.confidence, line.bbox.x0, line.bbox.y0, line.uncertain]),
          rows: result.rows.map((row) => [row.date, row.description, row.amount, row.pocket, row.amexStatus]),
          issues: result.issues.map((issue) => [issue.message, issue.draft?.date, issue.draft?.description, issue.draft?.amount]),
          metadata: result.amexScreenshot }));
      }
      expect(result.source).toBe("Amex");
      expect(result.amexScreenshot).toMatchObject({ layout: "grouped", capturedAt: "2026-10-06", balanceIncludesPending: false });
      expect(result.amexBalanceSnapshots).toBeUndefined();
      const ids = [...result.rows.map((row) => row.id), ...result.issues.flatMap((issue) => issue.draft ? [issue.draft.id] : [])];
      expect(result.amexScreenshot?.bookingOrder).toHaveLength(ids.length);
      expect(new Set(result.amexScreenshot?.bookingOrder)).toEqual(new Set(ids));
      results.push(result);
    }
    const preview = prepareStatementPreview(results, []);
    if (process.env.AMEX_GROUPED_OCR_DEBUG) console.log("grouped summary", JSON.stringify({
      safe: results.reduce((count, result) => count + result.rows.length, 0),
      unique: preview.rows.length, duplicates: preview.duplicates,
      reviews: results.flatMap((result) => result.issues).length,
      signedTotal: Math.round(preview.rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100,
      pendingTotal: Math.round(preview.rows.filter((row) => row.amexStatus === "pending").reduce((sum, row) => sum - row.amount, 0) * 100) / 100,
    }));
    expect(results.map((result) => result.rows.length)).toEqual([9, 7, 7, 7, 5, 5, 5, 7]);
    expect(results.map((result) => result.rows.length + result.skipped)).toEqual([9, 7, 8, 7, 7, 5, 8, 8]);
    expect(preview.rows).toHaveLength(45);
    expect(preview.rows.filter((row) => row.pocket === "AMEX Raphael")).toHaveLength(2);
    expect(preview.duplicates).toBe(7);
    const issues = results.flatMap((result) => result.issues);
    expect(issues).toHaveLength(6);
    expect(issues.filter((issue) => issue.draft?.date === "")).toHaveLength(3);
    expect(issues.filter((issue) => issue.draft?.amount === null)).toHaveLength(3);
    const pending = preview.rows.filter((row) => row.amexStatus === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ date: "2026-10-05", amount: -6.56 });
    expect(results.filter((result) => result.amexScreenshot?.balance !== undefined).map((result) => result.amexScreenshot?.balance))
      .toEqual([1489.69]);
    expect(preview.rows.some((row) => /IKEA/i.test(row.description) && row.amount === -207.82)).toBe(true);
    expect(preview.rows.some((row) => /AIRBNB/i.test(row.description) && row.amount === -126)).toBe(true);
    expect(preview.rows.some((row) => /TAPESO/i.test(row.description) && row.amount === -164.9)).toBe(true);
    expect(preview.rows.every((row) => row.rawDetails?.[0] === "Amex-Screenshot" &&
      row.amexSource === "screenshot" && row.amexCapturedAt === "2026-10-06")).toBe(true);
    expect(prepareStatementPreview(results, preview.rows).rows).toEqual([]);
    expect(preview.rows.some((row) => /Gesamtsaldo|Fällige Zahlung|Membership Rewards|Startseite|Konto|ZAHLUNG\/ÜBERWEISUNG/i.test(row.description)))
      .toBe(false);
    const seed = createSeed();
    const prepared = prepareStatementImport(results, seed);
    expect(prepared.metadata.amexBalanceSnapshots).toEqual([{
      periodStart: "2026-09-11", date: "2026-10-06", balance: 1489.69, pendingBalance: 6.56,
    }]);
    const saved = queueLedgerReview(commitStatementImport(seed, prepared.automatic, [], prepared.metadata).state);
    const bookingReviews = saved.reviewQueue?.filter((item) => item.kind === "booking" &&
      /^Amex-Screenshot:/.test(item.message)) ?? [];
    if (process.env.AMEX_GROUPED_OCR_DEBUG) console.log("grouped prepared", JSON.stringify({
      automatic: prepared.automatic.length, bookingReviews: bookingReviews.length,
      totalReviews: saved.reviewQueue?.length,
      drafts: bookingReviews.map((item) => [item.draft.date, item.draft.amount, item.message]),
      snapshot: prepared.metadata.amexBalanceSnapshots,
    }));
    expect(saved.amexBalanceSnapshots).toEqual(prepared.metadata.amexBalanceSnapshots);
    expect(saved.amexScreenshotValidation).toEqual({ version: 1, date: "2026-10-06" });
    expect(bookingReviews).toHaveLength(1);
    expect(bookingReviews[0].draft).toMatchObject({ date: "2026-09-15", amount: null, pocket: "Amex" });
    expect(bookingReviews[0].draft.description).toMatch(/^Spar\b/i);
    expect(bookingReviews[0].draft.rawDetails?.some((text) => /€\s*9,68\b/.test(text))).toBe(true);
    expect(saved.reviewQueue).toHaveLength(5);
    const categoryReviews = saved.reviewQueue?.filter((item) => item.kind === "booking" &&
      !/^Amex-Screenshot:/.test(item.message)) ?? [];
    expect(categoryReviews).toHaveLength(4);
    expect(categoryReviews.every((item) => item.draft.date && item.draft.amount !== null)).toBe(true);
    expect(preview.rows.length + bookingReviews.length).toBe(46);
    const repeated = prepareStatementImport(captures.map(({ file, lines }) => parseAmexScreenshotLines(lines, file)), saved);
    expect(repeated.automatic).toEqual([]);
    const repeatedState = queueLedgerReview(commitStatementImport(saved, [], [], repeated.metadata).state);
    expect(repeatedState.amexBalanceSnapshots).toEqual(saved.amexBalanceSnapshots);
    expect(repeatedState.amexScreenshotValidation).toEqual(saved.amexScreenshotValidation);
    expect(repeatedState.reviewQueue).toHaveLength(5);
    expect(repeatedState.reviewQueue?.filter((item) => item.kind === "booking" && /^Amex-Screenshot:/.test(item.message)))
      .toHaveLength(1);
  });
}, 180_000);
