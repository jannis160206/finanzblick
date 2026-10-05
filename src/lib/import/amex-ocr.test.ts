import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { GET } from "@/app/api/ocr/[asset]/route";
import nextConfig from "../../../next.config";
import { parseStatementFile } from "./statements";
import { localOcrLanguages, localOcrOptions } from "./amex-ocr";

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
