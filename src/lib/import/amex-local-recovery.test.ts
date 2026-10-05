import path from "node:path";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Worker } from "tesseract.js";
import { MAX_IMPORT_BYTES } from "./limits";
import type { ScreenshotLine } from "./amex-screenshot";
import { amexBookingKey } from "./identity";
import { parseAmexScreenshotLines } from "./amex-screenshot";

const mocks = vi.hoisted(() => ({
  lstat: vi.fn(), readdir: vi.fn(), readFile: vi.fn(),
  createWorker: vi.fn(), recognize: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  lstat: mocks.lstat, readdir: mocks.readdir, readFile: mocks.readFile,
}));
vi.mock("tesseract.js", () => ({ createWorker: mocks.createWorker, OEM: { LSTM_ONLY: 1 } }));
vi.mock("./amex-ocr", () => ({ recognizeAmexScreenshot: mocks.recognize }));

const directory = path.join(process.cwd(), "import-example");
const filename = "WhatsApp Image 2026-10-05 at 09.43.39.jpeg";
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0, 1]);
const model = gzipSync(Buffer.from("mock installed model"));
const line = (text: string, y: number, x = 40): ScreenshotLine =>
  ({ text, confidence: 95, bbox: { x0: x, x1: x + (x > 400 ? 130 : 280), y0: y, y1: y + 20 } });
const booking = (description: string, y: number) =>
  [line(description, y), line("4 Okt 2026", y + 30), line("€ 12,34", y + 15, 500)];
const screenshot = () => [
  line("11.09.2026 - Aktuell", 50), line("Kartennummer -12345", 80),
  line("€ 1.619,19", 150), line("45 Transaktionen", 180),
  ...booking("SPAR", 280), ...booking("BILLA", 390),
];
const entry = (name = filename, regular = true) => ({ name, isFile: () => regular });
const metadata = (overrides = {}) => ({
  dev: 1, ino: 2, size: bytes.length, mtimeMs: 1, ctimeMs: 1,
  isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
  ...overrides,
});
let readLocalAmexBalanceRecovery: typeof import("./amex-local-recovery").readLocalAmexBalanceRecovery;
let workers: { language: string; reinitialize: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }[];

beforeEach(async () => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset();
  workers = [];
  mocks.lstat.mockImplementation(async (target: string) =>
    target === directory ? metadata({ isDirectory: () => true, isFile: () => false }) : metadata());
  mocks.readdir.mockResolvedValue([entry()]);
  mocks.readFile.mockImplementation(async (target: string) => target.endsWith(".traineddata.gz") ? model : bytes);
  mocks.createWorker.mockImplementation(async (language: string) => {
    const worker = {
      language, reinitialize: vi.fn().mockResolvedValue({}), terminate: vi.fn().mockResolvedValue({}),
      setParameters: vi.fn(), recognize: vi.fn(),
    };
    workers.push(worker);
    return worker;
  });
  mocks.recognize.mockImplementation(async (worker: Worker) => {
    await worker.reinitialize("deu");
    await worker.reinitialize("eng");
    await worker.reinitialize("deu");
    return screenshot();
  });
  ({ readLocalAmexBalanceRecovery } = await import("./amex-local-recovery"));
});

describe("local-only Amex header recovery", () => {
  it("returns only parser header snapshots and unique valid booking evidence", async () => {
    const recoveries = await readLocalAmexBalanceRecovery();
    const parsed = parseAmexScreenshotLines(screenshot(), filename);
    expect(recoveries).toEqual([{
      snapshot: { periodStart: "2026-09-11", date: "2026-10-05", balance: 1619.19 },
      bookingKeys: parsed.rows.map(amexBookingKey),
    }]);
    expect(Object.keys(recoveries[0]).sort()).toEqual(["bookingKeys", "snapshot"]);
    expect(recoveries[0].snapshot.balance).not.toBe(24.68);
    expect(mocks.readdir).toHaveBeenCalledWith(directory, { withFileTypes: true });
    expect(mocks.readFile).toHaveBeenCalledWith(path.join(directory, filename));
    expect(mocks.recognize.mock.calls[0][1]).toBe(bytes);
    expect(mocks.createWorker.mock.calls).toEqual(["deu", "eng"].map((language) => [
      language, 1, {
        langPath: path.join(process.cwd(), "node_modules", "@tesseract.js-data", language, "4.0.0_best_int"),
        cacheMethod: "none", errorHandler: expect.any(Function),
      },
    ]));
    expect(workers[0].reinitialize.mock.calls.map(([language]) => language)).toEqual(["deu", "deu"]);
    expect(workers[1].reinitialize.mock.calls.map(([language]) => language)).toEqual(["eng"]);
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("treats a missing optional directory as empty, without persisting that absence", async () => {
    mocks.lstat.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    expect(await readLocalAmexBalanceRecovery()).toEqual([]);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(await readLocalAmexBalanceRecovery()).toHaveLength(1);
  });

  it.each(["EACCES", "EIO"])("does not hide directory %s failures", async (code) => {
    const error = Object.assign(new Error(code), { code });
    mocks.lstat.mockRejectedValueOnce(error);
    await expect(readLocalAmexBalanceRecovery()).rejects.toBe(error);
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("does not turn a failed directory listing into an empty success", async () => {
    mocks.readdir.mockRejectedValueOnce(Object.assign(new Error("listing failed"), { code: "EACCES" }));
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("listing failed");
  });

  it("ignores unrelated, undated, unsupported and path-like names", async () => {
    mocks.readdir.mockResolvedValue([
      entry("bank.jpeg"), entry("WhatsApp Image at 09.43.39.jpeg"), entry("WhatsApp Image 2026-10-05 at 09.43.39.pdf"),
      entry(`..\\${filename}`), entry("Downloads"), entry(filename),
    ]);
    expect(await readLocalAmexBalanceRecovery()).toHaveLength(1);
    expect(mocks.readFile.mock.calls.filter(([target]) => !target.endsWith(".traineddata.gz"))).toHaveLength(1);
    expect(mocks.readFile).toHaveBeenCalledWith(path.join(directory, filename));
  });

  it.each(["png", "webp", "jpg", "JPEG"])("accepts fixed dated WhatsApp %s names", async (extension) => {
    mocks.readdir.mockResolvedValue([entry(filename.replace("jpeg", extension))]);
    expect(await readLocalAmexBalanceRecovery()).toHaveLength(1);
  });

  it("bounds the candidate count before OCR or image reads", async () => {
    mocks.readdir.mockResolvedValue(Array.from({ length: 21 }, (_, index) =>
      entry(filename.replace(".jpeg", ` (${index}).jpeg`))));
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("höchstens 20");
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("never substitutes today's date for an invalid capture date", async () => {
    mocks.readdir.mockResolvedValue([entry(filename.replace("2026-10-05", "2026-02-30"))]);
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("Aufnahmedatum");
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("rejects linked directories and nonregular matching files", async () => {
    mocks.lstat.mockResolvedValueOnce(metadata({ isDirectory: () => true, isSymbolicLink: () => true }));
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("regulärer Ordner");
    mocks.readdir.mockResolvedValue([entry(filename, false)]);
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("reguläre Bilddateien");
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("enforces the import-size limit both before and after reading bytes", async () => {
    mocks.lstat.mockImplementation(async (target: string) =>
      target === directory ? metadata({ isDirectory: () => true }) : metadata({ size: MAX_IMPORT_BYTES + 1 }));
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("20 MB");
    expect(mocks.readFile).not.toHaveBeenCalled();
    mocks.lstat.mockImplementation(async (target: string) =>
      target === directory ? metadata({ isDirectory: () => true }) : metadata());
    mocks.readFile.mockResolvedValueOnce(Buffer.alloc(MAX_IMPORT_BYTES + 1));
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("20 MB");
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("rejects invalid image bytes before creating OCR workers", async () => {
    mocks.readFile.mockResolvedValueOnce(Buffer.from("private nonimage text"));
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("Ungültiges");
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("keeps file-read errors explicit and retries them later", async () => {
    const error = Object.assign(new Error("private read error"), { code: "ENOENT" });
    mocks.readFile.mockRejectedValueOnce(error);
    await expect(readLocalAmexBalanceRecovery()).rejects.toBe(error);
    expect(await readLocalAmexBalanceRecovery()).toHaveLength(1);
    expect(mocks.readFile.mock.calls.filter(([target]) => !target.endsWith(".traineddata.gz"))).toHaveLength(2);
  });

  it("does not fabricate a header total for valid scroll images", async () => {
    mocks.recognize.mockResolvedValue(screenshot().filter((item) => item.text !== "€ 1.619,19"));
    expect(await readLocalAmexBalanceRecovery()).toEqual([]);
    expect(await readLocalAmexBalanceRecovery()).toEqual([]);
    expect(mocks.recognize).toHaveBeenCalledTimes(1);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { text: "€ 161919", confidence: 95 },
    { text: "€ 1.619,19", confidence: 20 },
    { text: "€ 1.619,19", confidence: 95, uncertain: true },
  ])("reports unsafe header OCR explicitly: %j", async (header) => {
    mocks.recognize.mockResolvedValueOnce(screenshot().map((item) =>
      item.text === "€ 1.619,19" ? { ...item, ...header } : item));
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("nicht eindeutig lesbar");
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(await readLocalAmexBalanceRecovery()).toHaveLength(1);
    expect(mocks.recognize).toHaveBeenCalledTimes(2);
  });

  it("rejects non-Amex images and headers with ambiguous totals", async () => {
    mocks.recognize.mockResolvedValueOnce(booking("SPAR", 280));
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("nicht eindeutig als Amex");
    mocks.recognize.mockResolvedValueOnce([...screenshot(), line("€ 20,00", 120)]);
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("nicht eindeutig lesbar");
  });

  it("requires two unique valid rows, not two copies or invalid OCR drafts", async () => {
    const sameBooking = [...screenshot().slice(0, 4), ...booking("SPAR", 280), ...booking("SPAR", 390)];
    mocks.recognize.mockResolvedValueOnce(sameBooking);
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("zwei eindeutig lesbare");
    mocks.recognize.mockResolvedValueOnce(screenshot().map((item) =>
      item.text === "BILLA" ? { ...item, confidence: 10 } : item));
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("zwei eindeutig lesbare");
  });

  it("never caches OCR failures and always terminates acquired workers", async () => {
    mocks.recognize.mockRejectedValueOnce(new Error("OCR failed"));
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("OCR failed");
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(await readLocalAmexBalanceRecovery()).toHaveLength(1);
    expect(mocks.recognize).toHaveBeenCalledTimes(2);
    expect(workers[1].terminate).toHaveBeenCalledTimes(1);
    expect(workers[2].terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates the first worker when the local English worker cannot be loaded", async () => {
    mocks.createWorker.mockImplementationOnce(async () => {
      const worker = { language: "deu", reinitialize: vi.fn().mockResolvedValue({}), terminate: vi.fn().mockResolvedValue({}) };
      workers.push(worker);
      return worker;
    }).mockRejectedValueOnce(new Error("missing installed English model"));
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("missing installed English model");
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it("fails missing installed models before spawning a worker", async () => {
    mocks.readFile.mockImplementation(async (target: string) => {
      if (target.endsWith(".traineddata.gz")) throw Object.assign(new Error("missing model"), { code: "ENOENT" });
      return bytes;
    });
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("missing model");
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("rejects worker initialization errors instead of leaving recovery pending", async () => {
    mocks.createWorker.mockImplementationOnce((_language, _oem, options) => {
      options.errorHandler(new Error("local worker initialization failed"));
      return new Promise(() => {});
    });
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("local worker initialization failed");
    expect(await readLocalAmexBalanceRecovery()).toHaveLength(1);
  });

  it("does not cache a scan that failed to terminate its acquired worker", async () => {
    mocks.recognize.mockImplementationOnce(async (worker: Worker) => {
      workers[0].terminate.mockRejectedValueOnce(new Error("termination failed"));
      await worker.reinitialize("deu");
      return screenshot();
    });
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("termination failed");
    expect(await readLocalAmexBalanceRecovery()).toHaveLength(1);
    expect(mocks.recognize).toHaveBeenCalledTimes(2);
  });

  it("reuses successful unchanged OCR and invalidates changed file metadata", async () => {
    const first = await readLocalAmexBalanceRecovery();
    expect(await readLocalAmexBalanceRecovery()).toEqual(first);
    expect(mocks.recognize).toHaveBeenCalledTimes(1);
    mocks.lstat.mockImplementation(async (target: string) =>
      target === directory ? metadata({ isDirectory: () => true }) : metadata({ mtimeMs: 2 }));
    await readLocalAmexBalanceRecovery();
    expect(mocks.recognize).toHaveBeenCalledTimes(2);
  });

  it("rejects files changed during OCR instead of caching their stale balance", async () => {
    mocks.recognize.mockImplementationOnce(async () => {
      mocks.lstat.mockImplementation(async (target: string) =>
        target === directory ? metadata({ isDirectory: () => true }) : metadata({ ctimeMs: 2 }));
      return screenshot();
    });
    await expect(readLocalAmexBalanceRecovery()).rejects.toThrow("während der Erkennung geändert");
    expect(await readLocalAmexBalanceRecovery()).toHaveLength(1);
    expect(mocks.recognize).toHaveBeenCalledTimes(2);
  });

  it("shares a pending scan across concurrent callers and releases it afterwards", async () => {
    let resolve!: (lines: ScreenshotLine[]) => void;
    mocks.recognize.mockReturnValueOnce(new Promise<ScreenshotLine[]>((finish) => { resolve = finish; }));
    const first = readLocalAmexBalanceRecovery();
    const second = readLocalAmexBalanceRecovery();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(mocks.recognize).toHaveBeenCalledTimes(1));
    resolve(screenshot());
    expect(await second).toEqual(await first);
    expect(mocks.readdir).toHaveBeenCalledTimes(1);
    await readLocalAmexBalanceRecovery();
    expect(mocks.readdir).toHaveBeenCalledTimes(2);
    expect(mocks.recognize).toHaveBeenCalledTimes(1);
  });

  it("prunes removed files from the process cache", async () => {
    await readLocalAmexBalanceRecovery();
    mocks.readdir.mockResolvedValueOnce([]);
    expect(await readLocalAmexBalanceRecovery()).toEqual([]);
    await readLocalAmexBalanceRecovery();
    expect(mocks.recognize).toHaveBeenCalledTimes(2);
  });
});
