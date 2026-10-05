import { lstat, readFile, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createWorker, OEM, type Worker } from "tesseract.js";
import type { AmexBalanceRecovery } from "./amex-balance-recovery";
import { recognizeAmexScreenshot } from "./amex-ocr";
import { parseAmexScreenshotLines } from "./amex-screenshot";
import { amexBookingKey } from "./identity";
import { assertImportSize } from "./limits";
import { parseStatementDate } from "./statements";

const screenshotName = /^WhatsApp Image (\d{4}-\d{2}-\d{2}) at \d{2}\.\d{2}\.\d{2}(?: \(\d+\))?\.(?:jpe?g|png|webp)$/i;
type Metadata = Stats;
type CacheEntry = { metadata: string; recovery: AmexBalanceRecovery | null };
const cache = new Map<string, CacheEntry>();
let pending: Promise<AmexBalanceRecovery[]> | undefined;

const fingerprint = (metadata: Metadata) =>
  [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(":");

function isImage(bytes: Buffer) {
  return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
}

async function createLocalWorker() {
  const workers = new Map<string, Worker>();
  const select = async (language: string) => {
    if (language !== "deu" && language !== "eng")
      throw new Error("Unzulässige lokale OCR-Sprache.");
    let worker = workers.get(language);
    if (!worker) {
      const langPath = path.join(process.cwd(), "node_modules", "@tesseract.js-data", language, "4.0.0_best_int");
      // Fail before spawning a worker when an installed model is missing or corrupt.
      gunzipSync(await readFile(path.join(langPath, `${language}.traineddata.gz`)));
      worker = await new Promise<Worker>((resolve, reject) => {
        // Tesseract otherwise leaves createWorker pending on language-load errors.
        void createWorker(language, OEM.LSTM_ONLY, {
          langPath, cacheMethod: "none", errorHandler: reject,
        }).then(resolve, reject);
      });
      workers.set(language, worker);
    }
    return worker;
  };
  let current = await select("deu");
  // This Tesseract version cannot initialize Lang[] bytes safely. Separate local
  // models also keep every reinitialize call on an already-loaded language.
  return {
    ...current,
    reinitialize: async (language = "eng", oem, config, jobId) => {
      if (typeof language !== "string") throw new Error("Unzulässige lokale OCR-Sprache.");
      current = await select(language);
      return current.reinitialize(language, oem, config, jobId);
    },
    setParameters: (...args) => current.setParameters(...args),
    recognize: (...args) => current.recognize(...args),
    terminate: async () => {
      const results = await Promise.allSettled([...workers.values()].map((worker) => worker.terminate()));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      const result = results[0];
      if (result.status === "rejected") throw result.reason;
      return result.value;
    },
  } satisfies Worker;
}

async function recover(): Promise<AmexBalanceRecovery[]> {
  const directory = path.join(process.cwd(), "import-example");
  let directoryMetadata: Metadata;
  try {
    directoryMetadata = await lstat(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      cache.clear();
      return [];
    }
    throw error;
  }
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink())
    throw new Error("Der lokale Screenshot-Ordner muss ein regulärer Ordner sein.");
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => screenshotName.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (files.length > 20) throw new Error("Zu viele lokale Amex-Screenshots (höchstens 20).");
  const paths = new Set(files.map((file) => path.join(directory, file.name)));
  for (const cachedPath of cache.keys()) if (!paths.has(cachedPath)) cache.delete(cachedPath);

  let worker: Worker | undefined;
  const recoveries: AmexBalanceRecovery[] = [];
  const updates = new Map<string, CacheEntry>();
  try {
    for (const entry of files) {
      const captureDate = screenshotName.exec(entry.name)![1];
      if (!parseStatementDate(captureDate))
        throw new Error("Das Aufnahmedatum des lokalen Amex-Screenshots ist ungültig.");
      const filePath = path.join(directory, entry.name);
      const before = await lstat(filePath);
      if (!entry.isFile() || !before.isFile() || before.isSymbolicLink())
        throw new Error("Lokale Amex-Screenshots müssen reguläre Bilddateien sein.");
      assertImportSize(before.size);
      const metadata = fingerprint(before);
      const cached = cache.get(filePath);
      if (cached?.metadata === metadata) {
        if (cached.recovery) recoveries.push(cached.recovery);
        continue;
      }
      cache.delete(filePath);
      const bytes = await readFile(filePath);
      assertImportSize(bytes.byteLength);
      if (!isImage(bytes)) throw new Error("Ungültiges lokales Screenshot-Bild.");
      worker ??= await createLocalWorker();
      const result = parseAmexScreenshotLines(await recognizeAmexScreenshot(worker, bytes), entry.name);
      if (fingerprint(await lstat(filePath)) !== metadata)
        throw new Error("Der lokale Amex-Screenshot wurde während der Erkennung geändert. Bitte erneut versuchen.");
      if (result.source !== "Amex")
        throw new Error("Der lokale Screenshot wurde nicht eindeutig als Amex erkannt.");
      const snapshot = result.amexBalanceSnapshots?.[0];
      if (!snapshot && result.issues.some((issue) => issue.message.includes("Amex-Saldo")))
        throw new Error("Der lokale Amex-Saldo ist nicht eindeutig lesbar.");
      let recovery: AmexBalanceRecovery | null = null;
      if (snapshot) {
        const bookingKeys = [...new Set(result.rows.map(amexBookingKey).filter((key) => key !== null))];
        if (bookingKeys.length < 2)
          throw new Error("Für den lokalen Amex-Saldo fehlen mindestens zwei eindeutig lesbare Buchungen.");
        recovery = { snapshot, bookingKeys };
        recoveries.push(recovery);
      }
      // A valid scroll image without a header total supplies no balance evidence.
      updates.set(filePath, { metadata, recovery });
    }
  } finally {
    await worker?.terminate();
  }
  for (const [filePath, entry] of updates) cache.set(filePath, entry);
  return recoveries;
}

export function readLocalAmexBalanceRecovery(): Promise<AmexBalanceRecovery[]> {
  if (pending) return pending;
  pending = recover().finally(() => { pending = undefined; });
  return pending;
}
