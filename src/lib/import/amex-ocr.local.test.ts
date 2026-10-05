import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { createWorker, OEM, type Worker } from "tesseract.js";
import { localOcrLanguages, recognizeAmexScreenshot } from "./amex-ocr";
import { parseAmexScreenshotLines } from "./amex-screenshot";
import { prepareStatementPreview } from "./statements";
import { calculateDashboard, classifyStatementRows } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { initializePlannedOneOffs } from "@/lib/planned-one-offs";
import { synchronizePlan } from "@/lib/planning";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "./review";
import { parseAmexText } from "./amex-pdf";
import { GET } from "@/app/api/ocr/[asset]/route";
import { transactionSchema } from "@/lib/types";

const exampleDirectory = process.env.AMEX_SCREENSHOT_DIR ?? path.join(process.cwd(), "import-example");
const example = path.join(exampleDirectory, "WhatsApp Image 2026-10-05 at 09.43.39.jpeg");
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
it.skipIf(!existsSync(example))("recognizes both private local examples without network OCR", async () => {
  await withLocalWorker(async (worker) => {
    const results = [];
    for (const file of [example, example.replace(".jpeg", " (1).jpeg")]) {
      const parsed = parseAmexScreenshotLines(await recognizeAmexScreenshot(worker, readFileSync(file)), path.basename(file));
      expect(parsed.issues).toEqual([]);
      expect(parsed.rows.every((row) => row.bank === "Amex" && row.pocket === "Amex")).toBe(true);
      expect(parsed.rows).toEqual(classifyStatementRows(parsed.rows));
      results.push(parsed);
    }
    const upper = results.find((result) => result.rows.some((row) => row.description.startsWith("AIRBNB")))!;
    const lower = results.find((result) => result.rows.some((row) => row.description.includes("PLAYSTATION")))!;
    expect(upper.amexBalanceSnapshots).toEqual([{ periodStart: "2026-09-11", date: "2026-10-05", balance: 1619.19 }]);
    expect(upper.rows.map((row) => row.amount)).toEqual([-126, -15.43, -28.93, -6.97, -207.82, -164.9, -12.3, -90.9]);
    expect(lower.rows.map((row) => row.amount)).toEqual([-15.99, -2.48, -32.64, -55.38, 11, -19.98, -19.95, -12.99, -25.71, 112.7]);
    expect(upper.rows.map((row) => row.date)).toEqual(["2026-10-03", "2026-10-03", ...Array(6).fill("2026-10-02")]);
    expect(lower.rows.map((row) => row.date)).toEqual(["2026-10-02", "2026-10-02", ...Array(4).fill("2026-10-01"), "2026-09-30", "2026-09-29", "2026-09-28", "2026-09-28"]);
    expect(prepareStatementPreview([...results, ...results], []).rows).toHaveLength(18);
    expect(prepareStatementPreview(results, results.flatMap((result) => result.rows)).rows).toEqual([]);
    const laterPdf = parseAmexText(["05.10.2026\nUmsatz vom Buchung am Betrag in EUR\nNeue Belastungen für HERRN JANNIS BRUEHL\n03.10 03.10 AIRBNB * HMKFJJJ9QC LONDON 126,00"]);
    expect(prepareStatementPreview([laterPdf], upper.rows).rows).toEqual([]);
    const seed = createSeed();
    seed.settings.asOf = "2026-10-05";
    let state = initializePlannedOneOffs(seed);
    const prepared = prepareStatementImport(results, state);
    expect(prepared.review).toEqual([]);
    const merchant = (description: string) => description.replace(/\b(AMAZON\.DE|AIRBNB)\s*\*\s*[A-Z0-9]+/g, "$1")
      .replace(/\.\s+/g, ".").replace(/\s+/g, " ").trim();
    expect(prepared.automatic.map((row) => merchant(row.description))).toEqual([
      "AIRBNB LONDON", "MUELLER 5635 VILLACH", "AMAZON.DE AMAZON.DE", "IKEA KLAGENFURT 9020 IK -", "IKEA KLAGENFURT 9020 IK -",
      "MOLLIE=TAPESO DRACHTEN", "McDonalds 42 McDonalds Villach", "PACE PAY KARLSRUHE", "PAYPAL *PLAYSTATION 02039017000",
      "Spar Fil.6345 Spar Fil St.Kanzian", "AMAZON.DE AMAZON.DE", "AMAZON.DE WWW.AMAZON.DE",
      "Entertainment Gutschrift", "UBER TRIP HTTPS://HELP.UB", "UBER TRIP HTTPS://HELP.UB", "PAYPAL *SPOTIFY*P477531 07517591951",
      "AMAZON.DE WWW.AMAZON.DE", "AMZN MKTP DE AMZN.COM/BILL",
    ]);
    state = synchronizePlan(queueLedgerReview(commitStatementImport(state, prepared.automatic, [], prepared.metadata).state));
    expect(state.reviewQueue).toEqual([]);
    expect(state.transactions.filter((row) => row.sharedWithRaphael).map((row) => row.amount)).toEqual([-126, -207.82, -164.9]);
    expect(state.transactions).toHaveLength(18);
    expect(state.amexBalanceSnapshots).toEqual(upper.amexBalanceSnapshots);
    expect(calculateDashboard(state).amex).toMatchObject({ outstanding: 1619.19, ownOutstanding: 1369.83 });
    expect(state.plannedOneOffs?.some((item) => item.name === "Teppich")).toBe(false);
    expect(prepareStatementImport(results, state)).toMatchObject({ automatic: [], review: [], duplicates: 18 });
  });
}, 120_000);

it.skipIf(!process.env.AMEX_SCREENSHOT_DIR)("recognizes the complete supplied scroll without guessing its cropped date", async () => {
  await withLocalWorker(async (worker) => {
    const files = readdirSync(exampleDirectory).filter((file) => /^WhatsApp Image.*\.jpe?g$/i.test(file)).sort();
    expect(files).toHaveLength(5);
    const results = [];
    for (const file of files) {
      results.push(parseAmexScreenshotLines(
        await recognizeAmexScreenshot(worker, readFileSync(path.join(exampleDirectory, file))), file,
      ));
    }
    const issues = results.flatMap((result) => result.issues);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: "WhatsApp Image 2026-10-05 at 09.43.40.jpeg", line: 10,
      message: "Amex-Screenshot: Datum fehlt – bitte ergänzen.",
    });
    expect(issues[0].draft).toMatchObject({ date: "", bank: "Amex", pocket: "Amex" });
    expect(issues[0].draft?.amount).toBeLessThan(0);
    expect(issues[0].draft?.description).toMatch(/^AMZN MKTP/);
    const preview = prepareStatementPreview(results, []);
    expect(preview.rows).toHaveLength(43);
    expect(preview.duplicates).toBe(3);
    expect(preview.rows.filter((row) => row.pocket === "AMEX Raphael")).toHaveLength(2);
    expect(preview.rows.some((row) => /ZAHLUNG\/ÜBERWEISUNG/i.test(row.description))).toBe(false);
    expect(prepareStatementPreview(results, preview.rows).rows).toEqual([]);
    const seed = createSeed();
    const prepared = prepareStatementImport(results, seed);
    const saved = queueLedgerReview(commitStatementImport(seed, prepared.automatic, [], prepared.metadata).state);
    expect(saved.reviewQueue?.filter((item) => item.kind === "booking" && !item.draft.date)).toHaveLength(1);
    const again = prepareStatementImport(results, saved);
    expect(again.automatic).toEqual([]);
    expect(again.review).toEqual([]);
    // This date is a synthetic user confirmation, never an OCR inference.
    const corrected = transactionSchema.parse({ ...issues[0].draft, date: "2026-09-21",
      category: "Shopping", categoryOverride: true, manualCategory: true, reviewed: true });
    const confirmed = queueLedgerReview(commitStatementImport(saved, [corrected]).state);
    expect(confirmed.importStatus?.issues).toEqual([]);
    expect(confirmed.reviewQueue?.some((item) => item.kind === "booking" && !item.draft.date)).toBe(false);
    const redropped = prepareStatementImport(results, confirmed);
    expect(redropped.automatic).toEqual([]);
    expect(redropped.review).toEqual([]);
    expect(redropped.issues).toEqual([]);
  });
}, 120_000);
