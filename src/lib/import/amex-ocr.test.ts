import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { GET } from "@/app/api/ocr/[asset]/route";
import nextConfig from "../../../next.config";
import { parseStatementFile } from "./statements";
import { localOcrLanguages, localOcrOptions, recognizeAmexScreenshot } from "./amex-ocr";
import { parseAmexScreenshotLines, type ScreenshotLine } from "./amex-screenshot";
import type { Worker } from "tesseract.js";

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(), recognize: vi.fn(), terminate: vi.fn(), setParameters: vi.fn(), reinitialize: vi.fn(),
}));
vi.mock("tesseract.js", () => ({ createWorker: mocks.createWorker, OEM: { LSTM_ONLY: 1 } }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const imageFile = () => {
  const buffer = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
  return { name: "Amex.png", size: buffer.byteLength, arrayBuffer: async () => buffer };
};
const bitmap = () => {
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 1000, height: 2000, close }));
  return close;
};
const worker = () => {
  mocks.createWorker.mockResolvedValue({ recognize: mocks.recognize, terminate: mocks.terminate, setParameters: mocks.setParameters, reinitialize: mocks.reinitialize });
};
const ocrLine = (text: string, y: number, x = 40, confidence = 95): ScreenshotLine =>
  ({ text, confidence, bbox: { x0: x, x1: x + (x > 400 ? 130 : 280), y0: y, y1: y + 20 } });
const groupedHeader = [ocrLine("American Express® Platinum Card", 40), ocrLine("••••61002", 70)];
const isolatedWorker = (recognize: ReturnType<typeof vi.fn>) => ({
  recognize, setParameters: vi.fn(), reinitialize: vi.fn(),
}) as unknown as Worker;

describe("grouped screenshot OCR retries", () => {
  it("independently confirms the large balance font without substituting due payments", async () => {
    const lines = [...groupedHeader, ocrLine("Gesamtsaldo", 120), ocrLine("€ 1.439,69", 150, 40, 77),
      ocrLine("Fällige Zahlung", 200), ocrLine("5 Okt", 270), ocrLine("SPAR", 330), ocrLine("€ 6,56", 330, 500)];
    const recognize = vi.fn().mockResolvedValueOnce({ data: { blocks: [{ paragraphs: [{ lines }] }] } })
      .mockResolvedValueOnce({ data: { text: "€ 1.489,69", confidence: 85 } })
      .mockResolvedValueOnce({ data: { text: "€ 1.489,69", confidence: 91 } })
      .mockResolvedValueOnce({ data: { text: "€ 6,56", confidence: 95 } });
    const worker = isolatedWorker(recognize);
    const result = parseAmexScreenshotLines(await recognizeAmexScreenshot(worker, "local-image"), "2026-10-06.png");
    expect(result.amexScreenshot?.balance).toBe(1489.69);
    expect(result.rows[0].amount).toBe(-6.56);
    expect(worker.reinitialize).toHaveBeenCalledWith("eng");
    expect(worker.reinitialize).toHaveBeenLastCalledWith("deu");
  });
  it("rejects disagreements between independent grouped balance confirmations", async () => {
    const lines = [...groupedHeader, ocrLine("Gesamtsaldo", 120), ocrLine("€ 1.489,69", 150),
      ocrLine("Fällige Zahlung", 200)];
    const recognize = vi.fn().mockResolvedValueOnce({ data: { blocks: [{ paragraphs: [{ lines }] }] } })
      .mockResolvedValueOnce({ data: { text: "€ 1.489,69", confidence: 95 } })
      .mockResolvedValueOnce({ data: { text: "€ 1.439,69", confidence: 95 } });
    const result = parseAmexScreenshotLines(await recognizeAmexScreenshot(isolatedWorker(recognize), "local-image"));
    expect(result.amexScreenshot?.balance).toBeUndefined();
    expect(result.issues[0].message).toContain("Amex-Saldo");
  });
  it("accepts an independently confirmed yearless date even when decorative text lowers confidence", async () => {
    const lines = [...groupedHeader, ocrLine("1Okt", 120, 40, 27), ocrLine("SPAR", 180), ocrLine("€ 6,56", 180, 500)];
    const recognize = vi.fn().mockResolvedValueOnce({ data: { blocks: [{ paragraphs: [{ lines }] }] } })
      .mockResolvedValueOnce({ data: { text: "1 Okt", confidence: 52 } })
      .mockResolvedValueOnce({ data: { text: "€ 6,56", confidence: 95 } });
    const result = parseAmexScreenshotLines(await recognizeAmexScreenshot(isolatedWorker(recognize), "local-image"), "2026-10-06.png");
    expect(result.rows[0]).toMatchObject({ date: "2026-10-01", amount: -6.56 });
    expect(result.issues).toEqual([]);
  });
  it("retries a yearless date whose day was initially read as a letter", async () => {
    const lines = [...groupedHeader, ocrLine("S Okt", 120, 40, 20), ocrLine("SPAR", 180), ocrLine("€ 6,56", 180, 500)];
    const recognize = vi.fn().mockResolvedValueOnce({ data: { blocks: [{ paragraphs: [{ lines }] }] } })
      .mockResolvedValueOnce({ data: { text: "5 Okt", confidence: 92 } })
      .mockResolvedValueOnce({ data: { text: "€ 6,56", confidence: 95 } });
    const result = parseAmexScreenshotLines(await recognizeAmexScreenshot(isolatedWorker(recognize), "local-image"), "2026-10-06.png");
    expect(result.rows[0]).toMatchObject({ date: "2026-10-05", amount: -6.56 });
    expect(result.issues).toEqual([]);
  });
  it("splits merged merchant/amount lines using word geometry and ignores navigation chevrons", async () => {
    const merchant = ocrLine("SPAR", 180);
    const amount = ocrLine("€ 6,56", 180, 500);
    const combined = { ...ocrLine("SPAR € 6,56", 180), words: [merchant, { ...amount, text: "€" },
      { ...amount, text: "6,56", bbox: { ...amount.bbox, x0: 530 } }] };
    const lines = [...groupedHeader, ocrLine("5 Okt", 120), combined, ocrLine("\\", 180, 640),
      ocrLine("Startseite", 700), ocrLine("Konto", 700, 500)];
    const recognize = vi.fn().mockResolvedValueOnce({ data: { blocks: [{ paragraphs: [{ lines }] }] } })
      .mockResolvedValueOnce({ data: { text: "€ 6,56", confidence: 95 } });
    const recognized = await recognizeAmexScreenshot(isolatedWorker(recognize), "local-image");
    expect(recognized.find((line) => line.text === "SPAR")?.bbox).toEqual(merchant.bbox);
    const result = parseAmexScreenshotLines(recognized, "2026-10-06.png");
    expect(result.rows[0]).toMatchObject({ description: "SPAR", amount: -6.56 });
    expect(result.issues).toEqual([]);
    expect(recognize).toHaveBeenCalledTimes(2);
  });
});
describe("browser screenshot entry point", () => {
  it("recognizes a local Blob using only same-origin resources and releases the worker", async () => {
    const close = bitmap(); worker();
    mocks.recognize.mockResolvedValue({ data: { blocks: [] } });
    const result = await parseStatementFile(imageFile());
    expect(result.source).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.createWorker).toHaveBeenCalledWith(localOcrLanguages, 1, localOcrOptions);
    expect(mocks.recognize.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });
  it("releases the worker after a recognition failure", async () => {
    bitmap(); worker();
    mocks.recognize.mockRejectedValueOnce(new Error("Unreadable pixels"));
    await expect(parseStatementFile(imageFile())).rejects.toThrow("Unreadable pixels");
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });
  it("rejects oversized decoded images before starting OCR", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 8000, height: 8000, close }));
    await expect(parseStatementFile(imageFile())).rejects.toThrow("24 Megapixel");
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });
});
describe("local OCR resource route", () => {
  it.each([
    ["worker.min.js", "text/javascript"],
    ["tesseract-core-lstm.wasm.js", "text/javascript"],
    ["tesseract-core-simd-lstm.wasm.js", "text/javascript"],
    ["tesseract-core-relaxedsimd-lstm.wasm.js", "text/javascript"],
    ["tesseract-core-lstm.wasm", "application/wasm"],
    ["tesseract-core-simd-lstm.wasm", "application/wasm"],
    ["tesseract-core-relaxedsimd-lstm.wasm", "application/wasm"],
    ["deu.traineddata.gz", "application/gzip"],
    ["eng.traineddata.gz", "application/gzip"],
  ])("serves installed %s without a CDN redirect", async (asset, contentType) => {
    const response = await GET(new Request(`http://localhost/api/ocr/${asset}`), { params: Promise.resolve({ asset }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(contentType);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });
  it.each(["../package.json", "..\\package.json", "%2e%2e", "fra.traineddata.gz", "__proto__"])("rejects nonallowlisted path %s", async (asset) => {
    const response = await GET(new Request("http://localhost/api/ocr/test"), { params: Promise.resolve({ asset }) });
    expect(response.status).toBe(404);
  });
  it("explicitly traces every dynamically served OCR resource, without private or unrelated files", () => {
    const includes = nextConfig.outputFileTracingIncludes;
    expect(Object.keys(includes ?? {})).toEqual(["/api/ocr/*", "/api/amex-balance-recovery"]);
    const files = includes?.["/api/ocr/*"] ?? [];
    expect(files).toHaveLength(9);
    expect(files.every((file) => file.startsWith("./node_modules/") && existsSync(file))).toBe(true);
    expect(files).toContain("./node_modules/tesseract.js/dist/worker.min.js");
    for (const variant of ["", "-simd", "-relaxedsimd"])
      for (const extension of [".wasm", ".wasm.js"])
        expect(files).toContain(`./node_modules/tesseract.js-core/tesseract-core${variant}-lstm${extension}`);
    for (const language of ["deu", "eng"])
      expect(files).toContain(`./node_modules/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`);
    const recoveryFiles = includes?.["/api/amex-balance-recovery"] ?? [];
    expect(recoveryFiles.every((file) => file.startsWith("./node_modules/"))).toBe(true);
    expect(recoveryFiles).toContain("./node_modules/tesseract.js/src/worker-script/**/*");
    expect(recoveryFiles).toContain("./node_modules/tesseract.js-core/**/*");
    for (const language of ["deu", "eng"])
      expect(recoveryFiles).toContain(`./node_modules/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`);
    expect(nextConfig.serverExternalPackages).toContain("tesseract.js");
  });
});
